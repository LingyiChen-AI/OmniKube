package rbac

import (
	"encoding/json"
	"testing"

	"omnikube/internal/model"
)

// opsJSON marshals an operations map to the JSON string stored in RoleRule.Operations.
func opsJSON(t *testing.T, ops map[string][]string) string {
	t.Helper()
	b, err := json.Marshal(ops)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// adminOps grants every action on every group.
func adminOps() map[string][]string {
	return map[string][]string{
		"workloads": {"read", "create", "write", "delete", "exec"},
		"network":   {"read", "create", "write", "delete"},
		"config":    {"read", "create", "write", "delete", "reveal"},
		"cluster":   {"read", "create", "write", "delete"},
	}
}

// viewerOps grants read on every group.
func viewerOps() map[string][]string {
	return map[string][]string{
		"workloads": {"read"}, "network": {"read"}, "config": {"read"}, "cluster": {"read"},
	}
}

// seedRole creates a role with the given rules and returns its ID.
func seedRole(t *testing.T, s *Service, name string, rules ...model.RoleRule) uint {
	t.Helper()
	role := model.Role{Name: name}
	if err := s.db.Create(&role).Error; err != nil {
		t.Fatal(err)
	}
	for i := range rules {
		rules[i].RoleID = role.ID
		if err := s.db.Create(&rules[i]).Error; err != nil {
			t.Fatal(err)
		}
	}
	return role.ID
}

func bindUserRole(t *testing.T, s *Service, userID, roleID uint) {
	t.Helper()
	if err := s.db.Create(&model.UserRole{UserID: userID, RoleID: roleID}).Error; err != nil {
		t.Fatal(err)
	}
}

func countG(s *Service, sub string) int64 {
	var n int64
	s.db.Model(&model.CasbinRule{}).Where("ptype = ? AND v0 = ?", "g", sub).Count(&n)
	return n
}

// TestSyncUserGrants_ClusterScope_MultiCluster: two cluster rules → one g row each.
func TestSyncUserGrants_ClusterScope_MultiCluster(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	admin := opsJSON(t, adminOps())
	rid := seedRole(t, svc, "ops",
		model.RoleRule{ClusterID: "cluster_f", Scope: "cluster", Operations: admin},
		model.RoleRule{ClusterID: "cluster_g", Scope: "cluster", Operations: admin},
	)
	bindUserRole(t, svc, 5, rid)
	if err := svc.SyncUserGrants(5); err != nil {
		t.Fatal(err)
	}
	if n := countG(svc, "5"); n != 2 {
		t.Fatalf("expected 2 cluster g rows, got %d", n)
	}
	mustAllow(t, svc, "5", "cluster_f", "pods", "write")
	mustAllow(t, svc, "5", "cluster_g", "secrets", "reveal")
	mustDeny(t, svc, "5", "cluster_x", "pods", "read")
}

// TestSyncUserGrants_WildcardCluster: cluster_id "*" spans all clusters with one g row.
func TestSyncUserGrants_WildcardCluster(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	rid := seedRole(t, svc, "super",
		model.RoleRule{ClusterID: "*", Scope: "cluster", Operations: opsJSON(t, adminOps())})
	bindUserRole(t, svc, 6, rid)
	if err := svc.SyncUserGrants(6); err != nil {
		t.Fatal(err)
	}
	if n := countG(svc, "6"); n != 1 {
		t.Fatalf("expected 1 wildcard g row, got %d", n)
	}
	mustAllow(t, svc, "6", "cluster_f", "pods", "write")
	mustAllow(t, svc, "6", "cluster_g:dev", "pods", "exec")
	mustAllow(t, svc, "6", "any_cluster", "nodes", "delete")
}

// TestSyncUserGrants_NamespaceScope: one rule with two namespaces → two ns g rows.
func TestSyncUserGrants_NamespaceScope(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	ops := opsJSON(t, map[string][]string{
		"workloads": {"read", "write", "exec"}, "config": {"read", "reveal"},
	})
	rid := seedRole(t, svc, "ns-team",
		model.RoleRule{ClusterID: "cluster_f", Scope: "namespace", Namespaces: `["dev","prod"]`, Operations: ops},
	)
	bindUserRole(t, svc, 7, rid)
	if err := svc.SyncUserGrants(7); err != nil {
		t.Fatal(err)
	}
	if n := countG(svc, "7"); n != 2 {
		t.Fatalf("expected 2 ns g rows, got %d", n)
	}
	mustAllow(t, svc, "7", "cluster_f:dev", "deployments", "write")
	mustAllow(t, svc, "7", "cluster_f:prod", "pods", "exec")
	mustAllow(t, svc, "7", "cluster_f:dev", "secrets", "reveal")
	mustDeny(t, svc, "7", "cluster_f:staging", "pods", "read")
	mustDeny(t, svc, "7", "cluster_f", "pods", "write")
}

// TestSyncUserGrants_DeleteIndependentOfWrite: write without delete denies delete.
func TestSyncUserGrants_DeleteIndependentOfWrite(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	ops := opsJSON(t, map[string][]string{"workloads": {"read", "write"}})
	rid := seedRole(t, svc, "editor-nodelete",
		model.RoleRule{ClusterID: "cluster_f", Scope: "cluster", Operations: ops})
	bindUserRole(t, svc, 8, rid)
	if err := svc.SyncUserGrants(8); err != nil {
		t.Fatal(err)
	}
	mustAllow(t, svc, "8", "cluster_f", "pods", "write")
	mustDeny(t, svc, "8", "cluster_f", "pods", "delete")
}

// TestSyncUserGrants_SignatureDedup: identical operation sets (any order) reuse one synthetic role.
func TestSyncUserGrants_SignatureDedup(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	a := opsJSON(t, map[string][]string{"workloads": {"read", "write"}, "config": {"read"}})
	// same set, different key/value order — must canonicalize to the same signature.
	b := opsJSON(t, map[string][]string{"config": {"read"}, "workloads": {"write", "read"}})
	rid := seedRole(t, svc, "dedup",
		model.RoleRule{ClusterID: "cluster_f", Scope: "cluster", Operations: a},
		model.RoleRule{ClusterID: "cluster_g", Scope: "cluster", Operations: b},
	)
	bindUserRole(t, svc, 12, rid)
	if err := svc.SyncUserGrants(12); err != nil {
		t.Fatal(err)
	}
	// Two grants but a single shared synthetic role.
	grants, err := svc.ListGrants("12")
	if err != nil {
		t.Fatal(err)
	}
	roleSet := map[string]bool{}
	for _, g := range grants {
		roleSet[g.Role] = true
	}
	if len(roleSet) != 1 {
		t.Fatalf("expected 1 shared synthetic role, got %d (%v)", len(roleSet), roleSet)
	}
	// p policies for that synth: workloads read, workloads write, config read = 3 rows.
	var synth string
	for r := range roleSet {
		synth = r
	}
	var pN int64
	svc.db.Model(&model.CasbinRule{}).Where("ptype = ? AND v0 = ?", "p", synth).Count(&pN)
	if pN != 3 {
		t.Fatalf("expected 3 idempotent p rows for synth, got %d", pN)
	}
}

// TestSyncUserGrants_MultiRoleUnion: two roles' permissions union.
func TestSyncUserGrants_MultiRoleUnion(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	r1 := seedRole(t, svc, "viewer-f",
		model.RoleRule{ClusterID: "cluster_f", Scope: "cluster", Operations: opsJSON(t, viewerOps())})
	r2 := seedRole(t, svc, "editor-g-dev",
		model.RoleRule{ClusterID: "cluster_g", Scope: "namespace", Namespaces: `["dev"]`,
			Operations: opsJSON(t, map[string][]string{"workloads": {"read", "write"}})})
	bindUserRole(t, svc, 9, r1)
	bindUserRole(t, svc, 9, r2)
	if err := svc.SyncUserGrants(9); err != nil {
		t.Fatal(err)
	}
	if n := countG(svc, "9"); n != 2 {
		t.Fatalf("expected 2 union g rows, got %d", n)
	}
	mustAllow(t, svc, "9", "cluster_f", "pods", "read")
	mustDeny(t, svc, "9", "cluster_f", "pods", "write")
	mustAllow(t, svc, "9", "cluster_g:dev", "deployments", "write")
	mustDeny(t, svc, "9", "cluster_g:prod", "pods", "read")
}

// TestSyncUserGrants_ReplacesOldGrants: re-sync after rule change replaces casbin g.
func TestSyncUserGrants_ReplacesOldGrants(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	rid := seedRole(t, svc, "ops",
		model.RoleRule{ClusterID: "cluster_f", Scope: "cluster", Operations: opsJSON(t, adminOps())})
	bindUserRole(t, svc, 3, rid)
	if err := svc.SyncUserGrants(3); err != nil {
		t.Fatal(err)
	}
	mustAllow(t, svc, "3", "cluster_f", "pods", "write")
	// Edit the role's rules: now only viewer on cluster_g.
	svc.db.Where("role_id = ?", rid).Delete(&model.RoleRule{})
	svc.db.Create(&model.RoleRule{RoleID: rid, ClusterID: "cluster_g", Scope: "cluster", Operations: opsJSON(t, viewerOps())})
	if err := svc.SyncRoleUsers(rid); err != nil {
		t.Fatal(err)
	}
	mustDeny(t, svc, "3", "cluster_f", "pods", "write")
	mustAllow(t, svc, "3", "cluster_g", "pods", "read")
	mustDeny(t, svc, "3", "cluster_g", "pods", "write")
	if n := countG(svc, "3"); n != 1 {
		t.Fatalf("expected 1 g row after re-sync, got %d", n)
	}
}

// TestSyncUserGrants_EmptyRoleNoGrants: a placeholder role (no rules) yields no grants.
func TestSyncUserGrants_EmptyRoleNoGrants(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	rid := seedRole(t, svc, "placeholder")
	bindUserRole(t, svc, 11, rid)
	if err := svc.SyncUserGrants(11); err != nil {
		t.Fatal(err)
	}
	if n := countG(svc, "11"); n != 0 {
		t.Fatalf("expected 0 g rows for placeholder role, got %d", n)
	}
}

// TestSyncUserGrants_PerResource: operations are per concrete resource (v3); each
// (resource, treeAction) materializes a policy with the casbin-mapped action, and
// only the granted resource/action pairs are allowed.
func TestSyncUserGrants_PerResource(t *testing.T) {
	svc, _ := newServiceWithNS(t, "cluster_f", "dev", "prod")
	rid := seedRole(t, svc, "r1",
		model.RoleRule{ClusterID: "cluster_f", Scope: "cluster",
			Operations: `{"deployments":["view","create"],"pods":["view","exec"]}`})
	bindUserRole(t, svc, 30, rid)
	if err := svc.SyncUserGrants(30); err != nil {
		t.Fatal(err)
	}
	chk := func(res, act string, want bool) {
		t.Helper()
		ok, _, err := svc.Authorize("30", "cluster_f", "", res, act)
		if err != nil {
			t.Fatal(err)
		}
		if ok != want {
			t.Fatalf("%s/%s want %v got %v", res, act, want, ok)
		}
	}
	chk("deployments", "read", true)   // view → read
	chk("deployments", "create", true) // create
	chk("deployments", "write", false) // no edit granted
	chk("deployments", "delete", false)
	chk("pods", "read", true) // view → read
	chk("pods", "exec", true)
	chk("pods", "write", false)
	chk("services", "read", false) // resource not granted at all
}

// TestOnClusterDeleted_CascadeResync: deleting a cluster prunes its role_rules and re-syncs users.
func TestOnClusterDeleted_CascadeResync(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	rid := seedRole(t, svc, "multi",
		model.RoleRule{ClusterID: "cluster_f", Scope: "cluster", Operations: opsJSON(t, adminOps())},
		model.RoleRule{ClusterID: "cluster_g", Scope: "cluster", Operations: opsJSON(t, viewerOps())},
	)
	bindUserRole(t, svc, 21, rid)
	if err := svc.SyncUserGrants(21); err != nil {
		t.Fatal(err)
	}
	if n := countG(svc, "21"); n != 2 {
		t.Fatalf("setup: expected 2 g rows, got %d", n)
	}
	if err := svc.OnClusterDeleted("cluster_f"); err != nil {
		t.Fatal(err)
	}
	var ruleN int64
	svc.db.Model(&model.RoleRule{}).Where("cluster_id = ?", "cluster_f").Count(&ruleN)
	if ruleN != 0 {
		t.Fatalf("expected cluster_f role_rules pruned, got %d", ruleN)
	}
	if n := countG(svc, "21"); n != 1 {
		t.Fatalf("expected 1 g row after cluster delete, got %d", n)
	}
	mustDeny(t, svc, "21", "cluster_f", "pods", "read")
	mustAllow(t, svc, "21", "cluster_g", "pods", "read")
}
