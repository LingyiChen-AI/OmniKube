package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/auth"
	"omnikube/internal/cluster"
	"omnikube/internal/crypto"
	"omnikube/internal/database"
	"omnikube/internal/middleware"
	"omnikube/internal/model"
	"omnikube/internal/rbac"
)

// adminApp wires the user + grant admin APIs with a header-controlled admin guard
// (reuses doReq's X-Admin header from cluster_test.go).
func adminApp(t *testing.T) (*gin.Engine, *gorm.DB, *Handler) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	ci, err := crypto.New(clusterKey())
	if err != nil {
		t.Fatal(err)
	}
	jm := auth.NewJWTManager("secret", 0)
	pool := cluster.NewPool(db, ci, okBuilder)
	rbacSvc, err := rbac.NewService(db, pool)
	if err != nil {
		t.Fatal(err)
	}
	pool.OnDelete = rbacSvc.RemoveClusterPolicies
	h := &Handler{DB: db, JWT: jm, Pool: pool, RBAC: rbacSvc}

	r := gin.New()
	grp := r.Group("/api/v1")
	grp.Use(func(c *gin.Context) {
		if c.GetHeader("X-Admin") == "false" {
			c.Set("is_admin", false)
		} else {
			c.Set("is_admin", true)
		}
		c.Next()
	}, middleware.RequireAdmin())
	{
		grp.POST("/users", h.CreateUser)
		grp.GET("/users", h.ListUsers)
		grp.PUT("/users/:id/disable", h.DisableUser)
		grp.PUT("/users/:id/enable", h.EnableUser)
		grp.PUT("/users/:id/roles", h.SetUserRoles)
		grp.POST("/users/:id/reset-password", h.ResetUserPassword)
		grp.DELETE("/users/:id", h.DeleteUser)

		grp.POST("/roles", h.CreateRole)
		grp.GET("/roles", h.ListRoles)
		grp.GET("/roles/:id", h.GetRole)
		grp.PUT("/roles/:id", h.UpdateRole)
		grp.DELETE("/roles/:id", h.DeleteRole)

		grp.DELETE("/clusters/:id", h.DeleteCluster)
	}
	return r, db, h
}

func TestCreateUser_ReturnsTempPasswordOnce(t *testing.T) {
	r, db, _ := adminApp(t)
	w := doReq(r, "POST", "/api/v1/users", map[string]string{"username": "bob"}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	pwd, _ := resp["temp_password"].(string)
	if pwd == "" {
		t.Fatal("expected temp_password returned once")
	}
	if resp["must_reset"] != true {
		t.Fatal("expected must_reset true")
	}
	var u model.User
	db.Where("username = ?", "bob").First(&u)
	if u.IsAdmin {
		t.Fatal("created user must not be admin")
	}
	if !u.MustReset {
		t.Fatal("created user must have MustReset")
	}
	// stored password is a bcrypt hash of the returned temp password, never plaintext.
	if u.Password == pwd {
		t.Fatal("password must be hashed at rest")
	}
	if !auth.VerifyPassword(u.Password, pwd) {
		t.Fatal("temp password must verify against hash")
	}
}

func TestResetUserPassword(t *testing.T) {
	r, db, _ := adminApp(t)
	// create a normal user, capture its initial hash
	doReq(r, "POST", "/api/v1/users", map[string]string{"username": "bob"}, true)
	var before model.User
	db.Where("username = ?", "bob").First(&before)

	w := doReq(r, "POST", "/api/v1/users/"+strconv.FormatUint(uint64(before.ID), 10)+"/reset-password", nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	pwd, _ := resp["temp_password"].(string)
	if pwd == "" {
		t.Fatal("expected a new temp_password returned")
	}
	if resp["must_reset"] != true {
		t.Fatal("expected must_reset true after reset")
	}
	var after model.User
	db.Where("username = ?", "bob").First(&after)
	if after.Password == before.Password {
		t.Fatal("password hash must change after reset")
	}
	if !after.MustReset {
		t.Fatal("reset user must have MustReset")
	}
	if !auth.VerifyPassword(after.Password, pwd) {
		t.Fatal("new temp password must verify against the stored hash")
	}
}

func TestResetUserPassword_RejectsAdmin(t *testing.T) {
	r, db, _ := adminApp(t)
	admin := model.User{Username: "root", Password: "x", IsAdmin: true}
	db.Create(&admin)
	w := doReq(r, "POST", "/api/v1/users/"+strconv.FormatUint(uint64(admin.ID), 10)+"/reset-password", nil, true)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 resetting an admin, got %d", w.Code)
	}
}

func TestCreateUser_DuplicateUsername(t *testing.T) {
	r, _, _ := adminApp(t)
	doReq(r, "POST", "/api/v1/users", map[string]string{"username": "bob"}, true)
	w := doReq(r, "POST", "/api/v1/users", map[string]string{"username": "bob"}, true)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", w.Code)
	}
}

func TestListUsers_NoPasswordHash(t *testing.T) {
	r, db, _ := adminApp(t)
	hash, _ := auth.HashPassword("secretpw")
	db.Create(&model.User{Username: "carol", Password: hash})
	w := doReq(r, "GET", "/api/v1/users", nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	body := w.Body.String()
	if contains(body, hash) || contains(body, "password") {
		t.Fatalf("list must not expose password: %s", body)
	}
	if !contains(body, "carol") {
		t.Fatalf("expected user in list: %s", body)
	}
}

func TestDisableEnableUser(t *testing.T) {
	r, db, _ := adminApp(t)
	hash, _ := auth.HashPassword("pw")
	u := model.User{Username: "dave", Password: hash}
	db.Create(&u)
	idPath := "/api/v1/users/" + strconv.FormatUint(uint64(u.ID), 10)

	w := doReq(r, "PUT", idPath+"/disable", nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("disable expected 200, got %d", w.Code)
	}
	db.First(&u, u.ID)
	if !u.Disabled {
		t.Fatal("expected disabled true")
	}
	w = doReq(r, "PUT", idPath+"/enable", nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("enable expected 200, got %d", w.Code)
	}
	db.First(&u, u.ID)
	if u.Disabled {
		t.Fatal("expected disabled false")
	}
}

func TestDeleteUser_CascadesGrants(t *testing.T) {
	r, db, h := adminApp(t)
	hash, _ := auth.HashPassword("pw")
	u := model.User{Username: "erin", Password: hash}
	db.Create(&u)
	db.Create(&model.Cluster{ID: "cluster_f", Name: "F", Kubeconfig: "x", Status: "Healthy"})
	uid := strconv.FormatUint(uint64(u.ID), 10)
	if err := h.RBAC.AddGrant(uid, rbac.RoleNSViewer, "cluster_f:dev"); err != nil {
		t.Fatal(err)
	}
	w := doReq(r, "DELETE", "/api/v1/users/"+uid, nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var nUser int64
	db.Model(&model.User{}).Where("id = ?", u.ID).Count(&nUser)
	if nUser != 0 {
		t.Fatal("user not deleted")
	}
	var nGrant int64
	db.Model(&model.CasbinRule{}).Where("ptype = ? AND v0 = ?", "g", uid).Count(&nGrant)
	if nGrant != 0 {
		t.Fatalf("expected grants cascaded, got %d", nGrant)
	}
}

func TestUser_NonAdminForbidden(t *testing.T) {
	r, _, _ := adminApp(t)
	w := doReq(r, "GET", "/api/v1/users", nil, false)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
}

// opsForLevel maps a legacy level constant to an equivalent operations JSON string.
func opsForLevel(level string) string {
	var ops map[string][]string
	switch level {
	case rbac.RoleClusterViewer, rbac.RoleNSViewer:
		ops = map[string][]string{"workloads": {"read"}, "network": {"read"}, "config": {"read"}, "cluster": {"read"}}
	default: // admin / editor: full
		ops = map[string][]string{
			"workloads": {"read", "write", "delete", "exec"},
			"network":   {"read", "write", "delete"},
			"config":    {"read", "write", "delete", "reveal"},
			"cluster":   {"read", "write", "delete"},
		}
	}
	b, _ := json.Marshal(ops)
	return string(b)
}

// helper: create a cluster-scope role directly in DB and return its id.
func seedClusterRole(t *testing.T, db *gorm.DB, name, clusterID, level string) uint {
	t.Helper()
	role := model.Role{Name: name}
	db.Create(&role)
	db.Create(&model.RoleRule{RoleID: role.ID, ClusterID: clusterID, Scope: "cluster", Operations: opsForLevel(level)})
	return role.ID
}

func TestCreateUser_WithRoleIDs_SyncsGrants(t *testing.T) {
	r, db, h := adminApp(t)
	db.Create(&model.Cluster{ID: "cluster_f", Name: "F", Kubeconfig: "x", Status: "Healthy"})
	rid := seedClusterRole(t, db, "ops", "cluster_f", rbac.RoleClusterAdmin)
	w := doReq(r, "POST", "/api/v1/users", map[string]any{"username": "bob", "role_ids": []uint{rid}}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["temp_password"] == "" {
		t.Fatal("expected temp password")
	}
	var u model.User
	db.Where("username = ?", "bob").First(&u)
	var nUR int64
	db.Model(&model.UserRole{}).Where("user_id = ?", u.ID).Count(&nUR)
	if nUR != 1 {
		t.Fatalf("expected 1 user_role, got %d", nUR)
	}
	sid := strconv.FormatUint(uint64(u.ID), 10)
	if ok, _, _ := h.RBAC.Authorize(sid, "cluster_f", "", "pods", "write"); !ok {
		t.Fatal("expected materialized grant to allow write")
	}
}

func TestCreateUser_InvalidRoleID(t *testing.T) {
	r, _, _ := adminApp(t)
	w := doReq(r, "POST", "/api/v1/users", map[string]any{"username": "bob", "role_ids": []uint{999}}, true)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid role id, got %d", w.Code)
	}
}

func TestListUsers_IncludesRoles(t *testing.T) {
	r, db, _ := adminApp(t)
	db.Create(&model.Cluster{ID: "cluster_f", Name: "F", Kubeconfig: "x", Status: "Healthy"})
	rid := seedClusterRole(t, db, "ops", "cluster_f", rbac.RoleClusterAdmin)
	doReq(r, "POST", "/api/v1/users", map[string]any{"username": "bob", "role_ids": []uint{rid}}, true)
	w := doReq(r, "GET", "/api/v1/users", nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp struct {
		Users []userView `json:"users"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	var found bool
	for _, u := range resp.Users {
		if u.Username == "bob" {
			found = true
			if len(u.Roles) != 1 || u.Roles[0].Name != "ops" {
				t.Fatalf("expected bob with role ops, got %+v", u.Roles)
			}
		}
	}
	if !found {
		t.Fatal("bob not in list")
	}
}

func TestSetUserRoles_ReplacesAndSyncs(t *testing.T) {
	r, db, h := adminApp(t)
	db.Create(&model.Cluster{ID: "cluster_f", Name: "F", Kubeconfig: "x", Status: "Healthy"})
	db.Create(&model.Cluster{ID: "cluster_g", Name: "G", Kubeconfig: "x", Status: "Healthy"})
	r1 := seedClusterRole(t, db, "adm-f", "cluster_f", rbac.RoleClusterAdmin)
	r2 := seedClusterRole(t, db, "view-g", "cluster_g", rbac.RoleClusterViewer)
	hash, _ := auth.HashPassword("pw")
	u := model.User{Username: "carl", Password: hash}
	db.Create(&u)
	db.Create(&model.UserRole{UserID: u.ID, RoleID: r1})
	h.RBAC.SyncUserGrants(u.ID)
	sid := strconv.FormatUint(uint64(u.ID), 10)
	idPath := "/api/v1/users/" + sid + "/roles"

	w := doReq(r, "PUT", idPath, map[string]any{"role_ids": []uint{r2}}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if ok, _, _ := h.RBAC.Authorize(sid, "cluster_f", "", "pods", "write"); ok {
		t.Fatal("expected cluster_f access removed")
	}
	if ok, _, _ := h.RBAC.Authorize(sid, "cluster_g", "", "pods", "read"); !ok {
		t.Fatal("expected cluster_g read added")
	}
	var nUR int64
	db.Model(&model.UserRole{}).Where("user_id = ?", u.ID).Count(&nUR)
	if nUR != 1 {
		t.Fatalf("expected role set replaced to 1, got %d", nUR)
	}
}

func TestDeleteUser_CascadesUserRoles(t *testing.T) {
	r, db, h := adminApp(t)
	db.Create(&model.Cluster{ID: "cluster_f", Name: "F", Kubeconfig: "x", Status: "Healthy"})
	rid := seedClusterRole(t, db, "ops", "cluster_f", rbac.RoleClusterAdmin)
	hash, _ := auth.HashPassword("pw")
	u := model.User{Username: "dan", Password: hash}
	db.Create(&u)
	db.Create(&model.UserRole{UserID: u.ID, RoleID: rid})
	h.RBAC.SyncUserGrants(u.ID)
	sid := strconv.FormatUint(uint64(u.ID), 10)
	w := doReq(r, "DELETE", "/api/v1/users/"+sid, nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var nUR, nG int64
	db.Model(&model.UserRole{}).Where("user_id = ?", u.ID).Count(&nUR)
	db.Model(&model.CasbinRule{}).Where("ptype = ? AND v0 = ?", "g", sid).Count(&nG)
	if nUR != 0 || nG != 0 {
		t.Fatalf("expected user_roles and grants cleared, got ur=%d g=%d", nUR, nG)
	}
}

func TestDeleteCluster_CascadeRoleRulesAndResync(t *testing.T) {
	r, db, h := adminApp(t)
	db.Create(&model.Cluster{ID: "cluster_f", Name: "F", Kubeconfig: "x", Status: "Healthy"})
	db.Create(&model.Cluster{ID: "cluster_g", Name: "G", Kubeconfig: "x", Status: "Healthy"})
	// role with rules on both clusters
	var role model.Role
	db.Create(&role)
	db.Model(&role).Update("name", "multi")
	db.Create(&model.RoleRule{RoleID: role.ID, ClusterID: "cluster_f", Scope: "cluster", Operations: opsForLevel(rbac.RoleClusterAdmin)})
	db.Create(&model.RoleRule{RoleID: role.ID, ClusterID: "cluster_g", Scope: "cluster", Operations: opsForLevel(rbac.RoleClusterViewer)})
	hash, _ := auth.HashPassword("pw")
	u := model.User{Username: "eve", Password: hash}
	db.Create(&u)
	db.Create(&model.UserRole{UserID: u.ID, RoleID: role.ID})
	h.RBAC.SyncUserGrants(u.ID)
	sid := strconv.FormatUint(uint64(u.ID), 10)

	w := doReq(r, "DELETE", "/api/v1/clusters/cluster_f", nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var nRule int64
	db.Model(&model.RoleRule{}).Where("cluster_id = ?", "cluster_f").Count(&nRule)
	if nRule != 0 {
		t.Fatalf("expected cluster_f role_rules pruned, got %d", nRule)
	}
	if ok, _, _ := h.RBAC.Authorize(sid, "cluster_f", "", "pods", "read"); ok {
		t.Fatal("expected cluster_f access removed")
	}
	if ok, _, _ := h.RBAC.Authorize(sid, "cluster_g", "", "pods", "read"); !ok {
		t.Fatal("expected cluster_g access retained")
	}
}

// TestGlobalPermCheck verifies the route-middleware gate closure: a non-admin
// user whose role grants users:["view"] passes (users,view) but not (roles,view)
// nor (users,delete). admin bypass is handled in the middleware, not here.
func TestGlobalPermCheck(t *testing.T) {
	_, db, h := adminApp(t)
	hash, _ := auth.HashPassword("pw123456")
	u := model.User{Username: "viewer", Password: hash, IsAdmin: false}
	if err := db.Create(&u).Error; err != nil {
		t.Fatal(err)
	}
	role := model.Role{Name: "user-viewer", GlobalPerms: `{"users":["view"]}`}
	if err := db.Create(&role).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.UserRole{UserID: u.ID, RoleID: role.ID}).Error; err != nil {
		t.Fatal(err)
	}

	if !h.GlobalPermCheck(u.ID, "users", "view") {
		t.Fatal("expected users:view granted")
	}
	if h.GlobalPermCheck(u.ID, "roles", "view") {
		t.Fatal("expected roles:view denied")
	}
	if h.GlobalPermCheck(u.ID, "users", "delete") {
		t.Fatal("expected users:delete denied")
	}
}
