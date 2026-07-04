package rbac

import "testing"

func TestIntegratedDeployArea(t *testing.T) {
	if !IsValidGlobalArea("integrated_deploy") {
		t.Fatal("integrated_deploy should be a valid global area")
	}
	if !IsValidGlobalAction("publish") {
		t.Fatal("publish should be a valid global action")
	}
	acts := AllGlobalPerms()["integrated_deploy"]
	want := map[string]bool{"view": true, "create": true, "edit": true, "delete": true, "publish": true}
	if len(acts) != len(want) {
		t.Fatalf("integrated_deploy admin perms = %v, want 5 actions", acts)
	}
	for _, a := range acts {
		if !want[a] {
			t.Fatalf("unexpected action %q in integrated_deploy admin perms", a)
		}
	}
}
