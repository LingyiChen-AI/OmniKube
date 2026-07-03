package ai

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
)

// ToolTrace 是一次工具调用的完整轨迹（工具名 + JSON 入参 + JSON 结果）。
// 既用于流式实时展示，也序列化落库以便重载会话时回放工具执行过程。
type ToolTrace struct {
	Tool   string `json:"tool"`
	Args   string `json:"args,omitempty"`
	Result string `json:"result,omitempty"`
}

// Tracer 并发安全地收集本轮所有工具调用轨迹（工具在 agent 后台 goroutine 执行）。
type Tracer struct {
	mu    sync.Mutex
	steps []ToolTrace
}

func (t *Tracer) add(s ToolTrace) {
	t.mu.Lock()
	t.steps = append(t.steps, s)
	t.mu.Unlock()
}

// Steps 返回轨迹快照（副本，读后可安全在别处使用）。
func (t *Tracer) Steps() []ToolTrace {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]ToolTrace(nil), t.steps...)
}

// tracedTool 包装一个 InvokableTool：调用前发 tool_call、返回后发 tool_result，
// 并把 {入参, 结果} 记入 Tracer。emit 必须并发安全（工具在后台 goroutine 执行，
// Runner 通过 channel 把 emit 串行化到单一写者）。
type tracedTool struct {
	inner  tool.InvokableTool
	emit   func(Event)
	tracer *Tracer
}

func (t tracedTool) Info(ctx context.Context) (*schema.ToolInfo, error) {
	return t.inner.Info(ctx)
}

func (t tracedTool) InvokableRun(ctx context.Context, args string, opts ...tool.Option) (string, error) {
	name := ""
	if info, err := t.inner.Info(ctx); err == nil && info != nil {
		name = info.Name
	}
	t.emit(Event{Type: "tool_call", Tool: name, Args: args})
	res, err := t.inner.InvokableRun(ctx, args, opts...)
	out := res
	if err != nil {
		out = err.Error()
	}
	t.emit(Event{Type: "tool_result", Tool: name, Result: out})
	t.tracer.add(ToolTrace{Tool: name, Args: args, Result: out})
	return res, err
}

// traceTools 把每个可执行工具包装成 tracedTool（非 InvokableTool 原样保留）。
func traceTools(tools []tool.BaseTool, emit func(Event), tracer *Tracer) []tool.BaseTool {
	out := make([]tool.BaseTool, 0, len(tools))
	for _, tl := range tools {
		if inv, ok := tl.(tool.InvokableTool); ok {
			out = append(out, tracedTool{inner: inv, emit: emit, tracer: tracer})
		} else {
			out = append(out, tl)
		}
	}
	return out
}

// marshalTrace 把工具轨迹序列化为 JSON 字符串；空/失败返回空串。
func marshalTrace(steps []ToolTrace) string {
	if len(steps) == 0 {
		return ""
	}
	if raw, err := json.Marshal(steps); err == nil {
		return string(raw)
	}
	return ""
}
