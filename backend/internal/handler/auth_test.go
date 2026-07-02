package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/auth"
	"omnikube/internal/captcha"
	"omnikube/internal/cluster"
	"omnikube/internal/crypto"
	"omnikube/internal/database"
	"omnikube/internal/middleware"
	"omnikube/internal/model"
	"omnikube/internal/rbac"
)

func testApp(t *testing.T) (*gin.Engine, *Handler, *gorm.DB) {
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
	jm := auth.NewJWTManager("secret", time.Hour)
	pool := cluster.NewPool(db, ci, okBuilder)
	rbacSvc, err := rbac.NewService(db, pool)
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{DB: db, JWT: jm, Pool: pool, RBAC: rbacSvc}
	r := gin.New()
	r.POST("/login", h.Login)
	authed := r.Group("")
	authed.Use(middleware.JWTAuth(jm))
	authed.POST("/change-password", h.ChangePassword)
	authed.GET("/me", h.Me)
	return r, h, db
}

func seedUser(t *testing.T, db *gorm.DB, username, pwd string, mustReset bool) {
	hash, _ := auth.HashPassword(pwd)
	if err := db.Create(&model.User{Username: username, Password: hash, MustReset: mustReset}).Error; err != nil {
		t.Fatal(err)
	}
}

func doJSON(r *gin.Engine, method, path, token string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestLogin_Success(t *testing.T) {
	r, _, db := testApp(t)
	seedUser(t, db, "alice", "pw123456", true)
	w := doJSON(r, "POST", "/login", "", map[string]string{"username": "alice", "password": "pw123456"})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["token"] == nil || resp["must_reset"] != true {
		t.Fatalf("unexpected body: %v", resp)
	}
}

func TestLogin_WrongPassword(t *testing.T) {
	r, _, db := testApp(t)
	seedUser(t, db, "alice", "pw123456", false)
	w := doJSON(r, "POST", "/login", "", map[string]string{"username": "alice", "password": "bad"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestCaptcha_EndpointAndLoginGate(t *testing.T) {
	r, h, db := testApp(t)
	h.Captcha = captcha.NewStore() // enable captcha
	r.GET("/captcha", h.GetCaptcha)
	seedUser(t, db, "alice", "pw123456", false)

	// GET /captcha returns an id + a PNG data URL.
	cw := httptest.NewRecorder()
	creq, _ := http.NewRequest("GET", "/captcha", nil)
	r.ServeHTTP(cw, creq)
	var cap struct{ ID, Image string }
	json.Unmarshal(cw.Body.Bytes(), &cap)
	if cap.ID == "" || !strings.HasPrefix(cap.Image, "data:image/png;base64,") {
		t.Fatalf("unexpected captcha response: id=%q imgPrefix ok=%v", cap.ID, strings.HasPrefix(cap.Image, "data:image/png;base64,"))
	}

	// Login without/with a wrong captcha is rejected (400) before password check.
	w := doJSON(r, "POST", "/login", "", map[string]string{"username": "alice", "password": "pw123456"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("login without captcha must be 400, got %d", w.Code)
	}
	w = doJSON(r, "POST", "/login", "", map[string]string{
		"username": "alice", "password": "pw123456", "captcha_id": cap.ID, "captcha_code": "zzzz",
	})
	// "zzzz" can never equal a 4-digit code → deterministic 400.
	if w.Code != http.StatusBadRequest {
		t.Fatalf("login with wrong captcha must be 400, got %d", w.Code)
	}
}

func TestLogin_AuditsSuccessAndFailure(t *testing.T) {
	r, _, db := testApp(t)
	seedUser(t, db, "alice", "pw123456", false)

	doJSON(r, "POST", "/login", "", map[string]string{"username": "alice", "password": "pw123456"})
	doJSON(r, "POST", "/login", "", map[string]string{"username": "alice", "password": "bad"})

	var ok, fail int64
	db.Model(&model.AuditLog{}).Where("action = ? AND result = ?", "login", "success").Count(&ok)
	db.Model(&model.AuditLog{}).Where("action = ? AND result = ?", "login", "failed").Count(&fail)
	if ok != 1 || fail != 1 {
		t.Fatalf("expected 1 success + 1 failed login audit, got ok=%d fail=%d", ok, fail)
	}
}

func TestLogin_DisabledRejected(t *testing.T) {
	r, _, db := testApp(t)
	seedUser(t, db, "alice", "pw123456", false)
	db.Model(&model.User{}).Where("username = ?", "alice").Update("disabled", true)
	w := doJSON(r, "POST", "/login", "", map[string]string{"username": "alice", "password": "pw123456"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for disabled user, got %d", w.Code)
	}
	// 文案必须与防枚举一致。
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["message"] != "用户名或密码错误" {
		t.Fatalf("disabled login message must match generic 401, got %v", resp["message"])
	}
}

func TestChangePassword_Success(t *testing.T) {
	r, h, db := testApp(t)
	seedUser(t, db, "alice", "oldpw123", true)
	var u model.User
	db.Where("username = ?", "alice").First(&u)
	tok, _ := h.JWT.Issue(u.ID, false)
	w := doJSON(r, "POST", "/change-password", tok, map[string]string{"old_password": "oldpw123", "new_password": "newpw123"})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	db.Where("username = ?", "alice").First(&u)
	if u.MustReset {
		t.Fatal("must_reset should be cleared")
	}
	if !auth.VerifyPassword(u.Password, "newpw123") {
		t.Fatal("password not updated")
	}
}

func TestChangePassword_WrongOld(t *testing.T) {
	r, h, db := testApp(t)
	seedUser(t, db, "alice", "oldpw123", false)
	var u model.User
	db.Where("username = ?", "alice").First(&u)
	tok, _ := h.JWT.Issue(u.ID, false)
	w := doJSON(r, "POST", "/change-password", tok, map[string]string{"old_password": "WRONG", "new_password": "newpw123"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestMe(t *testing.T) {
	r, h, db := testApp(t)
	seedUser(t, db, "alice", "pw123456", false)
	var u model.User
	db.Where("username = ?", "alice").First(&u)
	tok, _ := h.JWT.Issue(u.ID, false)
	w := doJSON(r, "GET", "/me", tok, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["username"] != "alice" {
		t.Fatalf("unexpected: %v", resp)
	}
}

// meResp mirrors the v3 /me response shape: nav.submenus + global.
type meResp struct {
	Nav struct {
		Submenus []string `json:"submenus"`
	} `json:"nav"`
	Global map[string][]string `json:"global"`
}

func meOf(t *testing.T, w *httptest.ResponseRecorder) meResp {
	t.Helper()
	var resp meResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	return resp
}

func sliceHas(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// admin /me: nav.submenus == every resource submenu, and global covers
// clusters/users/roles/releases (clusters incl create/edit/delete, releases=[view]).
func TestMe_AdminNavAndGlobal(t *testing.T) {
	r, h, db := testApp(t)
	hash, _ := auth.HashPassword("pw123456")
	db.Create(&model.User{Username: "root", Password: hash, IsAdmin: true})
	var u model.User
	db.Where("username = ?", "root").First(&u)
	tok, _ := h.JWT.Issue(u.ID, true)
	w := doJSON(r, "GET", "/me", tok, nil)
	got := meOf(t, w)
	if len(got.Nav.Submenus) != len(rbac.AllResources) {
		t.Fatalf("admin nav.submenus should equal all resources (%d), got %d: %v",
			len(rbac.AllResources), len(got.Nav.Submenus), got.Nav.Submenus)
	}
	for _, area := range []string{"clusters", "users", "roles", "releases"} {
		if _, ok := got.Global[area]; !ok {
			t.Fatalf("admin global must include %q area, got %v", area, got.Global)
		}
	}
	for _, act := range []string{"create", "edit", "delete"} {
		if !sliceHas(got.Global["clusters"], act) {
			t.Fatalf("admin global.clusters must include %q, got %v", act, got.Global["clusters"])
		}
	}
	if len(got.Global["releases"]) != 1 || got.Global["releases"][0] != "view" {
		t.Fatalf("admin global.releases should be [view], got %v", got.Global["releases"])
	}
}

// seedRoleWithOps creates a role whose single cluster:* rule grants the given operations,
// then binds it to the user. nav.submenus is derived from these on /me.
func seedRoleWithOps(t *testing.T, db *gorm.DB, userID uint, name string, ops map[string][]string) {
	t.Helper()
	opsJSON, _ := json.Marshal(ops)
	role := model.Role{Name: name}
	if err := db.Create(&role).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.RoleRule{RoleID: role.ID, ClusterID: "*", Scope: "cluster", Operations: string(opsJSON)}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.UserRole{UserID: userID, RoleID: role.ID}).Error; err != nil {
		t.Fatal(err)
	}
}

// A non-admin whose role grants {"deployments":["view"],"pods":["exec"]} sees
// deployments in nav.submenus (has view) but NOT pods (no view) nor services.
func TestMe_NonAdminVisibleSubmenus(t *testing.T) {
	r, h, db := testApp(t)
	seedUser(t, db, "alice", "pw123456", false)
	var u model.User
	db.Where("username = ?", "alice").First(&u)
	seedRoleWithOps(t, db, u.ID, "dep-view", map[string][]string{
		"deployments": {"view"}, "pods": {"exec"},
	})
	tok, _ := h.JWT.Issue(u.ID, false)
	w := doJSON(r, "GET", "/me", tok, nil)
	got := meOf(t, w)
	if !sliceHas(got.Nav.Submenus, "deployments") {
		t.Fatalf("expected deployments in nav.submenus, got %v", got.Nav.Submenus)
	}
	if sliceHas(got.Nav.Submenus, "pods") {
		t.Fatalf("pods has no view grant, must NOT appear, got %v", got.Nav.Submenus)
	}
	if sliceHas(got.Nav.Submenus, "services") {
		t.Fatalf("services not granted, must NOT appear, got %v", got.Nav.Submenus)
	}
}

// A non-admin whose role has GlobalPerms {"users":["view"]} → /me global.users contains view.
func TestMe_NonAdminGlobalPerms(t *testing.T) {
	r, h, db := testApp(t)
	seedUser(t, db, "bob", "pw123456", false)
	var u model.User
	db.Where("username = ?", "bob").First(&u)
	role := model.Role{Name: "user-viewer", GlobalPerms: `{"users":["view"]}`}
	db.Create(&role)
	db.Create(&model.UserRole{UserID: u.ID, RoleID: role.ID})
	tok, _ := h.JWT.Issue(u.ID, false)
	w := doJSON(r, "GET", "/me", tok, nil)
	got := meOf(t, w)
	if !sliceHas(got.Global["users"], "view") {
		t.Fatalf("expected global.users to contain view, got %v", got.Global)
	}
}
