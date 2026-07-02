package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"gorm.io/gorm"

	"omnikube/internal/auth"
	"omnikube/internal/model"
	"omnikube/internal/rbac"
)

func seedCluster(t *testing.T, db *gorm.DB, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if err := db.Create(&model.Cluster{ID: id, Name: id, Kubeconfig: "x", Status: "Healthy"}).Error; err != nil {
			t.Fatal(err)
		}
	}
}

// fullOps returns a per-resource operations map granting every applicable
// tree action (exec only applies to pods, reveal only to secrets).
func fullOps() map[string][]string {
	return map[string][]string{
		"deployments": {"view", "create", "edit", "delete"},
		"pods":        {"view", "exec"},
	}
}

func TestCreateRole_SingleClusterWithOperations(t *testing.T) {
	r, db, _ := adminApp(t)
	seedCluster(t, db, "cluster_f")
	body := map[string]any{
		"name": "ops", "description": "运维组",
		"global_perms": map[string][]string{"users": {"view"}},
		"rules": []map[string]any{
			{"cluster_id": "cluster_f", "scope": "cluster", "operations": fullOps()},
		},
	}
	w := doReq(r, "POST", "/api/v1/roles", body, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var role model.Role
	db.Where("name = ?", "ops").First(&role)
	var n int64
	db.Model(&model.RoleRule{}).Where("role_id = ?", role.ID).Count(&n)
	if n != 1 {
		t.Fatalf("expected 1 rule row, got %d", n)
	}
	var rv roleView
	json.Unmarshal(w.Body.Bytes(), &rv)
	if rv.System {
		t.Fatalf("unexpected view system=%v", rv.System)
	}
	if got := rv.Rules[0].Operations["deployments"]; len(got) != 4 {
		t.Fatalf("expected 4 deployment actions echoed, got %v", got)
	}
	if got := rv.Rules[0].Operations["pods"]; len(got) != 2 {
		t.Fatalf("expected 2 pod actions echoed, got %v", got)
	}
	if got := rv.GlobalPerms["users"]; len(got) != 1 || got[0] != "view" {
		t.Fatalf("expected global_perms users=[view] echoed, got %v", got)
	}
}

func TestCreateRole_WildcardCluster(t *testing.T) {
	r, db, _ := adminApp(t)
	_ = db
	body := map[string]any{
		"name": "super",
		"rules": []map[string]any{
			{"cluster_id": "*", "scope": "cluster", "operations": fullOps()},
		},
	}
	w := doReq(r, "POST", "/api/v1/roles", body, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for cluster_id '*', got %d (%s)", w.Code, w.Body.String())
	}
}

// global_perms are persisted and echoed; unknown areas and inapplicable
// actions are stripped.
func TestCreateRole_GlobalPermsSanitized(t *testing.T) {
	r, db, _ := adminApp(t)
	body := map[string]any{
		"name": "auditors",
		"global_perms": map[string][]string{
			"users":    {"view", "delete"},
			"releases": {"view"},
			"bogus":    {"view"}, // unknown area → dropped
			"roles":    {"frob"}, // unknown action → dropped, area kept empty
		},
		"rules": []map[string]any{},
	}
	w := doReq(r, "POST", "/api/v1/roles", body, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var rv roleView
	json.Unmarshal(w.Body.Bytes(), &rv)
	if _, ok := rv.GlobalPerms["bogus"]; ok {
		t.Fatalf("expected unknown area stripped, got %v", rv.GlobalPerms)
	}
	if got := rv.GlobalPerms["users"]; len(got) != 2 {
		t.Fatalf("expected users=[view delete], got %v", got)
	}
	if got := rv.GlobalPerms["roles"]; len(got) != 0 {
		t.Fatalf("expected roles actions all stripped, got %v", got)
	}
	var role model.Role
	db.Where("name = ?", "auditors").First(&role)
	if role.GlobalPerms == "" {
		t.Fatalf("expected persisted global_perms JSON, got empty")
	}
}

func TestCreateRole_DuplicateName(t *testing.T) {
	r, db, _ := adminApp(t)
	seedCluster(t, db, "cluster_f")
	body := map[string]any{"name": "dup", "rules": []map[string]any{}}
	doReq(r, "POST", "/api/v1/roles", body, true)
	w := doReq(r, "POST", "/api/v1/roles", body, true)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", w.Code)
	}
}

func TestCreateRole_Validation(t *testing.T) {
	r, db, _ := adminApp(t)
	seedCluster(t, db, "cluster_f")
	cases := []map[string]any{
		// namespace scope, empty namespaces
		{"name": "v1", "rules": []map[string]any{{"cluster_id": "cluster_f", "scope": "namespace", "operations": fullOps()}}},
		// namespace scope with wildcard cluster
		{"name": "v2", "rules": []map[string]any{{"cluster_id": "*", "scope": "namespace", "namespaces": []string{"dev"}, "operations": fullOps()}}},
		// unknown cluster
		{"name": "v3", "rules": []map[string]any{{"cluster_id": "nope", "scope": "cluster", "operations": fullOps()}}},
		// empty cluster_id
		{"name": "v4", "rules": []map[string]any{{"cluster_id": "", "scope": "cluster", "operations": fullOps()}}},
		// invalid scope
		{"name": "v5", "rules": []map[string]any{{"cluster_id": "cluster_f", "scope": "bogus", "operations": fullOps()}}},
		// unknown resource
		{"name": "v6", "rules": []map[string]any{{"cluster_id": "cluster_f", "scope": "cluster", "operations": map[string][]string{"bogus": {"view"}}}}},
		// unknown action
		{"name": "v7", "rules": []map[string]any{{"cluster_id": "cluster_f", "scope": "cluster", "operations": map[string][]string{"deployments": {"frobnicate"}}}}},
		// action not applicable to resource (exec only applies to pods)
		{"name": "v8", "rules": []map[string]any{{"cluster_id": "cluster_f", "scope": "cluster", "operations": map[string][]string{"services": {"exec"}}}}},
	}
	for i, body := range cases {
		w := doReq(r, "POST", "/api/v1/roles", body, true)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("case %d: expected 400, got %d (%s)", i, w.Code, w.Body.String())
		}
	}
}

func TestCreateRole_EmptyRulesAllowed(t *testing.T) {
	r, db, _ := adminApp(t)
	_ = db
	w := doReq(r, "POST", "/api/v1/roles", map[string]any{"name": "placeholder", "rules": []map[string]any{}}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for empty-rule role, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestListAndGetRole_GroupsRules(t *testing.T) {
	r, db, _ := adminApp(t)
	seedCluster(t, db, "cluster_f")
	body := map[string]any{
		"name": "team", "rules": []map[string]any{
			{"cluster_id": "cluster_f", "scope": "namespace", "namespaces": []string{"dev", "prod"},
				"operations": map[string][]string{"deployments": {"view", "edit"}}},
		},
	}
	doReq(r, "POST", "/api/v1/roles", body, true)
	var role model.Role
	db.Where("name = ?", "team").First(&role)

	w := doReq(r, "GET", "/api/v1/roles/"+strconv.Itoa(int(role.ID)), nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var rv roleView
	json.Unmarshal(w.Body.Bytes(), &rv)
	if len(rv.Rules) != 1 || len(rv.Rules[0].Namespaces) != 2 {
		t.Fatalf("expected 1 rule with 2 namespaces, got %+v", rv.Rules)
	}
	if len(rv.Rules[0].Operations["deployments"]) != 2 {
		t.Fatalf("expected operations echoed, got %+v", rv.Rules[0].Operations)
	}

	w = doReq(r, "GET", "/api/v1/roles", nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("list expected 200, got %d", w.Code)
	}
}

func TestListRoles_IncludesPresetSystemRoles(t *testing.T) {
	r, _, _ := adminApp(t)
	w := doReq(r, "GET", "/api/v1/roles", nil, true)
	var resp struct {
		Roles []roleView `json:"roles"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	var systemCount int
	keys := map[string]bool{}
	for _, rv := range resp.Roles {
		if rv.System {
			systemCount++
			keys[rv.Key] = true
		}
	}
	if systemCount != 6 {
		t.Fatalf("expected 6 preset system roles, got %d", systemCount)
	}
	// Each preset carries a stable i18n key.
	for _, k := range []string{"cluster-admin", "cluster-viewer", "developer", "operator", "release-manager", "auditor"} {
		if !keys[k] {
			t.Fatalf("missing preset key %q", k)
		}
	}
}

func TestUpdateRole_ReSyncsBoundUsers(t *testing.T) {
	r, db, h := adminApp(t)
	seedCluster(t, db, "cluster_f", "cluster_g")
	doReq(r, "POST", "/api/v1/roles", map[string]any{
		"name": "ops", "rules": []map[string]any{
			{"cluster_id": "cluster_f", "scope": "cluster", "operations": map[string][]string{"pods": {"view", "edit"}}},
		},
	}, true)
	var role model.Role
	db.Where("name = ?", "ops").First(&role)
	hash, _ := auth.HashPassword("pw")
	u := model.User{Username: "ann", Password: hash}
	db.Create(&u)
	db.Create(&model.UserRole{UserID: u.ID, RoleID: role.ID})
	if err := h.RBAC.SyncUserGrants(u.ID); err != nil {
		t.Fatal(err)
	}
	sid := strconv.FormatUint(uint64(u.ID), 10)
	if ok, _, _ := h.RBAC.Authorize(sid, "cluster_f", "", "pods", "write"); !ok {
		t.Fatal("setup: expected write allowed on cluster_f")
	}
	// update role → cluster_g read-only.
	w := doReq(r, "PUT", "/api/v1/roles/"+strconv.Itoa(int(role.ID)), map[string]any{
		"name": "ops", "rules": []map[string]any{
			{"cluster_id": "cluster_g", "scope": "cluster", "operations": map[string][]string{"pods": {"view"}}},
		},
	}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("update expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if ok, _, _ := h.RBAC.Authorize(sid, "cluster_f", "", "pods", "write"); ok {
		t.Fatal("expected cluster_f write denied after re-sync")
	}
	if ok, _, _ := h.RBAC.Authorize(sid, "cluster_g", "", "pods", "read"); !ok {
		t.Fatal("expected cluster_g read allowed after re-sync")
	}
}

func TestDeleteRole_CascadeUnbindAndResync(t *testing.T) {
	r, db, h := adminApp(t)
	seedCluster(t, db, "cluster_f")
	doReq(r, "POST", "/api/v1/roles", map[string]any{
		"name": "ops", "rules": []map[string]any{
			{"cluster_id": "cluster_f", "scope": "cluster", "operations": fullOps()},
		},
	}, true)
	var role model.Role
	db.Where("name = ?", "ops").First(&role)
	hash, _ := auth.HashPassword("pw")
	u := model.User{Username: "ann", Password: hash}
	db.Create(&u)
	db.Create(&model.UserRole{UserID: u.ID, RoleID: role.ID})
	h.RBAC.SyncUserGrants(u.ID)
	sid := strconv.FormatUint(uint64(u.ID), 10)

	w := doReq(r, "DELETE", "/api/v1/roles/"+strconv.Itoa(int(role.ID)), nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("delete expected 200, got %d", w.Code)
	}
	var nRole, nRule, nUR int64
	db.Model(&model.Role{}).Where("id = ?", role.ID).Count(&nRole)
	db.Model(&model.RoleRule{}).Where("role_id = ?", role.ID).Count(&nRule)
	db.Model(&model.UserRole{}).Where("role_id = ?", role.ID).Count(&nUR)
	if nRole != 0 || nRule != 0 || nUR != 0 {
		t.Fatalf("expected full cleanup, got role=%d rule=%d ur=%d", nRole, nRule, nUR)
	}
	if n := countGHandler(db, sid); n != 0 {
		t.Fatalf("expected user g grants cleared, got %d", n)
	}
}

func TestDeleteRole_SystemForbidden(t *testing.T) {
	r, db, _ := adminApp(t)
	var preset model.Role
	if err := db.Where("name = ?", rbac.PresetClusterAdmin).First(&preset).Error; err != nil {
		t.Fatalf("preset role not seeded: %v", err)
	}
	w := doReq(r, "DELETE", "/api/v1/roles/"+strconv.Itoa(int(preset.ID)), nil, true)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409 deleting system role, got %d (%s)", w.Code, w.Body.String())
	}
	var n int64
	db.Model(&model.Role{}).Where("id = ?", preset.ID).Count(&n)
	if n != 1 {
		t.Fatal("system role must survive delete attempt")
	}
}

func TestUpdateRole_SystemForbidden(t *testing.T) {
	r, db, _ := adminApp(t)
	var preset model.Role
	db.Where("name = ?", rbac.PresetClusterViewer).First(&preset)
	w := doReq(r, "PUT", "/api/v1/roles/"+strconv.Itoa(int(preset.ID)), map[string]any{
		"name": preset.Name, "description": "edited",
		"rules": []map[string]any{{"cluster_id": "*", "scope": "cluster", "operations": map[string][]string{"deployments": {"view"}}}},
	}, true)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected system role NOT editable (403), got %d (%s)", w.Code, w.Body.String())
	}
}

func TestRole_NonAdminForbidden(t *testing.T) {
	r, _, _ := adminApp(t)
	w := doReq(r, "GET", "/api/v1/roles", nil, false)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
}

func countGHandler(db *gorm.DB, sub string) int64 {
	var n int64
	db.Model(&model.CasbinRule{}).Where("ptype = ? AND v0 = ?", "g", sub).Count(&n)
	return n
}
