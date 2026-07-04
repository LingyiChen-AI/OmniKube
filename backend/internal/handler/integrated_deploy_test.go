package handler

import "testing"

func TestDeployAllowedKind(t *testing.T) {
	for _, k := range []string{"configmaps", "secrets", "deployments", "services", "ingresses", "persistentvolumeclaims"} {
		if !deployAllowedKind(k) {
			t.Errorf("%s should be allowed", k)
		}
	}
	for _, k := range []string{"pods", "nodes", "persistentvolumes", "bogus"} {
		if deployAllowedKind(k) {
			t.Errorf("%s should NOT be allowed", k)
		}
	}
}

func TestSortDeployItems(t *testing.T) {
	in := []DeployItem{
		{Kind: "services", SortIndex: 0},
		{Kind: "deployments", SortIndex: 1},
		{Kind: "configmaps", SortIndex: 0},
		{Kind: "deployments", SortIndex: 0},
	}
	got := sortDeployItems(in)
	wantKinds := []string{"configmaps", "deployments", "deployments", "services"}
	for i, w := range wantKinds {
		if got[i].Kind != w {
			t.Fatalf("pos %d = %s, want %s (order: %+v)", i, got[i].Kind, w, got)
		}
	}
	// 组内按 sort_index:两个 deployments 中 SortIndex 0 应排在 1 之前。
	if got[1].SortIndex != 0 || got[2].SortIndex != 1 {
		t.Fatalf("within-group order wrong: %+v", got)
	}
	// 不修改入参。
	if in[0].Kind != "services" {
		t.Fatal("sortDeployItems must not mutate input")
	}
}
