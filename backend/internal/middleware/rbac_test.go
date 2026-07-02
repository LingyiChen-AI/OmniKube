package middleware

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime/schema"
	fakeclientset "k8s.io/client-go/kubernetes/fake"

	"omnikube/internal/cluster"
	"omnikube/internal/crypto"
	"omnikube/internal/database"
	"omnikube/internal/model"
	"omnikube/internal/rbac"
)

func rbacKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i + 11)
	}
	return k
}

// testRESTMapper registers pods/secrets (namespaced) and nodes (cluster-scoped).
func testRESTMapper() meta.RESTMapper {
	m := meta.NewDefaultRESTMapper([]schema.GroupVersion{{Group: "", Version: "v1"}})
	m.Add(schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"}, meta.RESTScopeNamespace)
	m.Add(schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Secret"}, meta.RESTScopeNamespace)
	m.Add(schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Node"}, meta.RESTScopeRoot)
	return m
}

// rbacMwApp wires JWT-like injector + RBACAuthMiddleware + an echo terminal handler.
func rbacMwApp(t *testing.T, clusterID string) (*gin.Engine, *gorm.DB, *rbac.Service) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	ci, err := crypto.New(rbacKey())
	if err != nil {
		t.Fatal(err)
	}
	pool := cluster.NewPool(db, ci, func(string) (*cluster.ClusterClient, error) { return &cluster.ClusterClient{}, nil })
	pool.Set(clusterID, &cluster.ClusterClient{
		RESTMapper: testRESTMapper(),
		Typed:      fakeclientset.NewSimpleClientset(),
	})
	svc, err := rbac.NewService(db, pool)
	if err != nil {
		t.Fatal(err)
	}

	r := gin.New()
	api := r.Group("/api/v1")
	// inject user_id/is_admin from test headers, mimicking JWTAuth.
	api.Use(func(c *gin.Context) {
		if v := c.GetHeader("X-Test-Uid"); v != "" {
			id, _ := strconv.ParseUint(v, 10, 64)
			c.Set("user_id", uint(id))
		}
		c.Set("is_admin", c.GetHeader("X-Test-Admin") == "true")
		c.Next()
	})
	echo := func(c *gin.Context) {
		var visible []string
		if v, ok := c.Get("visible_ns"); ok {
			visible, _ = v.([]string)
		}
		c.JSON(http.StatusOK, gin.H{
			"auth_namespace": c.GetString("auth_namespace"),
			"auth_resource":  c.GetString("auth_resource"),
			"visible_ns":     visible,
		})
	}
	res := api.Group("")
	res.Use(RBACAuthMiddleware(pool, svc, db))
	res.GET("/resources/:resource", echo)
	res.GET("/namespaces/:namespace/resources/:resource/:name", echo)
	res.POST("/namespaces/:namespace/resources/:resource", echo)
	res.PUT("/namespaces/:namespace/resources/:resource/:name", echo)
	res.DELETE("/namespaces/:namespace/resources/:resource/:name", echo)
	res.POST("/resources/:resource", echo)
	return r, db, svc
}

func mwReq(r *gin.Engine, method, path, clusterID, uid string, admin bool, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if clusterID != "" {
		req.Header.Set("X-Cluster-ID", clusterID)
	}
	if uid != "" {
		req.Header.Set("X-Test-Uid", uid)
	}
	if admin {
		req.Header.Set("X-Test-Admin", "true")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func parseBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("bad json: %s", w.Body.String())
	}
	return m
}

// Invariant #1: write op namespace comes ONLY from :namespace path segment,
// never from query or body.
func TestRBAC_NamespaceSingleSourceOfTruth(t *testing.T) {
	r, _, svc := rbacMwApp(t, "c1")
	if err := svc.AddGrant("5", rbac.RoleNSEditor, "c1:dev"); err != nil {
		t.Fatal(err)
	}
	// path=dev, query=prod, body namespace=prod → auth_namespace MUST be dev.
	body := map[string]any{"metadata": map[string]any{"namespace": "prod"}}
	w := mwReq(r, "POST", "/api/v1/namespaces/dev/resources/pods?namespace=prod", "c1", "5", false, body)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 allow, got %d (%s)", w.Code, w.Body.String())
	}
	if got := parseBody(t, w)["auth_namespace"]; got != "dev" {
		t.Fatalf("auth_namespace must be dev (path), got %v", got)
	}
}

// Invariant #2: controlled cluster-level read injects visible_ns; non-aggregatable
// cluster resource (nodes) is denied.
func TestRBAC_ControlledClusterLevelRead(t *testing.T) {
	r, _, svc := rbacMwApp(t, "c1")
	if err := svc.AddGrant("7", rbac.RoleNSViewer, "c1:dev"); err != nil {
		t.Fatal(err)
	}
	// cluster-wide pods list → allowed with visible_ns == [dev].
	w := mwReq(r, "GET", "/api/v1/resources/pods", "c1", "7", false, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	vis, _ := parseBody(t, w)["visible_ns"].([]any)
	if len(vis) != 1 || vis[0] != "dev" {
		t.Fatalf("expected visible_ns [dev], got %v", parseBody(t, w)["visible_ns"])
	}
	// cluster-scoped nodes → 403.
	w = mwReq(r, "GET", "/api/v1/resources/nodes", "c1", "7", false, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for nodes, got %d", w.Code)
	}
}

func TestRBAC_AdminBypass(t *testing.T) {
	r, _, _ := rbacMwApp(t, "c1")
	// admin with no grants still passes (and namespace single-source still applies).
	w := mwReq(r, "POST", "/api/v1/namespaces/dev/resources/pods", "c1", "1", true, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("admin expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if got := parseBody(t, w)["auth_namespace"]; got != "dev" {
		t.Fatalf("admin auth_namespace must be dev, got %v", got)
	}
}

func TestRBAC_MissingClusterID(t *testing.T) {
	r, _, _ := rbacMwApp(t, "c1")
	w := mwReq(r, "GET", "/api/v1/resources/pods", "", "1", true, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing X-Cluster-ID, got %d", w.Code)
	}
	w = mwReq(r, "GET", "/api/v1/resources/pods", "nope", "1", true, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown cluster, got %d", w.Code)
	}
}

func TestRBAC_UnknownResource(t *testing.T) {
	r, _, svc := rbacMwApp(t, "c1")
	_ = svc.AddGrant("9", rbac.RoleClusterAdmin, "c1")
	w := mwReq(r, "GET", "/api/v1/resources/widgets", "c1", "9", false, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown resource, got %d", w.Code)
	}
}

// A write-but-not-create role must be DENIED resource creation (POST→create) yet
// ALLOWED updates (PUT→write). This is the "能改不能建" separation.
func TestRBAC_CreateSeparateFromWrite(t *testing.T) {
	r, db, svc := rbacMwApp(t, "c1")
	// Custom role: read/write/delete on workloads, but NO create.
	role := model.Role{Name: "editor-no-create", Description: "edit but not create"}
	if err := db.Create(&role).Error; err != nil {
		t.Fatal(err)
	}
	ops, _ := json.Marshal(map[string][]string{"workloads": {"read", "write", "delete"}})
	if err := db.Create(&model.RoleRule{RoleID: role.ID, ClusterID: "c1", Scope: "cluster", Operations: string(ops)}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.UserRole{UserID: 21, RoleID: role.ID}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.SyncUserGrants(21); err != nil {
		t.Fatal(err)
	}

	// POST → create: the write grant does NOT cover creation → 403.
	w := mwReq(r, "POST", "/api/v1/namespaces/dev/resources/pods", "c1", "21", false, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("write-only role must be DENIED creation (POST→create), got %d (%s)", w.Code, w.Body.String())
	}
	// PUT → write: update is allowed by the write grant → 200.
	w = mwReq(r, "PUT", "/api/v1/namespaces/dev/resources/pods/p1", "c1", "21", false, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("write role must be ALLOWED update (PUT→write), got %d (%s)", w.Code, w.Body.String())
	}
}

// Denials abort with 403. Audit of the denial is now the outer middleware.Audit's
// job (403→"denied"), verified in the middleware audit tests, not here.
func TestRBAC_DenyForbidden(t *testing.T) {
	r, _, _ := rbacMwApp(t, "c1")
	// user 13 has no grants → 403.
	w := mwReq(r, "GET", "/api/v1/namespaces/dev/resources/pods/p1", "c1", "13", false, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
}
