package rbac

import (
	"testing"

	"omnikube/internal/model"
)

// TestCapabilities_PerResource: capabilities 按具体资源返回被允许的树动作（而非资源组）。
func TestCapabilities_PerResource(t *testing.T) {
	svc, _ := newServiceWithNS(t, "cluster_f")
	rid := seedRole(t, svc, "c",
		model.RoleRule{ClusterID: "cluster_f", Scope: "cluster", Operations: `{"pods":["view","exec"]}`})
	bindUserRole(t, svc, 91, rid)
	if err := svc.SyncUserGrants(91); err != nil {
		t.Fatal(err)
	}
	caps := svc.Capabilities("91", "cluster_f", "")
	if !contains(caps["pods"], "view") || !contains(caps["pods"], "exec") {
		t.Fatalf("pods %v", caps["pods"])
	}
	if contains(caps["pods"], "edit") {
		t.Fatal("no edit expected on pods")
	}
	if len(caps["deployments"]) != 0 {
		t.Fatalf("deployments should be empty, got %v", caps["deployments"])
	}
}

// TestAllCapabilities_PerResource: admin 全量按具体资源；exec 仅 pods，reveal 仅 secrets。
func TestAllCapabilities_PerResource(t *testing.T) {
	caps := AllCapabilities()
	if _, ok := caps["pods"]; !ok {
		t.Fatalf("expected pods key, got %v", caps)
	}
	if !contains(caps["pods"], "exec") {
		t.Fatalf("pods should allow exec, got %v", caps["pods"])
	}
	if contains(caps["deployments"], "exec") {
		t.Fatalf("deployments must not allow exec, got %v", caps["deployments"])
	}
	if !contains(caps["secrets"], "reveal") {
		t.Fatalf("secrets should allow reveal, got %v", caps["secrets"])
	}
	if contains(caps["configmaps"], "reveal") {
		t.Fatalf("configmaps must not allow reveal, got %v", caps["configmaps"])
	}
	for _, ta := range []string{"view", "create", "edit", "delete"} {
		if !contains(caps["deployments"], ta) {
			t.Fatalf("deployments should allow %s, got %v", ta, caps["deployments"])
		}
	}
}

func TestAllCapabilitiesIncludesCustomResources(t *testing.T) {
	caps := AllCapabilities()
	acts, ok := caps[CustomResource]
	if !ok {
		t.Fatalf("AllCapabilities 应含 customresources")
	}
	want := map[string]bool{"view": true, "create": true, "edit": true, "delete": true}
	if len(acts) != len(want) {
		t.Fatalf("customresources 动作 = %v, want view/create/edit/delete", acts)
	}
	for _, a := range acts {
		if !want[a] {
			t.Fatalf("customresources 含意外动作 %s", a)
		}
	}
}
