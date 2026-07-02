package ws

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/gorilla/websocket"
	"gorm.io/gorm"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"

	fakeclientset "k8s.io/client-go/kubernetes/fake"

	"omnikube/internal/auth"
	"omnikube/internal/cluster"
	"omnikube/internal/crypto"
	"omnikube/internal/database"
	"omnikube/internal/model"
	"omnikube/internal/rbac"
)

const (
	testCluster = "c1"
	testNS      = "dev"
)

func wsKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i + 21)
	}
	return k
}

// newWSEnv builds an httptest server exposing /api/v1/exec and /api/v1/logs wired to a
// ws.Handler backed by in-memory sqlite + a fake cluster client (minimal Config so
// authorization passes without a real cluster).
func newWSEnv(t *testing.T) (*httptest.Server, *gorm.DB, *Handler) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	// ws handlers write audit from a separate goroutine; pin to one connection so
	// the shared in-memory database (and its migrated tables) is visible to all.
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	ci, err := crypto.New(wsKey())
	if err != nil {
		t.Fatal(err)
	}
	jm := auth.NewJWTManager("test-secret", time.Hour)
	pool := cluster.NewPool(db, ci, func(string) (*cluster.ClusterClient, error) { return &cluster.ClusterClient{}, nil })
	// Fake clientset seeded with a namespace; minimal Config so newSPDYExecutor's
	// NewForConfig succeeds and dials a refused host (handshake-success tests only
	// need 101; the real exec stream never connects).
	cs := fakeclientset.NewSimpleClientset(&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: testNS}})
	pool.Set(testCluster, &cluster.ClusterClient{
		Typed:  cs,
		Config: &rest.Config{Host: "http://127.0.0.1:1"},
	})
	svc, err := rbac.NewService(db, pool)
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{DB: db, JWT: jm, Pool: pool, RBAC: svc}

	r := gin.New()
	api := r.Group("/api/v1")
	api.GET("/exec", h.ExecHandler)
	api.GET("/logs", h.LogHandler)

	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, db, h
}

func wsURL(base, path, query string) string {
	u := "ws" + strings.TrimPrefix(base, "http") + path
	if query != "" {
		u += "?" + query
	}
	return u
}

// dial attempts a websocket handshake and returns the conn (if 101) and HTTP response.
func dial(t *testing.T, base, path, query string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	d := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, resp, err := d.Dial(wsURL(base, path, query), nil)
	return conn, resp, err
}

func issue(t *testing.T, h *Handler, uid uint, admin bool) string {
	t.Helper()
	tok, err := h.JWT.Issue(uid, admin)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func auditCount(db *gorm.DB, result, action string) int64 {
	var n int64
	db.Model(&model.AuditLog{}).Where("result = ? AND action = ?", result, action).Count(&n)
	return n
}

// --- Pre-upgrade authorization gate (PRD §8) ---

func TestExec_MissingParam_400(t *testing.T) {
	srv, _, h := newWSEnv(t)
	tok := issue(t, h, 5, false)
	// missing pod
	_, resp, err := dial(t, srv.URL, "/api/v1/exec", "cluster_id="+testCluster+"&token="+tok)
	if err != websocket.ErrBadHandshake || resp == nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 bad handshake, got err=%v resp=%v", err, resp)
	}
}

func TestExec_BadToken_401(t *testing.T) {
	srv, _, _ := newWSEnv(t)
	_, resp, err := dial(t, srv.URL, "/api/v1/exec",
		"cluster_id="+testCluster+"&namespace="+testNS+"&pod=p1&token=garbage")
	if err != websocket.ErrBadHandshake || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got err=%v resp=%v", err, resp)
	}
}

func TestExec_UnknownCluster_400(t *testing.T) {
	srv, _, h := newWSEnv(t)
	tok := issue(t, h, 5, false)
	_, resp, err := dial(t, srv.URL, "/api/v1/exec",
		"cluster_id=nope&namespace="+testNS+"&pod=p1&token="+tok)
	if err != websocket.ErrBadHandshake || resp == nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got err=%v resp=%v", err, resp)
	}
}

// NS-Viewer has read but NOT exec → 403 + deny audit row.
func TestExec_NSViewer_Forbidden_403_WithDenyAudit(t *testing.T) {
	srv, db, h := newWSEnv(t)
	if err := h.RBAC.AddGrant("7", rbac.RoleNSViewer, testCluster+":"+testNS); err != nil {
		t.Fatal(err)
	}
	tok := issue(t, h, 7, false)
	_, resp, err := dial(t, srv.URL, "/api/v1/exec",
		"cluster_id="+testCluster+"&namespace="+testNS+"&pod=p1&container=app&token="+tok)
	if err != websocket.ErrBadHandshake || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got err=%v resp=%v", err, resp)
	}
	if got := auditCount(db, "deny", "exec"); got != 1 {
		t.Fatalf("expected 1 deny/exec audit row, got %d", got)
	}
	// token must never appear in any audit field.
	assertTokenNotInAudit(t, db, tok)
}

// NS-Editor has exec → handshake succeeds (101), then we close.
func TestExec_NSEditor_Handshake101_WithAllowAudit(t *testing.T) {
	srv, db, h := newWSEnv(t)
	if err := h.RBAC.AddGrant("8", rbac.RoleNSEditor, testCluster+":"+testNS); err != nil {
		t.Fatal(err)
	}
	tok := issue(t, h, 8, false)
	conn, resp, err := dial(t, srv.URL, "/api/v1/exec",
		"cluster_id="+testCluster+"&namespace="+testNS+"&pod=p1&container=app&token="+tok)
	if err != nil {
		t.Fatalf("expected 101 handshake, got err=%v resp=%v", err, resp)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("expected 101, got %d", resp.StatusCode)
	}
	_ = conn.Close()

	// allow exec audit is written on successful session establishment.
	waitForAudit(t, db, "allow", "exec", 1)
	assertTokenNotInAudit(t, db, tok)
}

// --- Logs gate ---

// NS-Viewer has read → logs handshake succeeds (101) + allow read audit.
func TestLogs_NSViewer_Handshake101_WithAllowAudit(t *testing.T) {
	srv, db, h := newWSEnv(t)
	if err := h.RBAC.AddGrant("9", rbac.RoleNSViewer, testCluster+":"+testNS); err != nil {
		t.Fatal(err)
	}
	tok := issue(t, h, 9, false)
	conn, resp, err := dial(t, srv.URL, "/api/v1/logs",
		"cluster_id="+testCluster+"&namespace="+testNS+"&pod=p1&container=app&token="+tok+"&tail=10")
	if err != nil {
		t.Fatalf("expected 101 handshake, got err=%v resp=%v", err, resp)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("expected 101, got %d", resp.StatusCode)
	}
	// fake GetLogs streams "fake logs"; read at least the first frame then close.
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, msg, rerr := conn.ReadMessage(); rerr == nil && string(msg) != "fake logs" {
		t.Logf("log frame: %q", msg)
	}
	_ = conn.Close()

	waitForAudit(t, db, "allow", "read", 1)
	assertTokenNotInAudit(t, db, tok)
}

// Unbound user hitting /logs → 403 + deny read audit.
func TestLogs_Unbound_Forbidden_403(t *testing.T) {
	srv, db, h := newWSEnv(t)
	tok := issue(t, h, 99, false)
	_, resp, err := dial(t, srv.URL, "/api/v1/logs",
		"cluster_id="+testCluster+"&namespace="+testNS+"&pod=p1&token="+tok)
	if err != websocket.ErrBadHandshake || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got err=%v resp=%v", err, resp)
	}
	if got := auditCount(db, "deny", "read"); got != 1 {
		t.Fatalf("expected 1 deny/read audit row, got %d", got)
	}
	assertTokenNotInAudit(t, db, tok)
}

// System-admin bypasses authorization (no grant) → 101.
func TestExec_Admin_Bypass_Handshake101(t *testing.T) {
	srv, _, h := newWSEnv(t)
	tok := issue(t, h, 1, true)
	conn, resp, err := dial(t, srv.URL, "/api/v1/exec",
		"cluster_id="+testCluster+"&namespace="+testNS+"&pod=p1&container=app&token="+tok)
	if err != nil {
		t.Fatalf("expected admin 101 handshake, got err=%v resp=%v", err, resp)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("expected 101, got %d", resp.StatusCode)
	}
	_ = conn.Close()
}

// --- helpers ---

// waitForAudit polls until the expected audit row count is reached (the allow row is
// written from the handler goroutine after Upgrade, so it may lag the client's 101).
func waitForAudit(t *testing.T, db *gorm.DB, result, action string, want int64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if auditCount(db, result, action) >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected %d %s/%s audit rows, got %d", want, result, action, auditCount(db, result, action))
}

// assertTokenNotInAudit verifies the JWT never leaks into any audit field.
func assertTokenNotInAudit(t *testing.T, db *gorm.DB, token string) {
	t.Helper()
	var rows []model.AuditLog
	if err := db.Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		for _, f := range []string{r.UserID, r.ClusterID, r.Namespace, r.Resource, r.Action, r.Target, r.Result, r.SourceIP} {
			if strings.Contains(f, token) {
				t.Fatalf("token leaked into audit row: %+v", r)
			}
		}
	}
}
