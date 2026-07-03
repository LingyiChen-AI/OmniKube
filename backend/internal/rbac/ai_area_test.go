package rbac

import "testing"

func TestAIGlobalArea(t *testing.T) {
	if !IsValidGlobalArea("ai") {
		t.Error("ai must be a valid global area")
	}
	if acts := AllGlobalPerms()["ai"]; len(acts) != 2 || acts[0] != "view" || acts[1] != "edit" {
		t.Errorf("ai global perms want [view edit], got %v", acts)
	}
}
