package ai

import (
	"context"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

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

// deployWithImage 构造一个带单容器镜像的 Deployment（用于发布记录镜像 diff 测试）。
func deployWithImage(ns, name, cname, image string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]any{"name": name, "namespace": ns},
		"spec": map[string]any{
			"template": map[string]any{
				"spec": map[string]any{
					"containers": []any{
						map[string]any{"name": cname, "image": image},
					},
				},
			},
		},
	}}
}

// TestExecutor_ApplyUpdateRecordsRelease AI 确认的 Deployment 镜像变更：更新成功并写入
// 一条 ReleaseRecord（Comment 含 "OmniKube AI"，前后镜像正确）；非镜像变更不记发布。
func TestExecutor_ApplyUpdateRecordsRelease(t *testing.T) {
	db := testDB(t)
	pool := fakeToolsCluster(t)
	exec := NewExecutor(pool, writeGuardDB(t, db, true), db)
	cc, _ := pool.Get("c1")
	gvr, _, _ := resolveGVR(cc, "deployments")

	// 预置一个带镜像 nginx:1.20 的 Deployment。
	if _, err := cc.Dynamic.Resource(gvr).Namespace("dev").
		Create(context.Background(), deployWithImage("dev", "img-app", "app", "nginx:1.20"), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	// 镜像变更的更新：nginx:1.20 → nginx:1.21。
	upd := StagedAction{
		Action: "update", Resource: "deployments", Namespace: "dev", Name: "img-app",
		Manifest: deployWithImage("dev", "img-app", "app", "nginx:1.21").Object,
	}
	if err := exec.Apply(context.Background(), 7, "alice", "c1", upd); err != nil {
		t.Fatalf("Apply update: %v", err)
	}

	var recs []model.ReleaseRecord
	if err := db.Find(&recs).Error; err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 {
		t.Fatalf("expected 1 release record after image change, got %d", len(recs))
	}
	r0 := recs[0]
	if !strings.Contains(r0.Comment, "OmniKube AI") {
		t.Fatalf("release comment should mark OmniKube AI, got %q", r0.Comment)
	}
	if r0.Kind != "Deployment" || r0.Name != "img-app" || r0.Namespace != "dev" {
		t.Fatalf("release record fields mismatch: %+v", r0)
	}
	if r0.ImageBefore != "app=nginx:1.20" || r0.ImageAfter != "app=nginx:1.21" {
		t.Fatalf("release images mismatch: before=%q after=%q", r0.ImageBefore, r0.ImageAfter)
	}
	if r0.UserID != 7 || r0.Username != "alice" {
		t.Fatalf("release releaser mismatch: %+v", r0)
	}

	// 非镜像变更（镜像保持 nginx:1.21）：不应新增发布记录。
	noImg := StagedAction{
		Action: "update", Resource: "deployments", Namespace: "dev", Name: "img-app",
		Manifest: deployWithImage("dev", "img-app", "app", "nginx:1.21").Object,
	}
	if err := exec.Apply(context.Background(), 7, "alice", "c1", noImg); err != nil {
		t.Fatalf("Apply non-image update: %v", err)
	}
	var count int64
	db.Model(&model.ReleaseRecord{}).Count(&count)
	if count != 1 {
		t.Fatalf("non-image update must NOT add a release record, total=%d", count)
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
