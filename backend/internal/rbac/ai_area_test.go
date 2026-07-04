package rbac

import "testing"

func TestAIGlobalArea(t *testing.T) {
	if !IsValidGlobalArea("ai") {
		t.Error("ai must be a valid global area")
	}
	// ai:create 语义为「启用/停用开关」，与 edit(编辑模型配置)分离授权。
	want := []string{"view", "edit", "create"}
	acts := AllGlobalPerms()["ai"]
	if len(acts) != len(want) {
		t.Fatalf("ai global perms want %v, got %v", want, acts)
	}
	for i := range want {
		if acts[i] != want[i] {
			t.Errorf("ai global perms want %v, got %v", want, acts)
		}
	}
}
