package rbac

import "testing"

func TestResourceModule(t *testing.T) {
	if ModuleOf("deployments") != "workloads" {
		t.Fatal("deployments→workloads")
	}
	if ModuleOf("services") != "networking" {
		t.Fatal("services→networking")
	}
	if ModuleOf("secrets") != "storage" {
		t.Fatal("secrets→storage")
	}
	if ModuleOf("persistentvolumes") != "storage" {
		t.Fatal("pv→storage")
	}
	if ModuleOf("nodes") != "nodes" {
		t.Fatal("nodes→nodes")
	}
}

func TestActionApplies(t *testing.T) {
	if !ResourceActionApplies("pods", "exec") {
		t.Fatal("pods exec applies")
	}
	if ResourceActionApplies("services", "exec") {
		t.Fatal("services exec n/a")
	}
	if !ResourceActionApplies("secrets", "reveal") {
		t.Fatal("secrets reveal applies")
	}
	if ResourceActionApplies("deployments", "reveal") {
		t.Fatal("deploy reveal n/a")
	}
	if !ResourceActionApplies("deployments", "create") {
		t.Fatal("create applies")
	}
}

func TestValidResourceAction(t *testing.T) {
	if !IsValidResource("deployments") {
		t.Fatal("deployments valid")
	}
	if IsValidResource("bogus") {
		t.Fatal("bogus invalid")
	}
	if !IsValidResourceAction("view") || !IsValidResourceAction("exec") {
		t.Fatal("actions valid")
	}
}

func TestGlobalAreas(t *testing.T) {
	if !IsValidGlobalArea("clusters") || !IsValidGlobalArea("releases") {
		t.Fatal("areas")
	}
	if IsValidGlobalArea("bogus") {
		t.Fatal("bogus area")
	}
}

func TestCustomResourcesIsValid(t *testing.T) {
	if !IsValidResource(CustomResource) {
		t.Fatalf("customresources 应为合法资源")
	}
	if CustomResource != "customresources" {
		t.Fatalf("CustomResource = %q, want customresources", CustomResource)
	}
}

func TestCustomResourcesActions(t *testing.T) {
	for _, a := range []string{"view", "create", "edit", "delete"} {
		if !ResourceActionApplies(CustomResource, a) {
			t.Fatalf("customresources 应适用动作 %s", a)
		}
	}
	for _, a := range []string{"exec", "reveal"} {
		if ResourceActionApplies(CustomResource, a) {
			t.Fatalf("customresources 不应适用动作 %s", a)
		}
	}
}

func TestCustomResourcesNotInAllResources(t *testing.T) {
	for _, r := range AllResources {
		if r == CustomResource {
			t.Fatalf("customresources 不应出现在 AllResources")
		}
	}
}
