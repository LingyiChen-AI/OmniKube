package handler

import (
	"encoding/json"
	"net/http"
	"sort"
	"testing"

	"omnikube/internal/rbac"
)

func TestListNamespaces_AdminAll(t *testing.T) {
	cc := typedCC(nsObj("default"), nsObj("dev"), nsObj("prod"), nsObj("kube-system"))
	app, _, _ := resApp(t, cc)

	w := resReq(app, "GET", "/api/v1/namespaces", "1", true, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Namespaces []string `json:"namespaces"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	sort.Strings(resp.Namespaces)
	want := []string{"default", "dev", "kube-system", "prod"}
	if len(resp.Namespaces) != 4 || resp.Namespaces[0] != want[0] {
		t.Fatalf("admin should see all NS, got %v", resp.Namespaces)
	}
}

func TestListNamespaces_NSRoleOnlyVisible(t *testing.T) {
	cc := typedCC(nsObj("default"), nsObj("dev"), nsObj("prod"))
	app, _, h := resApp(t, cc)
	_ = h.RBAC.AddGrant("9", rbac.RoleNSViewer, "c1:dev")
	_ = h.RBAC.AddGrant("9", rbac.RoleNSViewer, "c1:prod")

	w := resReq(app, "GET", "/api/v1/namespaces", "9", false, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp struct {
		Namespaces []string `json:"namespaces"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	sort.Strings(resp.Namespaces)
	if len(resp.Namespaces) != 2 || resp.Namespaces[0] != "dev" || resp.Namespaces[1] != "prod" {
		t.Fatalf("expected [dev prod], got %v", resp.Namespaces)
	}
}

func TestListNamespaces_ClusterRoleAll(t *testing.T) {
	cc := typedCC(nsObj("default"), nsObj("dev"), nsObj("prod"))
	app, _, h := resApp(t, cc)
	_ = h.RBAC.AddGrant("10", rbac.RoleClusterViewer, "c1")

	w := resReq(app, "GET", "/api/v1/namespaces", "10", false, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp struct {
		Namespaces []string `json:"namespaces"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Namespaces) != 3 {
		t.Fatalf("cluster-level role should see all NS (3), got %v", resp.Namespaces)
	}
}
