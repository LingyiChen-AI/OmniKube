package ai

import (
	"context"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
)

// fakeInvokable 是一个最小 InvokableTool，返回固定结果，用于验证 tracedTool 装饰行为。
type fakeInvokable struct {
	name string
	out  string
}

func (f fakeInvokable) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: f.name}, nil
}

func (f fakeInvokable) InvokableRun(_ context.Context, _ string, _ ...tool.Option) (string, error) {
	return f.out, nil
}

func TestTracedToolEmitsCallAndResult(t *testing.T) {
	var got []Event
	tracer := &Tracer{}
	wrapped := traceTools([]tool.BaseTool{fakeInvokable{name: "list_resources", out: `{"count":2}`}},
		func(e Event) { got = append(got, e) }, tracer)

	inv, ok := wrapped[0].(tool.InvokableTool)
	if !ok {
		t.Fatalf("wrapped tool is not InvokableTool")
	}
	res, err := inv.InvokableRun(context.Background(), `{"resource":"pods"}`)
	if err != nil {
		t.Fatal(err)
	}
	if res != `{"count":2}` {
		t.Fatalf("result passthrough broken: %q", res)
	}
	// A tool_call (with args) then a tool_result (with result) must be emitted.
	if len(got) != 2 || got[0].Type != "tool_call" || got[1].Type != "tool_result" {
		t.Fatalf("expected [tool_call, tool_result], got %+v", got)
	}
	if got[0].Tool != "list_resources" || got[0].Args != `{"resource":"pods"}` {
		t.Fatalf("tool_call payload wrong: %+v", got[0])
	}
	if got[1].Result != `{"count":2}` {
		t.Fatalf("tool_result payload wrong: %+v", got[1])
	}
	// The trace records the full step for persistence/replay.
	steps := tracer.Steps()
	if len(steps) != 1 || steps[0].Tool != "list_resources" || steps[0].Result != `{"count":2}` {
		t.Fatalf("tracer did not record the step: %+v", steps)
	}
}
