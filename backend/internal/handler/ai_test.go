package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/crypto"
	"omnikube/internal/database"
)

// aiApp builds a Handler with an in-memory DB + a zero-key cipher and registers
// the five /ai/* routes with a header-injected user id (admin). Mirrors the
// resApp/resReq harness in resource_test.go.
func aiApp(t *testing.T) (*gin.Engine, *gorm.DB) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	ci, err := crypto.New(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{DB: db, Cipher: ci}

	r := gin.New()
	api := r.Group("/api/v1")
	api.Use(func(c *gin.Context) {
		if v := c.GetHeader("X-Test-Uid"); v != "" {
			c.Set("user_id", uint(1))
		}
		c.Set("is_admin", c.GetHeader("X-Test-Admin") == "true")
		c.Next()
	})
	api.GET("/ai/status", h.GetAIStatus)
	api.GET("/ai/config", h.GetAIConfig)
	api.PUT("/ai/config", h.PutAIConfig)
	api.GET("/ai/grants", h.GetAIGrants)
	api.PUT("/ai/grants", h.PutAIGrants)
	return r, db
}

func aiReq(r *gin.Engine, method, path, uid string, admin bool, body any) *httptest.ResponseRecorder {
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, path, rdr)
	req.Header.Set("Content-Type", "application/json")
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

func TestAIConfigMaskAndStatus(t *testing.T) {
	app, _ := aiApp(t)

	// Initially: not configured, disabled.
	w := aiReq(app, "GET", "/api/v1/ai/status", "1", true, nil)
	var st struct{ Enabled, Configured bool }
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if st.Enabled || st.Configured {
		t.Fatalf("fresh status should be disabled+unconfigured, got %+v", st)
	}

	// Save config with a key.
	body := map[string]any{"enabled": true, "base_url": "https://x/v1", "api_key": "sk-1", "model_id": "m"}
	if w := aiReq(app, "PUT", "/api/v1/ai/config", "1", true, body); w.Code != http.StatusOK {
		t.Fatalf("put config: %d %s", w.Code, w.Body.String())
	}

	// GET config must NOT leak the key, but flags it present.
	w = aiReq(app, "GET", "/api/v1/ai/config", "1", true, nil)
	var cfg map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &cfg)
	if _, leaked := cfg["api_key"]; leaked {
		t.Fatal("api_key must not be returned")
	}
	if cfg["has_key"] != true {
		t.Fatalf("has_key should be true, got %v", cfg["has_key"])
	}

	// Status now enabled + configured.
	w = aiReq(app, "GET", "/api/v1/ai/status", "1", true, nil)
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if !st.Enabled || !st.Configured {
		t.Fatalf("status should be enabled+configured, got %+v", st)
	}
}

func TestAIGrantsRoundTrip(t *testing.T) {
	app, _ := aiApp(t)

	body := map[string]any{"operations": map[string][]string{"deployments": {"view", "create"}}}
	if w := aiReq(app, "PUT", "/api/v1/ai/grants?cluster_id=c1", "1", true, body); w.Code != http.StatusOK {
		t.Fatalf("put grants: %d %s", w.Code, w.Body.String())
	}

	w := aiReq(app, "GET", "/api/v1/ai/grants?cluster_id=c1", "1", true, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get grants: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		Operations map[string][]string `json:"operations"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Operations["deployments"]) != 2 {
		t.Fatalf("expected 2 deployment ops, got %+v", resp.Operations)
	}
}

func TestAIGrantsMissingCluster(t *testing.T) {
	app, _ := aiApp(t)
	w := aiReq(app, "GET", "/api/v1/ai/grants", "1", true, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing cluster_id should be 400, got %d %s", w.Code, w.Body.String())
	}
}
