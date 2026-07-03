package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"

	einomodel "github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"

	"omnikube/internal/cluster"
	dbmodel "omnikube/internal/model"
)

// Event 是流式对话过程中回传给上层（WebSocket）的一帧事件。
//   - token：模型输出的一段文本增量。
//   - tool_call：模型发起的一次工具调用（Tool=工具名，Args=JSON 入参）。
//   - tool_result：工具返回结果（Result=JSON 结果）。
//   - done：本轮回答结束（Text=完整回答文本，便于上层一次性落库/展示）。
//   - error：运行出错（Text=错误信息）。
type Event struct {
	Type   string `json:"type"`
	Text   string `json:"text,omitempty"`
	Tool   string `json:"tool,omitempty"`
	Args   string `json:"args,omitempty"`
	Result string `json:"result,omitempty"`
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

// Runner 串起「加载历史 → 装配 model/tools/agent → 流式跑 → 回传事件 → 落库」的整条链路。
type Runner struct {
	store *Store
	convs *ConvStore
	pool  *cluster.ClusterPool
	guard *Guard

	// 以下两处为测试接缝：默认走真实实现，单测可覆盖以摆脱网络依赖。
	buildModel func(ctx context.Context, cfg Config) (einomodel.ToolCallingChatModel, error)
	newAgent   agentBuilder
}

// NewRunner 装配 Runner，接缝默认指向真实的 BuildChatModel / defaultAgentBuilder。
func NewRunner(store *Store, convs *ConvStore, pool *cluster.ClusterPool, guard *Guard) *Runner {
	return &Runner{
		store:      store,
		convs:      convs,
		pool:       pool,
		guard:      guard,
		buildModel: BuildChatModel,
		newAgent:   defaultAgentBuilder,
	}
}

// Stream 跑一轮流式对话：
//  1. 解析 convID，加载历史消息并转成 eino 消息序列，追加本轮用户输入；
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
	tools := ReadTools(r.pool, clusterID, r.guard, userID)
	run, err := r.newAgent(ctx, cm, tools, cfg.SystemPrompt, cfg.MaxSteps)
	if err != nil {
		return err
	}

	sr, err := run(ctx, msgs)
	if err != nil {
		return err
	}
	defer sr.Close()

	// 4. 消费流。
	var full strings.Builder
	var toolCalls []schema.ToolCall
	for {
		chunk, err := sr.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if chunk == nil {
			continue
		}
		switch chunk.Role {
		case schema.Tool:
			// 工具结果消息（部分模型/agent 会把中间步骤混入流）。
			emit(Event{Type: "tool_result", Tool: chunk.ToolName, Result: chunk.Content})
		default:
			if chunk.Content != "" {
				full.WriteString(chunk.Content)
				emit(Event{Type: "token", Text: chunk.Content})
			}
			for _, tc := range chunk.ToolCalls {
				toolCalls = append(toolCalls, tc)
				emit(Event{Type: "tool_call", Tool: tc.Function.Name, Args: tc.Function.Arguments})
			}
		}
	}

	// 5. done + 助手消息落库（含工具调用轨迹 JSON，便于前端还原 tool-step trace）。
	answer := full.String()
	emit(Event{Type: "done", Text: answer})

	var toolCallsJSON string
	if len(toolCalls) > 0 {
		if raw, err := json.Marshal(toolCalls); err == nil {
			toolCallsJSON = string(raw)
		}
	}
	return r.convs.AppendMessage(uint(cid), "assistant", answer, toolCallsJSON)
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
