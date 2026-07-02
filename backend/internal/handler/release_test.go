package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"omnikube/internal/auth"
	"omnikube/internal/cluster"
	"omnikube/internal/database"
	"omnikube/internal/model"
)

func depGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
}

// deployment builds a single-container Deployment with the given image.
func deployment(ns, name, image string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata":   map[string]interface{}{"name": name, "namespace": ns},
		"spec": map[string]interface{}{
			"replicas": int64(2),
			"template": map[string]interface{}{
				"spec": map[string]interface{}{
					"containers": []interface{}{
						map[string]interface{}{"name": "app", "image": image},
					},
				},
			},
		},
	}}
}

// deploymentBody mirrors `deployment` as a plain map for use as a PUT body.
func deploymentBody(ns, name, image string, replicas int) map[string]any {
	return map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata":   map[string]any{"name": name, "namespace": ns},
		"spec": map[string]any{
			"replicas": replicas,
			"template": map[string]any{
				"spec": map[string]any{
					"containers": []any{
						map[string]any{"name": "app", "image": image},
					},
				},
			},
		},
	}
}

// seedReleaseUser creates a user (optionally admin) and returns its id as a string.
func seedReleaseUser(t *testing.T, db *gorm.DB, name string, admin bool) string {
	t.Helper()
	hash, _ := auth.HashPassword("pw123456")
	u := model.User{Username: name, Password: hash, IsAdmin: admin}
	if err := db.Create(&u).Error; err != nil {
		t.Fatal(err)
	}
	return strconv.FormatUint(uint64(u.ID), 10)
}

// An image-tag change on a workload without a release comment is rejected (400)
// and the object is NOT updated.
func TestUpdateResource_ImageChangeRequiresComment(t *testing.T) {
	scheme, gvrToList := dynScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList,
		deployment("dev", "web", "nginx:1.27"))
	cc := &cluster.ClusterClient{Dynamic: dyn, RESTMapper: resMapper()}
	app, db, _ := resApp(t, cc)
	uid := seedReleaseUser(t, db, "releaser", true)

	body := deploymentBody("dev", "web", "nginx:1.28", 2)
	w := resReq(app, "PUT", "/api/v1/namespaces/dev/resources/deployments/web", uid, true, body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing release comment, got %d (%s)", w.Code, w.Body.String())
	}
	// object must remain on the old image.
	got, err := dyn.Resource(depGVR()).Namespace("dev").Get(t.Context(), "web", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	imgs := containerImages(got)
	if imgs["app"] != "nginx:1.27" {
		t.Fatalf("deployment must NOT be updated, image=%s", imgs["app"])
	}
	var n int64
	db.Model(&model.ReleaseRecord{}).Count(&n)
	if n != 0 {
		t.Fatalf("expected no release record, got %d", n)
	}
}

// An image-tag change WITH a comment succeeds (200) and records one ReleaseRecord.
func TestUpdateResource_ImageChangeWithCommentRecords(t *testing.T) {
	scheme, gvrToList := dynScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList,
		deployment("dev", "web", "nginx:1.27"))
	cc := &cluster.ClusterClient{Dynamic: dyn, RESTMapper: resMapper()}
	app, db, _ := resApp(t, cc)
	uid := seedReleaseUser(t, db, "releaser", true)

	body := deploymentBody("dev", "web", "nginx:1.28", 2)
	w := resReq(app, "PUT", "/api/v1/namespaces/dev/resources/deployments/web?release_comment=bump+nginx", uid, true, body)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	// object updated.
	got, _ := dyn.Resource(depGVR()).Namespace("dev").Get(t.Context(), "web", metav1.GetOptions{})
	if containerImages(got)["app"] != "nginx:1.28" {
		t.Fatalf("deployment image should be updated")
	}
	// exactly one release record with the right fields.
	var recs []model.ReleaseRecord
	db.Find(&recs)
	if len(recs) != 1 {
		t.Fatalf("expected 1 release record, got %d", len(recs))
	}
	r := recs[0]
	if r.Kind != "Deployment" || r.Name != "web" || r.Namespace != "dev" {
		t.Fatalf("unexpected record meta: %+v", r)
	}
	if r.ImageBefore != "app=nginx:1.27" || r.ImageAfter != "app=nginx:1.28" {
		t.Fatalf("unexpected before/after: %q -> %q", r.ImageBefore, r.ImageAfter)
	}
	if r.Comment != "bump nginx" {
		t.Fatalf("unexpected comment: %q", r.Comment)
	}
	if r.Username != "releaser" || r.ClusterID != "c1" {
		t.Fatalf("unexpected user/cluster: %+v", r)
	}
}

// A non-image change (replicas only) needs no comment and records nothing.
func TestUpdateResource_NonImageChangeNoRecord(t *testing.T) {
	scheme, gvrToList := dynScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList,
		deployment("dev", "web", "nginx:1.27"))
	cc := &cluster.ClusterClient{Dynamic: dyn, RESTMapper: resMapper()}
	app, db, _ := resApp(t, cc)
	uid := seedReleaseUser(t, db, "releaser", true)

	body := deploymentBody("dev", "web", "nginx:1.27", 5) // same image, more replicas
	w := resReq(app, "PUT", "/api/v1/namespaces/dev/resources/deployments/web", uid, true, body)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for non-image change, got %d (%s)", w.Code, w.Body.String())
	}
	var n int64
	db.Model(&model.ReleaseRecord{}).Count(&n)
	if n != 0 {
		t.Fatalf("non-image change must not record a release, got %d", n)
	}
}

// releasesApp wires GET /releases with a header-controlled user id injector.
func releasesApp(t *testing.T) (*gin.Engine, *gorm.DB, *Handler) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	h := &Handler{DB: db}
	r := gin.New()
	api := r.Group("/api/v1")
	api.Use(func(c *gin.Context) {
		if v := c.GetHeader("X-Test-Uid"); v != "" {
			id, _ := strconv.ParseUint(v, 10, 64)
			c.Set("user_id", uint(id))
		}
		c.Next()
	})
	api.GET("/releases", h.ListReleases)
	return r, db, h
}

func getReleases(r *gin.Engine, uid string) *httptest.ResponseRecorder {
	req, _ := http.NewRequest("GET", "/api/v1/releases", nil)
	if uid != "" {
		req.Header.Set("X-Test-Uid", uid)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// ListReleases no longer self-gates: access is enforced at the router by
// RequireGlobalPerm("releases","view") (admin bypassed). The handler returns the
// list for any request that reaches it.

// /releases is 200 for an admin.
func TestListReleases_AdminAllowed(t *testing.T) {
	r, db, _ := releasesApp(t)
	uid := seedReleaseUser(t, db, "root", true)
	db.Create(&model.ReleaseRecord{Username: "x", ClusterID: "c1", Namespace: "dev",
		Kind: "Deployment", Name: "web", ImageBefore: "app=a", ImageAfter: "app=b", Comment: "c"})
	w := getReleases(r, uid)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Releases []model.ReleaseRecord `json:"releases"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Releases) != 1 {
		t.Fatalf("expected 1 release, got %d", len(resp.Releases))
	}
}

// /releases is 200 for a non-admin whose role grants the releases functional page.
func TestListReleases_AllowedViaRolePage(t *testing.T) {
	r, db, _ := releasesApp(t)
	uid := seedReleaseUser(t, db, "auditor", false)
	id, _ := strconv.ParseUint(uid, 10, 64)
	role := model.Role{Name: "releaser", Pages: `["releases"]`}
	db.Create(&role)
	db.Create(&model.UserRole{UserID: uint(id), RoleID: role.ID})
	w := getReleases(r, uid)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 via role page, got %d (%s)", w.Code, w.Body.String())
	}
}
