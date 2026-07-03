package ai

import (
	"context"
	"errors"
	"strconv"
	"testing"

	einomodel "github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
)

// fakeExecutor 记录 Apply 调用，供确认路径断言（可注入返回错误）。
type fakeExecutor struct {
	calls []StagedAction
	err   error
}

func (f *fakeExecutor) Apply(ctx context.Context, userID uint, username, clusterID string, a StagedAction) error {
	f.calls = append(f.calls, a)
	return f.err
}

// stageManifest 是一个 create_resource 的合法入参（dev/nginx）。
const stageManifest = `{"resource":"deployments","namespace":"dev","manifest":{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"nginx","namespace":"dev"}}}`

// TestRunnerStreamStagesAndRequiresConfirm 暂存写操作的一轮：newAgent 接缝模拟 react
// agent 调用 create_resource 工具（触发 stage），Runner 应发 confirm_required（不发 done）、
// 把 pending_action 落到助手消息，且不执行任何写（fake executor 零调用）。
func TestRunnerStreamStagesAndRequiresConfirm(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	store := NewStore(db, cipher)
	if err := store.SaveConfig(ConfigInput{Enabled: true, BaseURL: "https://x/v1", APIKey: "k", ModelID: "m", SystemPrompt: "你是 K8s 助手"}); err != nil {
		t.Fatal(err)
	}
	convs := NewConvStore(db)
	pool := fakeToolsCluster(t)
	guard := writeGuardDB(t, db, true)

	r := NewRunner(store, convs, pool, guard)
	fexec := &fakeExecutor{}
	r.exec = fexec
	r.buildModel = func(ctx context.Context, cfg Config) (einomodel.ToolCallingChatModel, error) { return nil, nil }
	r.newAgent = func(ctx context.Context, cm einomodel.ToolCallingChatModel, tools []tool.BaseTool, systemPrompt string, maxStep int) (streamFn, error) {
		// 模拟 react agent 调用写工具，把动作暂存进本轮共享的 stager。
		it := findTool(t, tools, "create_resource")
		if _, err := it.InvokableRun(ctx, stageManifest); err != nil {
			return nil, err
		}
		return func(ctx context.Context, msgs []*schema.Message) (*schema.StreamReader[*schema.Message], error) {
			return schema.StreamReaderFromArray([]*schema.Message{
				{Role: schema.Assistant, Content: "我准备创建一个 nginx 部署，请确认。"},
			}), nil
		}, nil
	}

	convID, err := convs.Create(1, "c1", "对话")
	if err != nil {
		t.Fatal(err)
	}
	var events []Event
	err = r.Stream(context.Background(), 1, "c1", strconv.FormatUint(uint64(convID), 10), "在 dev 创建 nginx", func(e Event) {
		events = append(events, e)
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	// 应有 confirm_required（带 1 个动作），且不应有 done。
	var confirm *Event
	for i := range events {
		if events[i].Type == "confirm_required" {
			confirm = &events[i]
		}
		if events[i].Type == "done" {
			t.Fatalf("staged turn must NOT emit done, got %+v", events)
		}
	}
	if confirm == nil || len(confirm.Actions) != 1 || confirm.Actions[0].Name != "nginx" {
		t.Fatalf("expected confirm_required with 1 action, got %+v", events)
	}
	// 未执行任何写。
	if len(fexec.calls) != 0 {
		t.Fatalf("staged turn must NOT execute, got %d calls", len(fexec.calls))
	}
	// 助手消息带 pending_action。
	msgID, actions, ok := convs.LatestPending(convID)
	if !ok || msgID == 0 || len(actions) != 1 || actions[0].Action != "create" {
		t.Fatalf("expected persisted pending_action, got ok=%v actions=%+v", ok, actions)
	}
}

// TestRunnerConfirmApproves 确认执行：逐个动作经 fake executor 执行，发 tool_result + done，
// 并清空 pending（不可二次确认）。
func TestRunnerConfirmApproves(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	store := NewStore(db, cipher)
	convs := NewConvStore(db)
	pool := fakeToolsCluster(t)
	guard := writeGuardDB(t, db, true)
	r := NewRunner(store, convs, pool, guard)
	fexec := &fakeExecutor{}
	r.exec = fexec

	convID, _ := convs.Create(1, "c1", "对话")
	acts := []StagedAction{{Action: "create", Resource: "deployments", Namespace: "dev", Name: "nginx"}}
	if err := convs.AppendAssistant(convID, "请确认", "", marshalActions(acts)); err != nil {
		t.Fatal(err)
	}

	var events []Event
	err := r.Confirm(context.Background(), 1, "alice", strconv.FormatUint(uint64(convID), 10), true, func(e Event) {
		events = append(events, e)
	})
	if err != nil {
		t.Fatalf("Confirm: %v", err)
	}
	if len(fexec.calls) != 1 || fexec.calls[0].Name != "nginx" {
		t.Fatalf("expected 1 apply call, got %+v", fexec.calls)
	}
	var toolResults, dones int
	for _, e := range events {
		switch e.Type {
		case "tool_result":
			toolResults++
		case "done":
			dones++
		}
	}
	if toolResults != 1 || dones != 1 {
		t.Fatalf("expected 1 tool_result + 1 done, got %+v", events)
	}
	// pending 已清空。
	if _, _, ok := convs.LatestPending(convID); ok {
		t.Fatal("pending_action must be cleared after confirm")
	}
}

// TestRunnerConfirmRejects 取消：不执行任何写，发 done（含取消文案），清空 pending。
func TestRunnerConfirmRejects(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	store := NewStore(db, cipher)
	convs := NewConvStore(db)
	r := NewRunner(store, convs, fakeToolsCluster(t), writeGuardDB(t, db, true))
	fexec := &fakeExecutor{}
	r.exec = fexec

	convID, _ := convs.Create(1, "c1", "对话")
	acts := []StagedAction{{Action: "delete", Resource: "deployments", Namespace: "dev", Name: "web"}}
	_ = convs.AppendAssistant(convID, "请确认", "", marshalActions(acts))

	var events []Event
	err := r.Confirm(context.Background(), 1, "alice", strconv.FormatUint(uint64(convID), 10), false, func(e Event) {
		events = append(events, e)
	})
	if err != nil {
		t.Fatalf("Confirm: %v", err)
	}
	if len(fexec.calls) != 0 {
		t.Fatalf("reject must NOT execute, got %d calls", len(fexec.calls))
	}
	if len(events) == 0 || events[len(events)-1].Type != "done" {
		t.Fatalf("expected terminal done, got %+v", events)
	}
	if _, _, ok := convs.LatestPending(convID); ok {
		t.Fatal("pending_action must be cleared after reject")
	}
}

// TestRunnerConfirmCrossUserRejected 归属校验：他人会话的确认一律 ErrConversationNotFound。
func TestRunnerConfirmCrossUserRejected(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	store := NewStore(db, cipher)
	convs := NewConvStore(db)
	r := NewRunner(store, convs, fakeToolsCluster(t), writeGuardDB(t, db, true))
	fexec := &fakeExecutor{}
	r.exec = fexec

	convID, _ := convs.Create(1, "c1", "user1 的会话")
	_ = convs.AppendAssistant(convID, "请确认", "", marshalActions([]StagedAction{{Action: "create", Resource: "deployments", Namespace: "dev", Name: "x"}}))

	err := r.Confirm(context.Background(), 2, "mallory", strconv.FormatUint(uint64(convID), 10), true, func(Event) {})
	if !errors.Is(err, ErrConversationNotFound) {
		t.Fatalf("expected ErrConversationNotFound, got %v", err)
	}
	if len(fexec.calls) != 0 {
		t.Fatal("cross-user confirm must NOT execute")
	}
}

// TestRunnerStreamEmitsTokensAndPersists 用可注入接缝驱动 Runner，摆脱网络：
//   - buildModel 返回 nil（后续被 newAgent 忽略）；
//   - newAgent 返回一个投喂 canned 文本增量的 streamFn。
//
// 断言：emit 至少收到 1 个 token 且以 done 收尾；user + assistant 两条消息均落库。
func TestRunnerStreamEmitsTokensAndPersists(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	store := NewStore(db, cipher)
	// 配置随意（buildModel 被接缝短路，不发起网络）。
	if err := store.SaveConfig(ConfigInput{Enabled: true, BaseURL: "https://x/v1", APIKey: "k", ModelID: "m", SystemPrompt: "你是 K8s 助手"}); err != nil {
		t.Fatal(err)
	}
	convs := NewConvStore(db)
	guard := NewGuard(store, nil) // 本路径不触发工具，guard 不会被调用。

	r := NewRunner(store, convs, nil, guard)
	r.buildModel = func(ctx context.Context, cfg Config) (einomodel.ToolCallingChatModel, error) {
		return nil, nil
	}
	r.newAgent = func(ctx context.Context, cm einomodel.ToolCallingChatModel, tools []tool.BaseTool, systemPrompt string, maxStep int) (streamFn, error) {
		return func(ctx context.Context, msgs []*schema.Message) (*schema.StreamReader[*schema.Message], error) {
			return schema.StreamReaderFromArray([]*schema.Message{
				{Role: schema.Assistant, Content: "default 命名空间有 "},
				{Role: schema.Assistant, Content: "2 个部署。"},
			}), nil
		}, nil
	}

	convID, err := convs.Create(1, "c1", "对话")
	if err != nil {
		t.Fatal(err)
	}

	var events []Event
	err = r.Stream(context.Background(), 1, "c1", strconv.FormatUint(uint64(convID), 10), "列出 default 的部署", func(e Event) {
		events = append(events, e)
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	var tokens int
	for _, e := range events {
		if e.Type == "token" {
			tokens++
		}
	}
	if tokens < 1 {
		t.Fatalf("expected >=1 token event, got events=%+v", events)
	}
	if len(events) == 0 || events[len(events)-1].Type != "done" {
		t.Fatalf("expected terminal done event, got %+v", events)
	}

	msgs, err := convs.Messages(convID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("expected user+assistant persisted, got %d: %+v", len(msgs), msgs)
	}
	if msgs[0].Role != "user" || msgs[1].Role != "assistant" {
		t.Fatalf("persisted messages out of order: %+v", msgs)
	}
	if msgs[1].Content != "default 命名空间有 2 个部署。" {
		t.Fatalf("assistant content mismatch: %q", msgs[1].Content)
	}
}

// TestRunnerStreamRejectsBadConvID 无效 conversation_id 直接报错，不落库。
func TestRunnerStreamRejectsBadConvID(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	store := NewStore(db, cipher)
	convs := NewConvStore(db)
	r := NewRunner(store, convs, nil, NewGuard(store, nil))

	err := r.Stream(context.Background(), 1, "c1", "0", "hi", func(Event) {})
	if err == nil {
		t.Fatal("expected error for conversation_id=0")
	}
}

// TestRunnerStreamRejectsCrossUserConv 归属校验：user2 拿 user1 的会话 id 流式对话，
// 必须被 ErrConversationNotFound 拒绝，且「什么都不落库」——不读历史、不追加用户消息、
// 不跑 agent（newAgent 若被调用则测试失败）。
func TestRunnerStreamRejectsCrossUserConv(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	store := NewStore(db, cipher)
	convs := NewConvStore(db)
	guard := NewGuard(store, nil)

	r := NewRunner(store, convs, nil, guard)
	r.buildModel = func(ctx context.Context, cfg Config) (einomodel.ToolCallingChatModel, error) {
		return nil, nil
	}
	// agent 绝不应被装配：越权应在读历史/落库之前短路。
	r.newAgent = func(ctx context.Context, cm einomodel.ToolCallingChatModel, tools []tool.BaseTool, systemPrompt string, maxStep int) (streamFn, error) {
		t.Fatal("newAgent must not be called for a cross-user conversation")
		return nil, nil
	}

	// user1 拥有会话，user2 尝试借用它。
	convID, err := convs.Create(1, "c1", "user1 的会话")
	if err != nil {
		t.Fatal(err)
	}

	var events []Event
	err = r.Stream(context.Background(), 2, "c1", strconv.FormatUint(uint64(convID), 10), "偷看历史", func(e Event) {
		events = append(events, e)
	})
	if !errors.Is(err, ErrConversationNotFound) {
		t.Fatalf("expected ErrConversationNotFound, got %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected no events emitted, got %+v", events)
	}
	// 什么都不该落库（连 user 提问都不该写入他人会话）。
	msgs, err := convs.Messages(convID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 0 {
		t.Fatalf("expected nothing persisted, got %d: %+v", len(msgs), msgs)
	}
}

// TestRunnerStreamPersistsPartialOnMidStreamError 中途出错：流吐出一个 chunk 后返回
// 非 EOF 错误。断言——已累计的助手文本被落库（带「已中断」标记），且 emit 收到终止帧
// （error），Stream 返回该错误。
func TestRunnerStreamPersistsPartialOnMidStreamError(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	store := NewStore(db, cipher)
	if err := store.SaveConfig(ConfigInput{Enabled: true, BaseURL: "https://x/v1", APIKey: "k", ModelID: "m", SystemPrompt: "你是 K8s 助手"}); err != nil {
		t.Fatal(err)
	}
	convs := NewConvStore(db)
	guard := NewGuard(store, nil)

	r := NewRunner(store, convs, nil, guard)
	r.buildModel = func(ctx context.Context, cfg Config) (einomodel.ToolCallingChatModel, error) {
		return nil, nil
	}
	boom := errors.New("上游连接中断")
	r.newAgent = func(ctx context.Context, cm einomodel.ToolCallingChatModel, tools []tool.BaseTool, systemPrompt string, maxStep int) (streamFn, error) {
		return func(ctx context.Context, msgs []*schema.Message) (*schema.StreamReader[*schema.Message], error) {
			sr, sw := schema.Pipe[*schema.Message](2)
			go func() {
				sw.Send(&schema.Message{Role: schema.Assistant, Content: "default 命名空间有 "}, nil)
				sw.Send(nil, boom) // 中途注入非 EOF 错误。
				sw.Close()
			}()
			return sr, nil
		}, nil
	}

	convID, err := convs.Create(1, "c1", "对话")
	if err != nil {
		t.Fatal(err)
	}

	var events []Event
	err = r.Stream(context.Background(), 1, "c1", strconv.FormatUint(uint64(convID), 10), "列出部署", func(e Event) {
		events = append(events, e)
	})
	if !errors.Is(err, boom) {
		t.Fatalf("expected mid-stream error returned, got %v", err)
	}

	// 终止帧应为 error（而非 done）。
	if len(events) == 0 || events[len(events)-1].Type != "error" {
		t.Fatalf("expected terminal error frame, got %+v", events)
	}

	// 部分助手文本已落库（user + assistant 两条），且带「已中断」标记。
	msgs, err := convs.Messages(convID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 || msgs[1].Role != "assistant" {
		t.Fatalf("expected user+assistant persisted, got %d: %+v", len(msgs), msgs)
	}
	if want := "default 命名空间有 …（已中断）"; msgs[1].Content != want {
		t.Fatalf("partial assistant content mismatch: got %q want %q", msgs[1].Content, want)
	}
}
