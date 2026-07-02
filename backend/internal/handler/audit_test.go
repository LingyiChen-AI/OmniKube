package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/database"
	"omnikube/internal/model"
)

func auditApp(t *testing.T) (*gin.Engine, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	h := &Handler{DB: db}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api/v1")
	api.GET("/audit-logs", h.ListAuditLogs)
	api.GET("/audit-logs/export", h.ExportAuditLogs)
	return r, db
}

func seedAudit(db *gorm.DB, rows ...model.AuditLog) {
	for i := range rows {
		db.Create(&rows[i])
	}
}

func getAudit(r *gin.Engine, query string) *httptest.ResponseRecorder {
	req, _ := http.NewRequest("GET", "/api/v1/audit-logs"+query, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

type auditListResp struct {
	Logs  []auditView `json:"logs"`
	Total int         `json:"total"`
}

func TestListAuditLogs_FilterAndPaginate(t *testing.T) {
	r, db := auditApp(t)
	base := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 5; i++ {
		seedAudit(db, model.AuditLog{
			UserID: "7", Action: "create", Resource: "deployments", ClusterID: "c1",
			Namespace: "dev", Result: "success", CreatedAt: base.Add(time.Duration(i) * time.Minute),
		})
	}
	seedAudit(db, model.AuditLog{
		UserID: "9", Action: "delete", Resource: "pods", ClusterID: "c2",
		Namespace: "prod", Result: "failed", CreatedAt: base.Add(time.Hour),
	})

	// No filter → total 6, but limit caps returned rows.
	var all auditListResp
	json.Unmarshal(getAudit(r, "?limit=3").Body.Bytes(), &all)
	if all.Total != 6 || len(all.Logs) != 3 {
		t.Fatalf("expected total=6 len=3, got total=%d len=%d", all.Total, len(all.Logs))
	}

	// Filter by action=delete → 1 row.
	var del auditListResp
	json.Unmarshal(getAudit(r, "?action=delete").Body.Bytes(), &del)
	if del.Total != 1 || del.Logs[0].Resource != "pods" {
		t.Fatalf("action filter failed: %+v", del)
	}

	// Filter by user_id=7 → 5 rows.
	var u7 auditListResp
	json.Unmarshal(getAudit(r, "?user_id=7").Body.Bytes(), &u7)
	if u7.Total != 5 {
		t.Fatalf("user filter expected 5, got %d", u7.Total)
	}

	// Time window from second row onward (base+1m) → 5 rows (4 creates + 1 delete).
	from := base.Add(time.Minute).Format(time.RFC3339)
	var win auditListResp
	json.Unmarshal(getAudit(r, "?from="+from).Body.Bytes(), &win)
	if win.Total != 5 {
		t.Fatalf("time filter expected 5, got %d", win.Total)
	}

	// Ordering: newest first.
	var ord auditListResp
	json.Unmarshal(getAudit(r, "").Body.Bytes(), &ord)
	if ord.Logs[0].Action != "delete" {
		t.Fatalf("expected newest (delete) first, got %s", ord.Logs[0].Action)
	}
}

func TestExportAuditLogs_CSV(t *testing.T) {
	r, db := auditApp(t)
	seedAudit(db,
		model.AuditLog{UserID: "7", Action: "create", Resource: "deployments", Result: "success", CreatedAt: time.Now()},
		model.AuditLog{UserID: "9", Action: "delete", Resource: "pods", Result: "failed", CreatedAt: time.Now()},
	)
	req, _ := http.NewRequest("GET", "/api/v1/audit-logs/export", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "text/csv") {
		t.Fatalf("expected csv content-type, got %q", ct)
	}
	body := w.Body.String()
	lines := strings.Split(strings.TrimSpace(strings.TrimPrefix(body, "\xEF\xBB\xBF")), "\n")
	// header + 2 rows
	if len(lines) != 3 {
		t.Fatalf("expected 3 CSV lines (header+2), got %d: %q", len(lines), body)
	}
	if !strings.HasPrefix(lines[0], "time,user_id,username,action") {
		t.Fatalf("unexpected header: %q", lines[0])
	}
}
