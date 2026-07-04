package rbac

import (
	"encoding/json"
	"reflect"
	"sort"
	"strconv"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	fakeclientset "k8s.io/client-go/kubernetes/fake"

	"omnikube/internal/cluster"
	"omnikube/internal/crypto"
	"omnikube/internal/database"
	"omnikube/internal/model"
)

func testKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i + 3)
	}
	return k
}

// newServiceWithNS builds a Service backed by in-memory sqlite, plus a pool whose
// client for clusterID is a fake clientset seeded with the given namespaces.
func newServiceWithNS(t *testing.T, clusterID string, namespaces ...string) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	ci, err := crypto.New(testKey())
	if err != nil {
		t.Fatal(err)
	}
	pool := cluster.NewPool(db, ci, func(string) (*cluster.ClusterClient, error) { return &cluster.ClusterClient{}, nil })
	if clusterID != "" {
		objs := make([]runtime.Object, 0, len(namespaces))
		for _, n := range namespaces {
			objs = append(objs, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: n}})
		}
		cs := fakeclientset.NewSimpleClientset(objs...)
		pool.Set(clusterID, &cluster.ClusterClient{Typed: cs})
	}
	svc, err := NewService(db, pool)
	if err != nil {
		t.Fatal(err)
	}
	return svc, db
}

func mustAllow(t *testing.T, s *Service, sub, dom, obj, act string) {
	t.Helper()
	ok, err := s.enforcer.Enforce(sub, dom, obj, act)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatalf("expected ALLOW for (%s,%s,%s,%s)", sub, dom, obj, act)
	}
}

func mustDeny(t *testing.T, s *Service, sub, dom, obj, act string) {
	t.Helper()
	ok, err := s.enforcer.Enforce(sub, dom, obj, act)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("expected DENY for (%s,%s,%s,%s)", sub, dom, obj, act)
	}
}

// equalStringSet reports whether a and b contain the same elements (order-insensitive).
func equalStringSet(a, b []string) bool {
	ac := append([]string(nil), a...)
	bc := append([]string(nil), b...)
	sort.Strings(ac)
	sort.Strings(bc)
	return reflect.DeepEqual(ac, bc)
}

func TestSeedPresetRoles(t *testing.T) {
	svc, db := newServiceWithNS(t, "")
	// Pages are now derived from operations, so the dashboard-only Auditor preset is gone;
	// only the cluster-admin and cluster-read presets remain.
	for _, name := range []string{PresetClusterAdmin, PresetClusterViewer} {
		var role model.Role
		if err := db.Where("name = ?", name).First(&role).Error; err != nil {
			t.Fatalf("preset role %q not seeded: %v", name, err)
		}
		if !role.System {
			t.Fatalf("preset role %q must be System", name)
		}
		var nr int64
		db.Model(&model.RoleRule{}).Where("role_id = ? AND cluster_id = ?", role.ID, "*").Count(&nr)
		if nr != 1 {
			t.Fatalf("preset role %q must have one cluster:* rule, got %d", name, nr)
		}
	}
	// Idempotent: re-seeding does not duplicate.
	if err := svc.seedPresetRoles(); err != nil {
		t.Fatal(err)
	}
	var n int64
	db.Model(&model.Role{}).Where("system = ?", true).Count(&n)
	if n != 6 {
		t.Fatalf("expected 6 preset roles after re-seed, got %d", n)
	}
	// Presets carry stable i18n keys.
	for name, key := range map[string]string{
		PresetClusterAdmin:  KeyClusterAdmin,
		PresetClusterViewer: KeyClusterViewer,
		PresetDeveloper:     KeyDeveloper,
		PresetOperator:      KeyOperator,
		PresetReleaseMgr:    KeyReleaseMgr,
		PresetAuditor:       KeyAuditor,
	} {
		var role model.Role
		db.Where("name = ?", name).First(&role)
		if role.Key != key {
			t.Fatalf("preset %q key = %q, want %q", name, role.Key, key)
		}
	}

	// v3: cluster-admin preset operations are per-resource tree actions, and global
	// perms cover clusters/users/roles/releases.
	var ca model.Role
	db.Where("name = ?", PresetClusterAdmin).First(&ca)
	{
		var caRule model.RoleRule
		db.Where("role_id = ? AND cluster_id = ?", ca.ID, "*").First(&caRule)
		var ops map[string][]string
		if err := json.Unmarshal([]byte(caRule.Operations), &ops); err != nil {
			t.Fatalf("cluster-admin operations not valid JSON: %v", err)
		}
		// deployments: view/create/edit/delete (no exec/reveal).
		if got := ops["deployments"]; !equalStringSet(got, []string{"view", "create", "edit", "delete"}) {
			t.Fatalf("cluster-admin deployments ops = %v, want view/create/edit/delete", got)
		}
		// pods: includes view and exec.
		if !contains(ops["pods"], "view") || !contains(ops["pods"], "exec") {
			t.Fatalf("cluster-admin pods ops = %v, want view+exec", ops["pods"])
		}
		// secrets: includes reveal.
		if !contains(ops["secrets"], "reveal") {
			t.Fatalf("cluster-admin secrets ops = %v, want reveal", ops["secrets"])
		}
		var gp map[string][]string
		if err := json.Unmarshal([]byte(ca.GlobalPerms), &gp); err != nil {
			t.Fatalf("cluster-admin global perms not valid JSON: %v", err)
		}
		for _, area := range []string{"clusters", "users", "roles", "releases"} {
			if len(gp[area]) == 0 {
				t.Fatalf("cluster-admin global perms missing area %q: %v", area, gp)
			}
		}
	}

	// v3: cluster-viewer preset has every resource = [view] and global perms = {releases:[view]}.
	{
		var cv model.Role
		db.Where("name = ?", PresetClusterViewer).First(&cv)
		var cvRule model.RoleRule
		db.Where("role_id = ? AND cluster_id = ?", cv.ID, "*").First(&cvRule)
		var ops map[string][]string
		if err := json.Unmarshal([]byte(cvRule.Operations), &ops); err != nil {
			t.Fatalf("cluster-viewer operations not valid JSON: %v", err)
		}
		for res, acts := range ops {
			if !equalStringSet(acts, []string{"view"}) {
				t.Fatalf("cluster-viewer resource %q ops = %v, want [view]", res, acts)
			}
		}
		if cv.GlobalPerms != `{"releases":["view"]}` {
			t.Fatalf("cluster-viewer global perms = %q, want {\"releases\":[\"view\"]}", cv.GlobalPerms)
		}
	}

	// End-to-end: bind a user to the cluster-admin preset → full access on any cluster.
	bindUserRole(t, svc, 42, ca.ID)
	if err := svc.SyncUserGrants(42); err != nil {
		t.Fatal(err)
	}
	mustAllow(t, svc, "42", "any_cluster", "pods", "delete")
	mustAllow(t, svc, "42", "any_cluster:ns", "secrets", "reveal")
}

func TestSeedRoles_Idempotent(t *testing.T) {
	svc, db := newServiceWithNS(t, "")
	var n1 int64
	db.Model(&model.CasbinRule{}).Where("ptype = ?", "p").Count(&n1)
	if n1 != 15 {
		t.Fatalf("expected 15 p policies, got %d", n1)
	}
	// re-seed should not duplicate
	if err := svc.seedRoles(); err != nil {
		t.Fatal(err)
	}
	var n2 int64
	db.Model(&model.CasbinRule{}).Where("ptype = ?", "p").Count(&n2)
	if n2 != 15 {
		t.Fatalf("seed not idempotent: %d", n2)
	}
}

// TestSingleCasbinRuleTable proves there is exactly one casbin_rule table and that
// the adapter writes through it.
func TestSingleCasbinRuleTable(t *testing.T) {
	svc, db := newServiceWithNS(t, "")
	if err := svc.AddGrant("7", RoleNSViewer, "cluster_f:dev"); err != nil {
		t.Fatal(err)
	}
	var tables []string
	if err := db.Raw("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%casbin%'").Scan(&tables).Error; err != nil {
		t.Fatal(err)
	}
	if len(tables) != 1 || tables[0] != "casbin_rule" {
		t.Fatalf("expected single casbin_rule table, got %v", tables)
	}
	var n int64
	db.Model(&model.CasbinRule{}).Where("ptype = ? AND v0 = ?", "g", "7").Count(&n)
	if n != 1 {
		t.Fatalf("expected grant row in casbin_rule, got %d", n)
	}
}

func TestEnforceMatrix(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	// bindings
	if err := svc.AddGrant("admin", RoleClusterAdmin, "cluster_f"); err != nil {
		t.Fatal(err)
	}
	if err := svc.AddGrant("cv", RoleClusterViewer, "cluster_f"); err != nil {
		t.Fatal(err)
	}
	if err := svc.AddGrant("ed", RoleNSEditor, "cluster_f:dev"); err != nil {
		t.Fatal(err)
	}
	if err := svc.AddGrant("vw", RoleNSViewer, "cluster_g:test-ns"); err != nil {
		t.Fatal(err)
	}

	// Cluster-Admin: everything in cluster_f, both cluster-level and any NS.
	mustAllow(t, svc, "admin", "cluster_f", "nodes", "write")
	mustAllow(t, svc, "admin", "cluster_f:dev", "pods", "exec")
	mustAllow(t, svc, "admin", "cluster_f:prod", "secrets", "reveal")
	// no cross cluster
	mustDeny(t, svc, "admin", "cluster_g", "pods", "read")

	// Cluster-Viewer: read anywhere in cluster_f, never write/exec/reveal.
	mustAllow(t, svc, "cv", "cluster_f", "pods", "read")
	mustAllow(t, svc, "cv", "cluster_f:dev", "pods", "read")
	mustDeny(t, svc, "cv", "cluster_f", "pods", "write")
	mustDeny(t, svc, "cv", "cluster_f:dev", "pods", "exec")

	// NS-Editor in cluster_f:dev: write workloads/network/config, reveal config, exec pods, read.
	mustAllow(t, svc, "ed", "cluster_f:dev", "deployments", "write")
	mustAllow(t, svc, "ed", "cluster_f:dev", "services", "write")
	mustAllow(t, svc, "ed", "cluster_f:dev", "secrets", "reveal")
	mustAllow(t, svc, "ed", "cluster_f:dev", "pods", "exec")
	mustAllow(t, svc, "ed", "cluster_f:dev", "pods", "read")
	// reveal/exec not granted by write coverage on wrong resource
	mustDeny(t, svc, "ed", "cluster_f:dev", "nodes", "write")
	// not in sibling ns, not at cluster level
	mustDeny(t, svc, "ed", "cluster_f:prod", "deployments", "write")
	mustDeny(t, svc, "ed", "cluster_f", "deployments", "write")

	// NS-Viewer in cluster_g:test-ns: read only there.
	mustAllow(t, svc, "vw", "cluster_g:test-ns", "pods", "read")
	mustDeny(t, svc, "vw", "cluster_g:test-ns", "pods", "write")
	mustDeny(t, svc, "vw", "cluster_g:dev-ns", "pods", "read")
	mustDeny(t, svc, "vw", "cluster_g", "pods", "read")
}

func TestAuthorize_ControlledClusterRead(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	if err := svc.AddGrant("vw", RoleNSViewer, "cluster_g:dev-ns"); err != nil {
		t.Fatal(err)
	}
	// cluster-level read of an aggregatable resource → allowed with visible NS list.
	ok, visible, err := svc.Authorize("vw", "cluster_g", "", "pods", "read")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !reflect.DeepEqual(visible, []string{"dev-ns"}) {
		t.Fatalf("expected allow with [dev-ns], got ok=%v visible=%v", ok, visible)
	}
	// non-aggregatable cluster-level resource → denied.
	ok, _, err = svc.Authorize("vw", "cluster_g", "", "nodes", "read")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected deny for nodes at cluster level")
	}
	// write is never aggregatable.
	ok, _, _ = svc.Authorize("vw", "cluster_g", "", "pods", "write")
	if ok {
		t.Fatal("expected deny for write")
	}
	// direct namespaced read where bound → normal allow, no visible list.
	ok, visible, _ = svc.Authorize("vw", "cluster_g", "dev-ns", "pods", "read")
	if !ok || visible != nil {
		t.Fatalf("expected normal allow, got ok=%v visible=%v", ok, visible)
	}
	// user with no grants at all → denied.
	ok, _, _ = svc.Authorize("ghost", "cluster_g", "", "pods", "read")
	if ok {
		t.Fatal("expected deny for ungranted user")
	}
}

// TestAuthorize_AdminBypass verifies that an is_admin user is allowed by
// Authorize without any casbin grant (mirroring the HTTP RBAC middleware),
// which is what the AI double-gate relies on for admin operators.
func TestAuthorize_AdminBypass(t *testing.T) {
	svc, db := newServiceWithNS(t, "")
	if err := db.Create(&model.User{Username: "root", IsAdmin: true}).Error; err != nil {
		t.Fatal(err)
	}
	var admin model.User
	if err := db.Where("username = ?", "root").First(&admin).Error; err != nil {
		t.Fatal(err)
	}
	adminID := strconv.FormatUint(uint64(admin.ID), 10)

	// No casbin grants exist for this user, yet admin is allowed everything.
	ok, visible, err := svc.Authorize(adminID, "any-cluster", "", "services", "read")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || visible != nil {
		t.Fatalf("expected admin allow with nil visible, got ok=%v visible=%v", ok, visible)
	}
	// Also allowed for a write action and namespaced request.
	if ok, _, _ := svc.Authorize(adminID, "any-cluster", "default", "namespaces", "read"); !ok {
		t.Fatal("expected admin allow for namespaces read")
	}
	if ok, _, _ := svc.Authorize(adminID, "any-cluster", "default", "deployments", "write"); !ok {
		t.Fatal("expected admin allow for write")
	}
	// A non-admin ghost user (no grants) is still denied.
	if ok, _, _ := svc.Authorize("99999", "any-cluster", "", "services", "read"); ok {
		t.Fatal("expected deny for non-admin ungranted user")
	}
}

// A role granting ONLY workloads read (namespace-scoped) must, at cluster level,
// allow aggregated pods read but be DENIED configmaps read — the controlled-read
// path filters visible namespaces to those where the user actually has read on the
// requested resource, closing the cluster-level privilege leak.
func TestAuthorize_ControlledReadFiltersByResourceGrant(t *testing.T) {
	svc, db := newServiceWithNS(t, "")
	ops, _ := json.Marshal(map[string][]string{"workloads": {"read"}})
	role := model.Role{Name: "wl-read"}
	if err := db.Create(&role).Error; err != nil {
		t.Fatal(err)
	}
	nsJSON, _ := json.Marshal([]string{"dev"})
	if err := db.Create(&model.RoleRule{RoleID: role.ID, ClusterID: "cluster_h", Scope: "namespace", Namespaces: string(nsJSON), Operations: string(ops)}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.UserRole{UserID: 77, RoleID: role.ID}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.SyncUserGrants(77); err != nil {
		t.Fatal(err)
	}
	// pods (workloads group) at cluster level → allowed, visible == [dev].
	ok, visible, err := svc.Authorize("77", "cluster_h", "", "pods", "read")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !reflect.DeepEqual(visible, []string{"dev"}) {
		t.Fatalf("expected pods allow with [dev], got ok=%v visible=%v", ok, visible)
	}
	// configmaps (config group) at cluster level → DENIED (no config read anywhere).
	ok, _, err = svc.Authorize("77", "cluster_h", "", "configmaps", "read")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected configmaps cluster-level read DENIED for workloads-only role (leak fix)")
	}
}

// A role WITH config read (namespace-scoped) must still read configmaps at cluster
// level via the controlled aggregation path — the leak fix must not over-restrict
// legitimate readers. visible == the namespaces where it holds config read.
func TestAuthorize_ControlledReadConfigReaderStillAllowed(t *testing.T) {
	svc, db := newServiceWithNS(t, "")
	ops, _ := json.Marshal(map[string][]string{"config": {"read"}})
	role := model.Role{Name: "cfg-read"}
	if err := db.Create(&role).Error; err != nil {
		t.Fatal(err)
	}
	nsJSON, _ := json.Marshal([]string{"dev", "prod"})
	if err := db.Create(&model.RoleRule{RoleID: role.ID, ClusterID: "cluster_h", Scope: "namespace", Namespaces: string(nsJSON), Operations: string(ops)}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.UserRole{UserID: 88, RoleID: role.ID}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.SyncUserGrants(88); err != nil {
		t.Fatal(err)
	}
	ok, visible, err := svc.Authorize("88", "cluster_h", "", "configmaps", "read")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(visible)
	if !ok || !reflect.DeepEqual(visible, []string{"dev", "prod"}) {
		t.Fatalf("config reader should read configmaps in [dev prod], got ok=%v visible=%v", ok, visible)
	}
}

// 未知资源(如 replicasets,不在内置 13 种)应按 customresources 授权判定;
// 内置资源(deployments)不借 customresources 授权。
func TestAuthorizeMapsUnknownToCustomResources(t *testing.T) {
	svc, _ := newServiceWithNS(t, "c1", "dev")
	// 非管理员 subject:DB 中无此用户 → isAdminUser 视为非 admin → 走 casbin。
	uid := "42"
	if err := svc.AddGrant(uid, "perm:test-cr", "c1:dev"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.enforcer.AddPolicy("perm:test-cr", "*", CustomResource, "read"); err != nil {
		t.Fatal(err)
	}

	// replicasets 非内置 → 映射到 customresources → 放行。
	ok, _, err := svc.Authorize(uid, "c1", "dev", "replicasets", "read")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatalf("未知资源 replicasets 应经 customresources 放行")
	}

	// deployments 内置 → 不走 customresources → 无 deployments 授权 → 拒绝。
	ok, _, err = svc.Authorize(uid, "c1", "dev", "deployments", "read")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("内置资源 deployments 不应借 customresources 授权放行")
	}
}

func TestListVisibleNamespaces(t *testing.T) {
	svc, _ := newServiceWithNS(t, "cluster_f", "default", "dev", "prod", "kube-system")
	// cluster-level role → all namespaces from the pool.
	if err := svc.AddGrant("admin", RoleClusterAdmin, "cluster_f"); err != nil {
		t.Fatal(err)
	}
	got, err := svc.ListVisibleNamespaces("admin", "cluster_f")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"default", "dev", "kube-system", "prod"}
	sort.Strings(got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cluster-level visible ns = %v want %v", got, want)
	}
	// ns-level role → only bound namespaces, no pool lookup.
	if err := svc.AddGrant("vw", RoleNSViewer, "cluster_f:dev"); err != nil {
		t.Fatal(err)
	}
	if err := svc.AddGrant("vw", RoleNSViewer, "cluster_f:prod"); err != nil {
		t.Fatal(err)
	}
	got, err = svc.ListVisibleNamespaces("vw", "cluster_f")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"dev", "prod"}) {
		t.Fatalf("ns-level visible = %v", got)
	}
}

func TestRemoveClusterPolicies(t *testing.T) {
	svc, db := newServiceWithNS(t, "")
	_ = svc.AddGrant("a", RoleClusterAdmin, "cluster_f")
	_ = svc.AddGrant("b", RoleNSViewer, "cluster_f:dev")
	_ = svc.AddGrant("c", RoleNSEditor, "cluster_f:prod")
	_ = svc.AddGrant("d", RoleClusterViewer, "cluster_g") // other cluster, must survive
	_ = svc.AddGrant("e", RoleNSViewer, "cluster_g:dev")

	if err := svc.RemoveClusterPolicies("cluster_f"); err != nil {
		t.Fatal(err)
	}
	var fCount int64
	db.Model(&model.CasbinRule{}).Where("ptype = ? AND (v2 = ? OR v2 LIKE ?)", "g", "cluster_f", "cluster_f:%").Count(&fCount)
	if fCount != 0 {
		t.Fatalf("expected all cluster_f g rows removed, got %d", fCount)
	}
	var gCount int64
	db.Model(&model.CasbinRule{}).Where("ptype = ? AND (v2 = ? OR v2 LIKE ?)", "g", "cluster_g", "cluster_g:%").Count(&gCount)
	if gCount != 2 {
		t.Fatalf("expected cluster_g g rows untouched (2), got %d", gCount)
	}
}

func TestRemoveUserGrants(t *testing.T) {
	svc, db := newServiceWithNS(t, "")
	_ = svc.AddGrant("u1", RoleClusterAdmin, "cluster_f")
	_ = svc.AddGrant("u1", RoleNSViewer, "cluster_g:dev")
	_ = svc.AddGrant("u2", RoleNSViewer, "cluster_g:dev")

	if err := svc.RemoveUserGrants("u1"); err != nil {
		t.Fatal(err)
	}
	var u1 int64
	db.Model(&model.CasbinRule{}).Where("ptype = ? AND v0 = ?", "g", "u1").Count(&u1)
	if u1 != 0 {
		t.Fatalf("expected u1 grants removed, got %d", u1)
	}
	var u2 int64
	db.Model(&model.CasbinRule{}).Where("ptype = ? AND v0 = ?", "g", "u2").Count(&u2)
	if u2 != 1 {
		t.Fatalf("expected u2 grant intact, got %d", u2)
	}
}

func TestListGrants(t *testing.T) {
	svc, _ := newServiceWithNS(t, "")
	_ = svc.AddGrant("u1", RoleClusterAdmin, "cluster_f")
	_ = svc.AddGrant("u1", RoleNSViewer, "cluster_g:dev")
	grants, err := svc.ListGrants("u1")
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 2 {
		t.Fatalf("expected 2 grants, got %d (%v)", len(grants), grants)
	}
	found := map[string]Grant{}
	for _, g := range grants {
		found[g.Role] = g
	}
	if g := found[RoleClusterAdmin]; g.ClusterID != "cluster_f" || g.Namespace != "" {
		t.Fatalf("bad cluster grant parse: %+v", g)
	}
	if g := found[RoleNSViewer]; g.ClusterID != "cluster_g" || g.Namespace != "dev" {
		t.Fatalf("bad ns grant parse: %+v", g)
	}
}
