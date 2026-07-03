package ai

import (
	"context"
	"strings"
	"testing"

	fakeclientset "k8s.io/client-go/kubernetes/fake"

	"omnikube/internal/cluster"
)

func TestGetPodLogsTool(t *testing.T) {
	// 带 Typed fake 客户端的集群（fake 的 GetLogs 默认返回 "fake logs"）。
	cc := &cluster.ClusterClient{Typed: fakeclientset.NewSimpleClientset()}
	pool := cluster.NewPool(nil, nil, nil)
	pool.Set("c1", cc)

	t.Run("allowed → returns logs", func(t *testing.T) {
		tools := ReadTools(pool, "c1", NewGuard(stubAuthorizer{allow: true}), 1)
		out, err := findTool(t, tools, "get_pod_logs").
			InvokableRun(context.Background(), `{"namespace":"default","pod":"nginx"}`)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, "fake logs") {
			t.Fatalf("expected logs in result, got %q", out)
		}
	})

	t.Run("denied → permission denied, no logs", func(t *testing.T) {
		tools := ReadTools(pool, "c1", NewGuard(stubAuthorizer{allow: false}), 1)
		out, err := findTool(t, tools, "get_pod_logs").
			InvokableRun(context.Background(), `{"namespace":"default","pod":"nginx"}`)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, "permission denied") || strings.Contains(out, "fake logs") {
			t.Fatalf("expected permission denied without logs, got %q", out)
		}
	})
}
