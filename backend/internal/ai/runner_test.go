package ai

import (
	"context"
	"strconv"
	"testing"

	einomodel "github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
)

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
