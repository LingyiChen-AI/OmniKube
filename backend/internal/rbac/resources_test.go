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
