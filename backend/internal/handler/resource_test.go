package handler

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
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	fakeclientset "k8s.io/client-go/kubernetes/fake"

	"omnikube/internal/auth"
	"omnikube/internal/cluster"
	"omnikube/internal/crypto"
	"omnikube/internal/database"
	"omnikube/internal/middleware"
	"omnikube/internal/rbac"
)

func resKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i + 13)
	}
	return k
}

func resMapper() meta.RESTMapper {
	m := meta.NewDefaultRESTMapper([]schema.GroupVersion{{Group: "", Version: "v1"}})
	m.Add(schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"}, meta.RESTScopeNamespace)
	m.Add(schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Secret"}, meta.RESTScopeNamespace)
	m.Add(schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Node"}, meta.RESTScopeRoot)
	m.Add(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"}, meta.RESTScopeNamespace)
	return m
}

func pod(ns, name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "Pod",
		"metadata":   map[string]interface{}{"name": name, "namespace": ns},
	}}
}

func dynScheme() (*runtime.Scheme, map[schema.GroupVersionResource]string) {
	scheme := runtime.NewScheme()
	gvrToList := map[schema.GroupVersionResource]string{
		{Group: "", Version: "v1", Resource: "pods"}:           "PodList",
		{Group: "", Version: "v1", Resource: "secrets"}:        "SecretList",
		{Group: "", Version: "v1", Resource: "nodes"}:          "NodeList",
		{Group: "apps", Version: "v1", Resource: "deployments"}: "DeploymentList",
	}
	return scheme, gvrToList
}

// resApp wires injector + RBAC middleware + resource handlers against a fake cluster client.
func resApp(t *testing.T, cc *cluster.ClusterClient) (*gin.Engine, *gorm.DB, *Handler) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	ci, err := crypto.New(resKey())
	if err != nil {
		t.Fatal(err)
	}
	jm := auth.NewJWTManager("secret", 0)
	pool := cluster.NewPool(db, ci, func(string) (*cluster.ClusterClient, error) { return &cluster.ClusterClient{}, nil })
	pool.Set("c1", cc)
	svc, err := rbac.NewService(db, pool)
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{DB: db, JWT: jm, Pool: pool, RBAC: svc}

	r := gin.New()
	api := r.Group("/api/v1")
	api.Use(func(c *gin.Context) {
		if v := c.GetHeader("X-Test-Uid"); v != "" {
			id, _ := strconv.ParseUint(v, 10, 64)
			c.Set("user_id", uint(id))
		}
		c.Set("is_admin", c.GetHeader("X-Test-Admin") == "true")
		c.Next()
	})
	api.GET("/namespaces", h.ListNamespaces)
	api.POST("/namespaces/:namespace/resources/:resource/:name/reveal", h.RevealSecret)
	res := api.Group("")
	res.Use(middleware.RBACAuthMiddleware(pool, svc, db))
	res.GET("/resources/:resource", h.ListResource)
	res.GET("/namespaces/:namespace/resources/:resource/:name", h.GetResource)
	res.POST("/namespaces/:namespace/resources/:resource", h.CreateResource)
	res.PUT("/namespaces/:namespace/resources/:resource/:name", h.UpdateResource)
	res.DELETE("/namespaces/:namespace/resources/:resource/:name", h.DeleteResource)
	res.POST("/resources/:resource", h.CreateResource)
	res.PUT("/resources/:resource/:name", h.UpdateResource)
	res.DELETE("/resources/:resource/:name", h.DeleteResource)
	// workload ops (subproject B)
	res.PUT("/namespaces/:namespace/resources/:resource/:name/scale", h.ScaleWorkload)
	res.PUT("/namespaces/:namespace/resources/:resource/:name/restart", h.RestartWorkload)
	res.PUT("/namespaces/:namespace/resources/:resource/:name/rollback", h.RollbackWorkload)
	res.PUT("/namespaces/:namespace/resources/:resource/:name/trigger", h.TriggerCronJob)
	res.GET("/namespaces/:namespace/resources/:resource/:name/revisions", h.ListRevisions)
	res.GET("/namespaces/:namespace/resources/:resource/:name/events", h.ResourceEvents)
	return r, db, h
}

func resReq(r *gin.Engine, method, path, uid string, admin bool, body any) *httptest.ResponseRecorder {
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, path, rdr)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Cluster-ID", "c1")
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

func podsGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}
}

// Invariant #1 (handler side): body namespace=prod, path=dev → object created in dev.
func TestCreateResource_ForcedNamespaceOverride(t *testing.T) {
	scheme, gvrToList := dynScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList)
	cc := &cluster.ClusterClient{Dynamic: dyn, RESTMapper: resMapper()}
	// bind NS-Editor in dev so write is authorized.
	app, _, h := resApp(t, cc)
	_ = h.RBAC.AddGrant("5", rbac.RoleNSEditor, "c1:dev")

	body := map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": "p1", "namespace": "prod"},
	}
	w := resReq(app, "POST", "/api/v1/namespaces/dev/resources/pods", "5", false, body)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	// object must exist in dev, NOT prod.
	if _, err := dyn.Resource(podsGVR()).Namespace("dev").Get(t.Context(), "p1", metav1.GetOptions{}); err != nil {
		t.Fatalf("pod should exist in dev: %v", err)
	}
	if _, err := dyn.Resource(podsGVR()).Namespace("prod").Get(t.Context(), "p1", metav1.GetOptions{}); err == nil {
		t.Fatal("pod must NOT exist in prod (namespace override failed)")
	}
}

// Invariant #2 (handler side): NS-Viewer bound only in dev lists pods cluster-wide
// and sees ONLY dev pods.
func TestListResource_ClusterAggregationOnlyVisibleNS(t *testing.T) {
	scheme, gvrToList := dynScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList,
		pod("dev", "d1"), pod("dev", "d2"), pod("prod", "p1"), pod("default", "x1"))
	cc := &cluster.ClusterClient{Dynamic: dyn, RESTMapper: resMapper()}
	app, _, h := resApp(t, cc)
	_ = h.RBAC.AddGrant("7", rbac.RoleNSViewer, "c1:dev")

	w := resReq(app, "GET", "/api/v1/resources/pods", "7", false, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var list struct {
		Items []map[string]any `json:"items"`
	}
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Items) != 2 {
		t.Fatalf("expected only 2 dev pods, got %d (%s)", len(list.Items), w.Body.String())
	}
	for _, it := range list.Items {
		md := it["metadata"].(map[string]any)
		if md["namespace"] != "dev" {
			t.Fatalf("leaked non-dev pod: %v", md)
		}
	}

	// listing nodes (cluster-scoped) → 403.
	w = resReq(app, "GET", "/api/v1/resources/nodes", "7", false, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for nodes, got %d", w.Code)
	}
}

func TestGetAndDeleteResource_NotFound(t *testing.T) {
	scheme, gvrToList := dynScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList, pod("dev", "p1"))
	cc := &cluster.ClusterClient{Dynamic: dyn, RESTMapper: resMapper()}
	app, _, h := resApp(t, cc)
	_ = h.RBAC.AddGrant("5", rbac.RoleNSEditor, "c1:dev")

	// get existing
	w := resReq(app, "GET", "/api/v1/namespaces/dev/resources/pods/p1", "5", false, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	// get missing → 404
	w = resReq(app, "GET", "/api/v1/namespaces/dev/resources/pods/missing", "5", false, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("get missing expected 404, got %d", w.Code)
	}
	// delete existing → 200
	w = resReq(app, "DELETE", "/api/v1/namespaces/dev/resources/pods/p1", "5", false, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("delete expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	// delete missing → 404
	w = resReq(app, "DELETE", "/api/v1/namespaces/dev/resources/pods/p1", "5", false, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("delete missing expected 404, got %d", w.Code)
	}
}

func TestListResource_AdminAllNamespaces(t *testing.T) {
	scheme, gvrToList := dynScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList,
		pod("dev", "d1"), pod("prod", "p1"))
	cc := &cluster.ClusterClient{Dynamic: dyn, RESTMapper: resMapper()}
	app, _, _ := resApp(t, cc)

	w := resReq(app, "GET", "/api/v1/resources/pods", "1", true, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var list struct {
		Items []map[string]any `json:"items"`
	}
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Items) != 2 {
		t.Fatalf("admin should see all pods (2), got %d", len(list.Items))
	}
}

// helper to build a typed clientset cluster client (for namespace/secret tests).
func typedCC(objs ...runtime.Object) *cluster.ClusterClient {
	return &cluster.ClusterClient{
		Typed:      fakeclientset.NewSimpleClientset(objs...),
		RESTMapper: resMapper(),
	}
}

func nsObj(name string) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
}
