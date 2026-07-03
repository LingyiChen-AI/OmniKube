package ai

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"omnikube/internal/model"
)

// TestExecutor_ApplyCreateMutatesAndAudits 应用一个 create 动作：fake 动态客户端里
// 出现被创建对象，且恰好写入一条 action="ai_create" 的审计行，actor 为发起用户。
func TestExecutor_ApplyCreateMutatesAndAudits(t *testing.T) {
	db := testDB(t)
	pool := fakeToolsCluster(t)
	exec := NewExecutor(pool, writeGuardDB(t, db, true), db)

	a := StagedAction{
		Action: "create", Resource: "deployments", Namespace: "dev", Name: "nginx",
		Manifest: map[string]any{
			"apiVersion": "apps/v1", "kind": "Deployment",
			"metadata": map[string]any{"name": "nginx", "namespace": "dev"},
		},
	}
	if err := exec.Apply(context.Background(), 7, "alice", "c1", a); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	// 集群里应存在被创建对象。
	cc, _ := pool.Get("c1")
	gvr, _, _ := resolveGVR(cc, "deployments")
	if _, err := cc.Dynamic.Resource(gvr).Namespace("dev").Get(context.Background(), "nginx", metav1.GetOptions{}); err != nil {
		t.Fatalf("nginx should exist after Apply: %v", err)
	}

	// 恰好一条审计行，action=ai_create，actor=7。
	var logs []model.AuditLog
	if err := db.Find(&logs).Error; err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 audit row, got %d", len(logs))
	}
	if logs[0].Action != "ai_create" || logs[0].UserID != "7" || logs[0].Target != "nginx" {
		t.Fatalf("audit row mismatch: %+v", logs[0])
	}
	if logs[0].Result != "success" {
		t.Fatalf("expected success result, got %q", logs[0].Result)
	}
}

// TestExecutor_ApplyReGateDeniesAndNoMutation 再次过闸门被拒：返回 error，
// 既不改集群也不写审计（defence in depth）。
func TestExecutor_ApplyReGateDeniesAndNoMutation(t *testing.T) {
	db := testDB(t)
	pool := fakeToolsCluster(t)
	// rbac 拒绝 → 再次过闸门失败。
	exec := NewExecutor(pool, writeGuardDB(t, db, false), db)

	a := StagedAction{
		Action: "create", Resource: "deployments", Namespace: "dev", Name: "nginx",
		Manifest: map[string]any{
			"apiVersion": "apps/v1", "kind": "Deployment",
			"metadata": map[string]any{"name": "nginx", "namespace": "dev"},
		},
	}
	if err := exec.Apply(context.Background(), 7, "alice", "c1", a); err == nil {
		t.Fatal("expected re-gate denial error")
	}

	cc, _ := pool.Get("c1")
	gvr, _, _ := resolveGVR(cc, "deployments")
	if _, err := cc.Dynamic.Resource(gvr).Namespace("dev").Get(context.Background(), "nginx", metav1.GetOptions{}); err == nil {
		t.Fatal("denied Apply must NOT create the object")
	}
	var count int64
	db.Model(&model.AuditLog{}).Count(&count)
	if count != 0 {
		t.Fatalf("denied Apply must NOT audit, got %d rows", count)
	}
}

// TestExecutor_ApplyDelete 删除已存在对象成功并审计 ai_delete。
func TestExecutor_ApplyDelete(t *testing.T) {
	db := testDB(t)
	pool := fakeToolsCluster(t) // 预置 dev/web、dev/api
	exec := NewExecutor(pool, writeGuardDB(t, db, true), db)

	a := StagedAction{Action: "delete", Resource: "deployments", Namespace: "dev", Name: "web"}
	if err := exec.Apply(context.Background(), 3, "bob", "c1", a); err != nil {
		t.Fatalf("Apply delete: %v", err)
	}
	cc, _ := pool.Get("c1")
	gvr, _, _ := resolveGVR(cc, "deployments")
	if _, err := cc.Dynamic.Resource(gvr).Namespace("dev").Get(context.Background(), "web", metav1.GetOptions{}); err == nil {
		t.Fatal("web should be deleted")
	}
	var logs []model.AuditLog
	db.Find(&logs)
	if len(logs) != 1 || logs[0].Action != "ai_delete" {
		t.Fatalf("expected 1 ai_delete audit row, got %+v", logs)
	}
}
