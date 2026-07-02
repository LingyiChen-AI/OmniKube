package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	fakeclientset "k8s.io/client-go/kubernetes/fake"

	"omnikube/internal/auth"
	"omnikube/internal/cluster"
	"omnikube/internal/crypto"
	"omnikube/internal/database"
	"omnikube/internal/middleware"
	"omnikube/internal/model"
)

// doReq issues a request to the cluster API; admin=false sets X-Admin: false
// so RequireAdmin rejects it.
func doReq(r *gin.Engine, method, path string, body any, admin bool) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if !admin {
		req.Header.Set("X-Admin", "false")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func clusterKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i + 7)
	}
	return k
}

// okBuilder returns a client whose Ping succeeds (fake clientset discovery).
func okBuilder(kubeconfig string) (*cluster.ClusterClient, error) {
	return &cluster.ClusterClient{Discovery: fakeclientset.NewSimpleClientset().Discovery()}, nil
}

func failBuilder(kubeconfig string) (*cluster.ClusterClient, error) {
	return nil, errors.New("connection refused")
}

func clusterApp(t *testing.T, build cluster.ClientBuilder) (*gin.Engine, *gorm.DB, *Handler) {
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
	pool := cluster.NewPool(db, ci, build)
	h := &Handler{DB: db, JWT: jm, Pool: pool}

	r := gin.New()
	// inject is_admin via a tiny middleware controlled by header for tests
	grp := r.Group("/api/v1/clusters")
	grp.Use(func(c *gin.Context) {
		if c.GetHeader("X-Admin") == "false" {
			c.Set("is_admin", false)
		} else {
			c.Set("is_admin", true)
		}
		c.Next()
	}, middleware.RequireAdmin())
	{
		grp.POST("", h.CreateCluster)
		grp.GET("", h.ListClusters)
		grp.DELETE("/:id", h.DeleteCluster)
		grp.PUT("/:id", h.UpdateCluster)
		grp.POST("/test", h.TestCluster)
	}
	return r, db, h
}

func TestCreateCluster_Success(t *testing.T) {
	r, db, _ := clusterApp(t, okBuilder)
	w := doReq(r, "POST", "/api/v1/clusters", map[string]string{"id": "prod", "name": "Prod", "kubeconfig": "kc"}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var n int64
	db.Model(&model.Cluster{}).Count(&n)
	if n != 1 {
		t.Fatalf("expected 1 row, got %d", n)
	}
}

func TestCreateCluster_ConnFail(t *testing.T) {
	r, db, _ := clusterApp(t, failBuilder)
	w := doReq(r, "POST", "/api/v1/clusters", map[string]string{"id": "prod", "name": "Prod", "kubeconfig": "kc"}, true)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	var n int64
	db.Model(&model.Cluster{}).Count(&n)
	if n != 0 {
		t.Fatalf("expected 0 rows, got %d", n)
	}
}

func TestCreateCluster_Duplicate(t *testing.T) {
	r, _, _ := clusterApp(t, okBuilder)
	doReq(r, "POST", "/api/v1/clusters", map[string]string{"id": "prod", "name": "Prod", "kubeconfig": "kc"}, true)
	w := doReq(r, "POST", "/api/v1/clusters", map[string]string{"id": "prod", "name": "Prod2", "kubeconfig": "kc2"}, true)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", w.Code)
	}
}

func TestListClusters_NoKubeconfig(t *testing.T) {
	r, db, _ := clusterApp(t, okBuilder)
	db.Create(&model.Cluster{ID: "a", Name: "A", Kubeconfig: "secret-cipher", Status: "Healthy"})
	w := doReq(r, "GET", "/api/v1/clusters", nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	body := w.Body.String()
	if contains(body, "secret-cipher") || contains(body, "kubeconfig") {
		t.Fatalf("list must not expose kubeconfig: %s", body)
	}
	if !contains(body, "Healthy") {
		t.Fatalf("expected status in list: %s", body)
	}
}

func TestDeleteCluster_Success(t *testing.T) {
	r, db, _ := clusterApp(t, okBuilder)
	doReq(r, "POST", "/api/v1/clusters", map[string]string{"id": "prod", "name": "Prod", "kubeconfig": "kc"}, true)
	w := doReq(r, "DELETE", "/api/v1/clusters/prod", nil, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var n int64
	db.Model(&model.Cluster{}).Count(&n)
	if n != 0 {
		t.Fatalf("expected deleted, got %d", n)
	}
}

func TestDeleteCluster_NotFound(t *testing.T) {
	r, _, _ := clusterApp(t, okBuilder)
	w := doReq(r, "DELETE", "/api/v1/clusters/nope", nil, true)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestUpdateCluster_RenameAndRekey(t *testing.T) {
	r, db, h := clusterApp(t, okBuilder)
	doReq(r, "POST", "/api/v1/clusters", map[string]string{"id": "prod", "name": "Prod", "kubeconfig": "kc"}, true)
	w := doReq(r, "PUT", "/api/v1/clusters/prod", map[string]string{"name": "Prod2", "kubeconfig": "kc-new"}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var cl model.Cluster
	db.First(&cl, "id = ?", "prod")
	if cl.Name != "Prod2" {
		t.Fatalf("expected renamed, got %q", cl.Name)
	}
	// kubeconfig should re-encrypt to new plaintext
	ci, _ := crypto.New(clusterKey())
	dec, _ := ci.Decrypt(cl.Kubeconfig)
	if dec != "kc-new" {
		t.Fatalf("expected re-encrypted kc-new, got %q", dec)
	}
	_ = h
}

func TestTestCluster_Success(t *testing.T) {
	r, db, _ := clusterApp(t, okBuilder)
	w := doReq(r, "POST", "/api/v1/clusters/test", map[string]string{"kubeconfig": "kc"}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var n int64
	db.Model(&model.Cluster{}).Count(&n)
	if n != 0 {
		t.Fatalf("test must not persist, got %d", n)
	}
}

func TestTestCluster_Fail(t *testing.T) {
	r, _, _ := clusterApp(t, failBuilder)
	w := doReq(r, "POST", "/api/v1/clusters/test", map[string]string{"kubeconfig": "kc"}, true)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestCluster_NonAdminForbidden(t *testing.T) {
	r, _, _ := clusterApp(t, okBuilder)
	w := doReq(r, "GET", "/api/v1/clusters", nil, false)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }
