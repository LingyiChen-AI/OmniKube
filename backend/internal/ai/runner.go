package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	einomodel "github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"

	"omnikube/internal/cluster"
	dbmodel "omnikube/internal/model"
)

// namingConventionRule 是追加到系统提示词末尾的固定命名规范：创建资源时统一以
// 「业务名 + 类型后缀」命名，使同一应用的各类资源可读且成组。用户显式指定名称时以用户为准。
const namingConventionRule = `创建资源的命名规范（除非用户明确给出了名称，否则严格遵守）：一律用「业务名-类型后缀」命名，
使同一应用的各类资源可读且成组，例如为 nginx 创建部署与服务应命名为 nginx-deploy、nginx-service：
- Deployment→<名>-deploy；StatefulSet→<名>-sts；DaemonSet→<名>-ds
- Service→<名>-service；Ingress→<名>-ingress
- ConfigMap→<名>-config；Secret→<名>-secret
- Job→<名>-job；CronJob→<名>-cronjob；PersistentVolumeClaim→<名>-pvc
注意：Service 的 selector 必须匹配对应 Deployment 的 Pod 标签（labels），不要用资源名去匹配。`

// ErrConversationNotFound 表示 conversation_id 不存在或不属于当前用户。
// 刻意不区分「不存在」与「他人所有」两种情形——对外统一同一语义，避免泄露会话存在性
// （与 REST GetConversation 的 403 处理口径一致）。
var ErrConversationNotFound = errors.New("会话不存在或无权访问")

// Event 是流式对话过程中回传给上层（WebSocket）的一帧事件。
//   - token：模型输出的一段文本增量。
//   - tool_call：模型发起的一次工具调用（Tool=工具名，Args=JSON 入参）。
//   - tool_result：工具返回结果（Result=JSON 结果）。
//   - done：本轮回答结束（Text=完整回答文本，便于上层一次性落库/展示）。
//   - error：运行出错（Text=错误信息）。
// confirm_required：本轮暂存了写操作，需用户确认（Actions=暂存动作预览，Text=助手正文）。
type Event struct {
	Type    string         `json:"type"`
	Text    string         `json:"text,omitempty"`
	Tool    string         `json:"tool,omitempty"`
	Args    string         `json:"args,omitempty"`
	Result  string         `json:"result,omitempty"`
	Actions []StagedAction `json:"actions,omitempty"`
}

// streamFn 抽象「给定输入消息，返回流式消息读取器」；*react.Agent 的 Stream 天然契合。
type streamFn func(ctx context.Context, msgs []*schema.Message) (*schema.StreamReader[*schema.Message], error)

// agentBuilder 是「装配 agent 并暴露其 Stream 能力」的可注入接缝；默认走真实 ReAct agent，
// 测试可覆盖它以返回一个投喂 canned StreamReader 的 streamFn，从而无需网络即可驱动 Runner。
type agentBuilder func(ctx context.Context, cm einomodel.ToolCallingChatModel, tools []tool.BaseTool, systemPrompt string, maxStep int) (streamFn, error)

// defaultAgentBuilder 用 BuildAgent 装配真实 ReAct agent，并把其 Stream 方法包装成 streamFn。
func defaultAgentBuilder(ctx context.Context, cm einomodel.ToolCallingChatModel, tools []tool.BaseTool, systemPrompt string, maxStep int) (streamFn, error) {
	ag, err := BuildAgent(ctx, cm, tools, systemPrompt, maxStep)
	if err != nil {
		return nil, err
	}
	return func(ctx context.Context, msgs []*schema.Message) (*schema.StreamReader[*schema.Message], error) {
		return ag.Stream(ctx, msgs)
	}, nil
}

// executorIface 抽象「应用一个已确认的写操作」，便于单测注入 fake executor。
type executorIface interface {
	Apply(ctx context.Context, userID uint, username, clusterID string, a StagedAction) error
}

// Runner 串起「加载历史 → 装配 model/tools/agent → 流式跑 → 回传事件 → 落库」的整条链路。
type Runner struct {
	store *Store
	convs *ConvStore
	pool  *cluster.ClusterPool
	guard *Guard
	exec  executorIface

	// 以下两处为测试接缝：默认走真实实现，单测可覆盖以摆脱网络依赖。
	buildModel func(ctx context.Context, cfg Config) (einomodel.ToolCallingChatModel, error)
	newAgent   agentBuilder
}

// NewRunner 装配 Runner，接缝默认指向真实的 BuildChatModel / defaultAgentBuilder；
// exec 默认走真实 Executor（复用 convs 的 db 落审计）。
func NewRunner(store *Store, convs *ConvStore, pool *cluster.ClusterPool, guard *Guard) *Runner {
	return &Runner{
		store:      store,
		convs:      convs,
		pool:       pool,
		guard:      guard,
		exec:       NewExecutor(pool, guard, convs.db),
		buildModel: BuildChatModel,
		newAgent:   defaultAgentBuilder,
	}
}

// Stream 跑一轮流式对话：
//  0. 解析 convID 并强制归属校验：会话必须存在且属于 userID，否则直接返回
//     ErrConversationNotFound——不读历史、不落库、不跑 agent（防止越权读他人历史/写他人会话）；
//  1. 加载历史消息并转成 eino 消息序列，追加本轮用户输入；
//  2. 先把用户消息落库（即便后续出错也保留提问轨迹）；
//  3. 加载 AI 配置，装配 model + 只读工具 + agent，流式运行；
//  4. 消费 StreamReader：文本增量发 token、工具调用发 tool_call、工具消息发 tool_result；
//  5. 结束后发 done（携带完整文本），并把助手消息（含工具调用轨迹 JSON）落库。
//
// 任一步出错都直接返回 error，由上层转成 error 帧；已落库的用户消息不回滚。
func (r *Runner) Stream(ctx context.Context, userID uint, clusterID, convID string, userText string, emit func(Event)) error {
	cid, err := strconv.ParseUint(strings.TrimSpace(convID), 10, 64)
	if err != nil || cid == 0 {
		return errors.New("无效的 conversation_id")
	}

	// 0. 归属校验（防越权）：会话必须存在且属于当前用户，否则一律 ErrConversationNotFound。
	//    这一步必须先于任何历史读取/落库/agent 运行，任何调用方（含 WS）由此统一受保护。
	conv, err := r.convs.Get(uint(cid))
	if err != nil || conv.UserID != userID {
		return ErrConversationNotFound
	}

	// 1. 历史 → eino 消息序列 + 本轮用户输入。
	history, err := r.convs.Messages(uint(cid))
	if err != nil {
		return err
	}
	msgs := toSchemaMessages(history)
	msgs = append(msgs, schema.UserMessage(userText))

	// 2. 用户消息先落库。
	if err := r.convs.AppendMessage(uint(cid), "user", userText, ""); err != nil {
		return err
	}

	// 3. 加载配置并装配 model + tools + agent。
	cfg, err := r.store.LoadConfig()
	if err != nil {
		return err
	}
	cm, err := r.buildModel(ctx, cfg)
	if err != nil {
		return err
	}
	// 读工具 + 写工具（写工具共享本轮新建的 stager：只暂存不执行），再包一层 tracedTool：
	// 每次工具调用实时发 tool_call/tool_result 并记入 tracer（供落库回放）。
	stager := &Stager{}
	tracer := &Tracer{}
	events := make(chan Event, 256)
	// 工具在 agent 后台 goroutine 执行，其 emit 与流消费 goroutine 的 emit 并发；
	// 全部经 events channel 汇入主 goroutine 单线程下发，避免并发写 WS。
	toolEmit := func(ev Event) {
		select {
		case events <- ev:
		case <-ctx.Done():
		}
	}
	// 只对读工具包 tracedTool（实时显示「调用/结果」卡片）；写工具只做暂存、不算已执行，
	// 故不追踪、不发工具卡片——写操作一律以「待确认卡片」呈现，确认后才真正执行并出结果，
	// 避免同一写操作被展示两次（暂存卡片 + 确认卡片）。
	tools := append(traceTools(ReadTools(r.pool, clusterID, r.guard, userID), toolEmit, tracer),
		WriteTools(r.pool, clusterID, r.guard, userID, stager)...)
	// 在用户配置的系统提示词之后追加固定的「创建命名规范」，使不论用户提示词如何，
	// 新建资源都统一按 <业务名>-<类型后缀> 命名。
	systemPrompt := strings.TrimSpace(cfg.SystemPrompt + "\n\n" + namingConventionRule)
	run, err := r.newAgent(ctx, cm, tools, systemPrompt, cfg.MaxSteps)
	if err != nil {
		return err
	}

	// 4. 在后台 goroutine 里跑 agent 流并消费：文本增量发 token，工具步骤由 tracedTool
	//    实时发出；两者都汇入 events，由主 goroutine 顺序下发（单一 WS 写者）。收尾时
	//    落库并把结果错误存入 retErr；close(events) 提供 happens-before，主循环随后安全读取。
	var retErr error
	go func() {
		defer close(events)
		sr, err := run(ctx, msgs)
		if err != nil {
			retErr = err
			events <- Event{Type: "error", Text: err.Error()}
			return
		}
		defer sr.Close()

		var full strings.Builder
		for {
			chunk, err := sr.Recv()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				// 流中途出错：把已累计文本（加「…（已中断）」）连同工具轨迹落库，保持
				// 前端已渲染与持久化一致，再发一帧 error 终止。
				answer := full.String()
				if answer != "" {
					answer += "…（已中断）"
				}
				_ = r.convs.AppendMessage(uint(cid), "assistant", answer, marshalTrace(tracer.Steps())) // best-effort 落库
				retErr = err                                                                            // 返回流错误（与旧行为一致）
				events <- Event{Type: "error", Text: err.Error()}
				return
			}
			// 只累计/下发最终答案文本；工具调用与结果由 tracedTool 实时发出。
			if chunk != nil && chunk.Role != schema.Tool && chunk.Content != "" {
				full.WriteString(chunk.Content)
				events <- Event{Type: "token", Text: chunk.Content}
			}
		}

		// 5. 收尾。暂存了写操作 → 发 confirm_required 并把动作作为 pending 落到助手消息上；
		//    否则 done。两者都把工具轨迹（含结果）随消息落库以便重载回放。
		answer := full.String()
		trace := marshalTrace(tracer.Steps())
		if staged := stager.Actions(); len(staged) > 0 {
			events <- Event{Type: "confirm_required", Text: answer, Actions: staged}
			retErr = r.convs.AppendAssistant(uint(cid), answer, trace, marshalActions(staged))
			return
		}
		events <- Event{Type: "done", Text: answer}
		retErr = r.convs.AppendMessage(uint(cid), "assistant", answer, trace)
	}()

	for ev := range events {
		emit(ev)
	}
	return retErr
}

// Confirm 处理用户对上一轮暂存写操作的确认/取消：
//  0. 归属校验（会话须存在且属于 userID，否则 ErrConversationNotFound）——必须先于认领；
//  1. 原子认领（ClaimPending）该会话最近一条待确认动作：读出动作后条件 UPDATE 抢占清空，
//     仅当恰好清空 1 行才算认领成功；认领失败（无 pending 或被并发确认抢先）→ 回一帧 error
//     且不执行任何变更。这一步同时完成「取动作」与「清空 pending」，杜绝并发双确认重复下发；
//  2. approved：逐个经 Executor.Apply（会再次过闸门）执行，每个动作发一帧 tool_result
//     （成功/失败），最后 done；rejected：不执行，发一帧 done 携「已取消」文案。
//     两种情形下 pending 均已在第 1 步被认领清空，无需再单独清空。
func (r *Runner) Confirm(ctx context.Context, userID uint, username, convID string, approved bool, emit func(Event)) error {
	cid, err := strconv.ParseUint(strings.TrimSpace(convID), 10, 64)
	if err != nil || cid == 0 {
		return errors.New("无效的 conversation_id")
	}
	// 0. 归属校验（与 Stream 同口径）。
	conv, err := r.convs.Get(uint(cid))
	if err != nil || conv.UserID != userID {
		return ErrConversationNotFound
	}

	// 1. 原子认领最近一条待确认动作（抢占把 confirm_result 置为 running，杜绝并发双确认）。
	//    认领失败 = 无 pending 或被并发确认抢先 → 回一帧 error 且不执行任何变更。
	msgID, actions, ok := r.convs.ClaimPending(uint(cid))
	if !ok {
		emit(Event{Type: "error", Text: "没有待确认的操作"})
		return nil
	}

	// 2. 取消：把「已取消」结局写回该提案消息（重载据此重建已解决卡片），并实时输出。
	if !approved {
		text := "🚫 已取消，未执行任何变更。"
		emit(Event{Type: "token", Text: text})
		emit(Event{Type: "done", Text: text})
		return r.convs.SetConfirmResult(msgID, "cancelled", text)
	}

	// 3. 确认：逐个执行（clusterID 取自会话），汇总结果为一段文本；实时 token+done 输出，
	//    并把结局写回该提案消息（confirm_result），使重载时确认卡片原样呈现执行结果。
	lines := make([]string, 0, len(actions))
	for _, a := range actions {
		target := a.Resource
		if a.Namespace != "" || a.Name != "" {
			target = fmt.Sprintf("%s %s/%s", a.Resource, a.Namespace, a.Name)
		}
		if err := r.exec.Apply(ctx, userID, username, conv.ClusterID, a); err != nil {
			lines = append(lines, fmt.Sprintf("❌ %s %s 执行失败：%v", a.Action, target, err))
		} else {
			lines = append(lines, fmt.Sprintf("✅ 已执行 %s %s", a.Action, target))
		}
	}
	summary := strings.Join(lines, "\n")
	emit(Event{Type: "token", Text: summary})
	emit(Event{Type: "done", Text: summary})
	return r.convs.SetConfirmResult(msgID, "done", summary)
}

// marshalActions 把暂存动作序列化为 JSON 字符串；空/失败返回空串。
func marshalActions(actions []StagedAction) string {
	if len(actions) == 0 {
		return ""
	}
	if raw, err := json.Marshal(actions); err == nil {
		return string(raw)
	}
	return ""
}

// toSchemaMessages 把持久化的会话历史转成 eino 消息序列（仅取 user/assistant 文本；
// 工具轨迹不回灌，以免污染上下文与重复计费）。
func toSchemaMessages(history []dbmodel.AIMessage) []*schema.Message {
	out := make([]*schema.Message, 0, len(history))
	for i := range history {
		m := &history[i]
		switch m.Role {
		case "user":
			out = append(out, schema.UserMessage(m.Content))
		case "assistant":
			out = append(out, schema.AssistantMessage(m.Content, nil))
		}
	}
	return out
}
