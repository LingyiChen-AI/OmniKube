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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"omnikube/internal/ai"
	"omnikube/internal/cluster"
	"omnikube/internal/crypto"
	"omnikube/internal/database"
	"omnikube/internal/rbac"
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
	api.PUT("/ai/enabled", h.PutAIEnabled)
	api.GET("/ai/conversations", h.ListConversations)
	api.POST("/ai/conversations", h.CreateConversation)
	api.GET("/ai/conversations/:id", h.GetConversation)
	return r, db
}

// conversation REST 走的是 user_id（而非 admin），aiReq 的 X-Test-Uid 恒置 user 1，
// 无法模拟第二个用户；此处用一个把 user_id 设为任意值的最小引擎覆盖归属隔离。
func aiConvApp(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	ci, _ := crypto.New(make([]byte, 32))
	h := &Handler{DB: db, Cipher: ci}
	r := gin.New()
	api := r.Group("/api/v1")
	api.Use(func(c *gin.Context) {
		if v := c.GetHeader("X-Test-Uid"); v != "" {
			id, _ := strconv.ParseUint(v, 10, 64)
			c.Set("user_id", uint(id))
		}
		c.Next()
	})
	api.GET("/ai/conversations", h.ListConversations)
	api.POST("/ai/conversations", h.CreateConversation)
	api.GET("/ai/conversations/:id", h.GetConversation)
	return r
}

func TestConversationRESTRoundTripAndOwnerIsolation(t *testing.T) {
	app := aiConvApp(t)

	// user 1 创建会话。
	w := aiReq(app, "POST", "/api/v1/ai/conversations", "1", false, map[string]any{"cluster_id": "c1", "title": "第一次对话"})
	if w.Code != http.StatusOK {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		ID uint `json:"id"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	if created.ID == 0 {
		t.Fatal("expected non-zero conversation id")
	}

	// user 1 列表能看到自己的会话。
	w = aiReq(app, "GET", "/api/v1/ai/conversations", "1", false, nil)
	var listResp struct {
		Conversations []map[string]any `json:"conversations"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &listResp)
	if len(listResp.Conversations) != 1 {
		t.Fatalf("expected 1 conversation for user 1, got %d", len(listResp.Conversations))
	}

	// user 1 能读取自己的会话详情。
	path := "/api/v1/ai/conversations/" + strconv.FormatUint(uint64(created.ID), 10)
	if w := aiReq(app, "GET", path, "1", false, nil); w.Code != http.StatusOK {
		t.Fatalf("owner get: %d %s", w.Code, w.Body.String())
	}

	// user 2 读取 user 1 的会话 → 403（归属隔离）。
	if w := aiReq(app, "GET", path, "2", false, nil); w.Code != http.StatusForbidden {
		t.Fatalf("non-owner get should be 403, got %d %s", w.Code, w.Body.String())
	}

	// user 2 的列表为空。
	w = aiReq(app, "GET", "/api/v1/ai/conversations", "2", false, nil)
	_ = json.Unmarshal(w.Body.Bytes(), &listResp)
	if len(listResp.Conversations) != 0 {
		t.Fatalf("expected 0 conversations for user 2, got %d", len(listResp.Conversations))
	}
}

// aiConfirmApp 复用 resApp 的 Pool(fake cc@c1)+RBAC 装配，另起一个只挂 confirm 路由
// 的引擎（X-Test-Uid 可为任意 uid，用于验证归属隔离）。
func aiConfirmApp(t *testing.T, cc *cluster.ClusterClient) (*gin.Engine, *gorm.DB, *Handler) {
	t.Helper()
	_, db, h := resApp(t, cc)
	r := gin.New()
	api := r.Group("/api/v1")
	api.Use(func(c *gin.Context) {
		if v := c.GetHeader("X-Test-Uid"); v != "" {
			id, _ := strconv.ParseUint(v, 10, 64)
			c.Set("user_id", uint(id))
		}
		c.Next()
	})
	api.POST("/ai/conversations/:id/confirm", h.ConfirmConversation)
	return r, db, h
}

// seedPendingCreate 造一条 user1 拥有的 c1 会话，其助手消息带一个「create deployments/nginx@dev」
// 的待确认动作，并配好用户权限（NS-Editor@dev，AI 跟随其 RBAC）。返回会话 id。
func seedPendingCreate(t *testing.T, db *gorm.DB, h *Handler) uint {
	t.Helper()
	if err := h.RBAC.AddGrant("1", rbac.RoleNSEditor, "c1:dev"); err != nil {
		t.Fatal(err)
	}
	convs := ai.NewConvStore(db)
	convID, err := convs.Create(1, "c1", "对话")
	if err != nil {
		t.Fatal(err)
	}
	acts := []ai.StagedAction{{
		Action: "create", Resource: "deployments", Namespace: "dev", Name: "nginx",
		Manifest: map[string]any{
			"apiVersion": "apps/v1", "kind": "Deployment",
			"metadata": map[string]any{"name": "nginx", "namespace": "dev"},
		},
	}}
	raw, _ := json.Marshal(acts)
	if err := convs.AppendAssistant(convID, "我准备创建 nginx，请确认", "", string(raw)); err != nil {
		t.Fatal(err)
	}
	return convID
}

// TestConfirmRESTApprovesExecutes 确认执行：POST confirm approved=true → 200，
// fake 集群里出现 nginx，且不能二次确认（pending 已清空）。
func TestConfirmRESTApprovesExecutes(t *testing.T) {
	scheme, gvrToList := dynScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList)
	cc := &cluster.ClusterClient{Dynamic: dyn, RESTMapper: resMapper()}
	app, db, h := aiConfirmApp(t, cc)
	convID := seedPendingCreate(t, db, h)

	path := "/api/v1/ai/conversations/" + strconv.FormatUint(uint64(convID), 10) + "/confirm"
	w := aiReq(app, "POST", path, "1", false, map[string]any{"approved": true})
	if w.Code != http.StatusOK {
		t.Fatalf("confirm approve: %d %s", w.Code, w.Body.String())
	}
	// nginx 应已被创建。
	gvr := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	if _, err := dyn.Resource(gvr).Namespace("dev").Get(t.Context(), "nginx", metav1.GetOptions{}); err != nil {
		t.Fatalf("nginx should exist after approve: %v", err)
	}
	// 二次确认应报「没有待确认的操作」（pending 已清空）。
	w = aiReq(app, "POST", path, "1", false, map[string]any{"approved": true})
	var resp struct {
		Events []ai.Event `json:"events"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Events) != 1 || resp.Events[0].Type != "error" {
		t.Fatalf("second confirm should error (no pending), got %+v", resp.Events)
	}
}

// TestConfirmRESTRejectDoesNotExecute 取消：approved=false → 200 且不创建任何对象。
func TestConfirmRESTRejectDoesNotExecute(t *testing.T) {
	scheme, gvrToList := dynScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList)
	cc := &cluster.ClusterClient{Dynamic: dyn, RESTMapper: resMapper()}
	app, db, h := aiConfirmApp(t, cc)
	convID := seedPendingCreate(t, db, h)

	path := "/api/v1/ai/conversations/" + strconv.FormatUint(uint64(convID), 10) + "/confirm"
	w := aiReq(app, "POST", path, "1", false, map[string]any{"approved": false})
	if w.Code != http.StatusOK {
		t.Fatalf("confirm reject: %d %s", w.Code, w.Body.String())
	}
	gvr := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	if _, err := dyn.Resource(gvr).Namespace("dev").Get(t.Context(), "nginx", metav1.GetOptions{}); err == nil {
		t.Fatal("reject must NOT create nginx")
	}
}

// TestConfirmRESTOwnerIsolation 非会话主人确认 → 403。
func TestConfirmRESTOwnerIsolation(t *testing.T) {
	scheme, gvrToList := dynScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList)
	cc := &cluster.ClusterClient{Dynamic: dyn, RESTMapper: resMapper()}
	app, db, h := aiConfirmApp(t, cc)
	convID := seedPendingCreate(t, db, h)

	path := "/api/v1/ai/conversations/" + strconv.FormatUint(uint64(convID), 10) + "/confirm"
	if w := aiReq(app, "POST", path, "2", false, map[string]any{"approved": true}); w.Code != http.StatusForbidden {
		t.Fatalf("non-owner confirm should be 403, got %d %s", w.Code, w.Body.String())
	}
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

	// Save model config with a key (enabled is separate now — not set here).
	body := map[string]any{"base_url": "https://x/v1", "api_key": "sk-1", "model_id": "m"}
	if w := aiReq(app, "PUT", "/api/v1/ai/config", "1", true, body); w.Code != http.StatusOK {
		t.Fatalf("put config: %d %s", w.Code, w.Body.String())
	}
	// Enabling is a separate endpoint/permission (ai:create).
	if w := aiReq(app, "PUT", "/api/v1/ai/enabled", "1", true, map[string]any{"enabled": true}); w.Code != http.StatusOK {
		t.Fatalf("put enabled: %d %s", w.Code, w.Body.String())
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

