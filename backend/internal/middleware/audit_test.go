package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/database"
	"omnikube/internal/model"
)

func auditTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	return db
}

// auditApp builds a gin engine with the Audit middleware and a route that
// injects user_id then echoes the given status.
func auditApp(db *gorm.DB, method, pattern string, status int) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	grp := r.Group("")
	grp.Use(func(c *gin.Context) { c.Set("user_id", uint(7)); c.Next() })
	grp.Use(Audit(db))
	grp.Handle(method, pattern, func(c *gin.Context) { c.Status(status) })
	return r
}

func TestAudit_RecordsWrite(t *testing.T) {
	db := auditTestDB(t)
	r := auditApp(db, "POST", "/api/v1/namespaces/:namespace/resources/:resource", 201)
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/v1/namespaces/dev/resources/deployments", nil)
	req.Header.Set("X-Cluster-ID", "cluster_a")
	r.ServeHTTP(w, req)

	var got model.AuditLog
	if err := db.First(&got).Error; err != nil {
		t.Fatalf("expected audit row: %v", err)
	}
	if got.Action != "create" || got.Resource != "deployments" || got.Namespace != "dev" {
		t.Fatalf("unexpected: %+v", got)
	}
	if got.ClusterID != "cluster_a" || got.UserID != "7" || got.Result != "success" {
		t.Fatalf("unexpected: %+v", got)
	}
}

func TestAudit_SkipsReads(t *testing.T) {
	db := auditTestDB(t)
	r := auditApp(db, "GET", "/api/v1/resources/:resource", 200)
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/v1/resources/pods", nil)
	r.ServeHTTP(w, req)

	var n int64
	db.Model(&model.AuditLog{}).Count(&n)
	if n != 0 {
		t.Fatalf("GET must not be audited, got %d rows", n)
	}
}

func TestAudit_SkipsReveal(t *testing.T) {
	db := auditTestDB(t)
	r := auditApp(db, "POST", "/api/v1/namespaces/:namespace/resources/:resource/:name/reveal", 200)
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/v1/namespaces/dev/resources/secrets/db/reveal", nil)
	r.ServeHTTP(w, req)

	var n int64
	db.Model(&model.AuditLog{}).Count(&n)
	if n != 0 {
		t.Fatalf("reveal must be skipped (handler audits it), got %d rows", n)
	}
}

func TestAudit_ActionDerivation(t *testing.T) {
	cases := []struct {
		method, pattern, url, want string
	}{
		{"PUT", "/api/v1/resources/:resource/:name", "/api/v1/resources/deployments/web", "update"},
		{"DELETE", "/api/v1/namespaces/:namespace/resources/:resource/:name", "/api/v1/namespaces/dev/resources/pods/p1", "delete"},
		{"POST", "/api/v1/namespaces/:namespace/resources/:resource/:name/scale", "/api/v1/namespaces/dev/resources/deployments/web/scale", "scale"},
		{"POST", "/api/v1/namespaces/:namespace/resources/:resource/:name/restart", "/api/v1/namespaces/dev/resources/deployments/web/restart", "restart"},
		{"POST", "/api/v1/namespaces/:namespace/resources/:resource/:name/rollback", "/api/v1/namespaces/dev/resources/deployments/web/rollback", "rollback"},
		{"PUT", "/api/v1/users/:id/roles", "/api/v1/users/3/roles", "set-roles"},
		{"PUT", "/api/v1/users/:id/disable", "/api/v1/users/3/disable", "disable"},
		{"POST", "/api/v1/clusters/test", "/api/v1/clusters/test", "test"},
	}
	for _, tc := range cases {
		db := auditTestDB(t)
		r := auditApp(db, tc.method, tc.pattern, 200)
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(tc.method, tc.url, nil)
		r.ServeHTTP(w, req)
		var got model.AuditLog
		if err := db.First(&got).Error; err != nil {
			t.Fatalf("%s %s: no row: %v", tc.method, tc.url, err)
		}
		if got.Action != tc.want {
			t.Fatalf("%s %s: action=%q want %q", tc.method, tc.url, got.Action, tc.want)
		}
	}
}

func TestAudit_ResultByStatus(t *testing.T) {
	cases := []struct {
		status int
		want   string
	}{{200, "success"}, {403, "denied"}, {400, "failed"}, {500, "failed"}}
	for _, tc := range cases {
		db := auditTestDB(t)
		r := auditApp(db, "DELETE", "/api/v1/resources/:resource/:name", tc.status)
		w := httptest.NewRecorder()
		req, _ := http.NewRequest("DELETE", "/api/v1/resources/pods/p1", nil)
		r.ServeHTTP(w, req)
		var got model.AuditLog
		if err := db.First(&got).Error; err != nil {
			t.Fatalf("status %d: no row", tc.status)
		}
		if got.Result != tc.want {
			t.Fatalf("status %d: result=%q want %q", tc.status, got.Result, tc.want)
		}
	}
}
