package ai

import (
	"context"
	"encoding/json"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"gorm.io/gorm"
)

// writeGuard 返回一个 AI 授予矩阵含 create/edit/delete、rbac 侧按 allow 放行/拒绝的 Guard。
func writeGuard(t *testing.T, allow bool) *Guard {
	t.Helper()
	return writeGuardDB(t, testDB(t), allow)
}

// writeGuardDB 同 writeGuard，但把授予矩阵存进指定 db（供 executor 测试与审计共用一个库）。
func writeGuardDB(t *testing.T, db *gorm.DB, allow bool) *Guard {
	t.Helper()
	store := NewStore(db, testCipher(t))
	if err := store.SaveGrant("c1", map[string][]string{"deployments": {"view", "create", "edit", "delete"}}); err != nil {
		t.Fatal(err)
	}
	return &Guard{store: store, rbac: stubAuthorizer{allow: allow}}
}

// TestWriteTools_CreateStagesOnly 核心不变式：create_resource 只暂存一个动作，
// 绝不触碰 fake 动态客户端（tracker 里查不到被创建的对象）。
func TestWriteTools_CreateStagesOnly(t *testing.T) {
	pool := fakeToolsCluster(t)
	stager := &Stager{}
	tools := WriteTools(pool, "c1", writeGuard(t, true), 1, stager)
	ct := findTool(t, tools, "create_resource")

	manifest := `{"resource":"deployments","namespace":"dev","manifest":{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"nginx","namespace":"dev"}}}`
	out, err := ct.InvokableRun(context.Background(), manifest)
	if err != nil {
		t.Fatalf("InvokableRun err: %v", err)
	}
	var res stageResult
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("bad json %q: %v", out, err)
	}
	if !res.Staged || res.Error != "" {
		t.Fatalf("expected staged, got %q", out)
	}

	// 恰好暂存一个动作，且字段正确。
	acts := stager.Actions()
	if len(acts) != 1 {
		t.Fatalf("expected exactly 1 staged action, got %d", len(acts))
	}
	a := acts[0]
	if a.Action != "create" || a.Resource != "deployments" || a.Namespace != "dev" || a.Name != "nginx" {
		t.Fatalf("staged action mismatch: %+v", a)
	}

	// 绝不曾触碰集群：fake tracker 里查不到 nginx。
	cc, _ := pool.Get("c1")
	gvr, _, _ := resolveGVR(cc, "deployments")
	if _, err := cc.Dynamic.Resource(gvr).Namespace("dev").Get(context.Background(), "nginx", metav1.GetOptions{}); err == nil {
		t.Fatal("create_resource must NOT mutate the cluster (nginx should not exist)")
	}
}

// TestWriteTools_DeniedStagesNothing rbac 拒绝时返回 permission denied，且不暂存。
func TestWriteTools_DeniedStagesNothing(t *testing.T) {
	pool := fakeToolsCluster(t)
	stager := &Stager{}
	tools := WriteTools(pool, "c1", writeGuard(t, false), 1, stager)
	dt := findTool(t, tools, "delete_resource")

	out, err := dt.InvokableRun(context.Background(), `{"resource":"deployments","namespace":"dev","name":"web"}`)
	if err != nil {
		t.Fatalf("denial must NOT be an error: %v", err)
	}
	var res stageResult
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("bad json %q: %v", out, err)
	}
	if res.Error == "" {
		t.Fatalf("expected permission denied error, got %q", out)
	}
	if len(stager.Actions()) != 0 {
		t.Fatalf("denied write must stage nothing, got %d", len(stager.Actions()))
	}
}

// TestWriteTools_UpdateStages update_resource 暂存动作，动作名保留 update。
func TestWriteTools_UpdateStages(t *testing.T) {
	pool := fakeToolsCluster(t)
	stager := &Stager{}
	tools := WriteTools(pool, "c1", writeGuard(t, true), 1, stager)
	ut := findTool(t, tools, "update_resource")

	body := `{"resource":"deployments","namespace":"dev","name":"web","manifest":{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"dev"}}}`
	if _, err := ut.InvokableRun(context.Background(), body); err != nil {
		t.Fatalf("InvokableRun err: %v", err)
	}
	acts := stager.Actions()
	if len(acts) != 1 || acts[0].Action != "update" || acts[0].Name != "web" {
		t.Fatalf("update staging mismatch: %+v", acts)
	}
}
