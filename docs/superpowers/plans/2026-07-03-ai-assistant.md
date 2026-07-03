# OmniKube AI Assistant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a global "OmniKube" AI assistant that operates the selected cluster via natural language, gated by AI-config ∩ user-RBAC, with write-op confirmation and streaming.

**Architecture:** Autonomous ReAct agent (Eino) on the Go backend exposes k8s operations as tools, each double-gated (AI grant + user RBAC); writes pause for confirmation via interrupt/resume; the React frontend streams the run over WebSocket. Delivered in 4 phases; **this document details Phase 1 (config foundation) in full**, and scopes Phases 2–4 (their bite-sized plans are written after Phase 1 lands, once Eino's runtime API is verified against the pinned version).

**Tech Stack:** Go · Gin · GORM · Casbin · crypto/AES-GCM · React 18 · TypeScript · AntD 5 · react-i18next · (Phase 2+) `github.com/cloudwego/eino`

---

## Phasing

1. **Config foundation** (this plan, full detail): data model, `ai` global RBAC area, config/grants/status APIs, AI config page, global assistant launcher shell with the ⚠️ not-configured state. No agent yet.
2. **Read-only agent**: Eino + OpenAI-compatible ChatModel + read tools + double gate + WebSocket streaming + chat panel that can query.
3. **Write + confirmation**: write tools + interrupt/resume + confirm card + audit.
4. **Persistence + history UI + i18n polish**.

Spec: `docs/superpowers/specs/2026-07-03-ai-assistant-design.md`.

---

## File Structure (Phase 1)

**Backend**
- Modify `backend/internal/model/model.go` — add `AIConfig`, `AIGrant` structs + `TableName()`.
- Modify `backend/internal/database/database.go` — add the two models to `Migrate`.
- Modify `backend/internal/rbac/resources.go` — add `"ai"` to `validGlobalAreas`.
- Modify `backend/internal/rbac/global.go` — add `"ai": {"view","edit"}` to `AllGlobalPerms`.
- Modify `backend/internal/handler/handler.go` — add `Cipher *crypto.Cipher` field.
- Modify `backend/internal/app/providers.go` — pass the cipher into `provideHandler`.
- Create `backend/internal/ai/store.go` — config/grants persistence with api_key encryption.
- Create `backend/internal/ai/store_test.go`.
- Create `backend/internal/handler/ai.go` — `GetAIConfig/PutAIConfig/GetAIGrants/PutAIGrants/GetAIStatus`.
- Create `backend/internal/handler/ai_test.go`.
- Modify `backend/internal/router/router.go` — register `/ai/*` routes.

**Frontend**
- Modify `frontend/src/api/role.ts` — add `'ai'` to `GlobalArea`, `GLOBAL_AREAS`, `SYSTEM_AREAS`, and `actionsForGlobalArea`.
- Create `frontend/src/api/ai.ts` — AI config/grants/status client.
- Create `frontend/src/pages/ai/AiConfig.tsx` — model form + per-cluster grants matrix.
- Create `frontend/src/components/AiAssistant.tsx` — floating launcher + ⚠️ not-configured state + placeholder panel.
- Modify `frontend/src/App.tsx` — add the `/ai/config` route and mount `<AiAssistant/>`.
- Modify `frontend/src/nav.ts` — include `ai` in the "has any system menu" check.
- Modify `frontend/src/components/Sidebar.tsx` — add the AI config menu entry (gated by `ai:view`).
- Modify all 7 `frontend/src/i18n/locales/*.ts` — `ai.*` + `role.area.ai` keys.
- Test `frontend/src/test/aiConfig.test.tsx`, `frontend/src/test/aiAssistant.test.tsx`.

---

## Task 1: Backend — AI models + migration

**Files:**
- Modify: `backend/internal/model/model.go` (append before the final helpers)
- Modify: `backend/internal/database/database.go` (Migrate list)
- Test: `backend/internal/database/database_test.go` (add a migrate assertion) — if absent, create it.

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/database/database_test.go` (create the file with this content if it does not exist):

```go
package database

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/model"
)

func TestMigrateCreatesAITables(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if !db.Migrator().HasTable(&model.AIConfig{}) {
		t.Error("ok_ai_config table missing")
	}
	if !db.Migrator().HasTable(&model.AIGrant{}) {
		t.Error("ok_ai_grants table missing")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/database/ -run TestMigrateCreatesAITables`
Expected: FAIL — `model.AIConfig` undefined.

- [ ] **Step 3: Add the models**

Append to `backend/internal/model/model.go` (before any trailing helpers; alongside the other structs):

```go
// AIConfig 是全局唯一的 AI 助手模型配置（单行，id 恒为 1）。
type AIConfig struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Enabled      bool      `json:"enabled"`
	BaseURL      string    `gorm:"type:text" json:"base_url"`
	APIKeyEnc    string    `gorm:"type:text" json:"-"` // crypto.Cipher 加密后的 api_key
	ModelID      string    `gorm:"size:200" json:"model_id"`
	Temperature  float64   `json:"temperature"`
	SystemPrompt string    `gorm:"type:text" json:"system_prompt"`
	MaxSteps     int       `json:"max_steps"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (AIConfig) TableName() string { return "ok_ai_config" }

// AIGrant 是某集群下 AI 助手被授予的「资源 × 操作」范围（每集群一行）。
// Operations 与 RoleRule.Operations 同格式：JSON map[resource][]action。
type AIGrant struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	ClusterID  string    `gorm:"size:50;uniqueIndex;not null" json:"cluster_id"`
	Operations string    `gorm:"type:text" json:"operations"`
	UpdatedAt  time.Time `json:"updated_at"`
}

func (AIGrant) TableName() string { return "ok_ai_grants" }
```

Add the two models to `Migrate` in `backend/internal/database/database.go` (inside the `db.AutoMigrate(...)` list):

```go
		&model.AIConfig{},
		&model.AIGrant{},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/database/ -run TestMigrateCreatesAITables`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/model/model.go backend/internal/database/database.go backend/internal/database/database_test.go
git commit -m "feat(ai): add ok_ai_config / ok_ai_grants models + migration"
```

---

## Task 2: Backend — `ai` global RBAC area

**Files:**
- Modify: `backend/internal/rbac/resources.go:66`
- Modify: `backend/internal/rbac/global.go` (`AllGlobalPerms`)
- Test: `backend/internal/rbac/resources_test.go` (add) or new test file.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/rbac/ai_area_test.go`:

```go
package rbac

import "testing"

func TestAIGlobalArea(t *testing.T) {
	if !IsValidGlobalArea("ai") {
		t.Error("ai must be a valid global area")
	}
	if acts := AllGlobalPerms()["ai"]; len(acts) != 2 || acts[0] != "view" || acts[1] != "edit" {
		t.Errorf("ai global perms want [view edit], got %v", acts)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/rbac/ -run TestAIGlobalArea`
Expected: FAIL — `ai` not a valid area.

- [ ] **Step 3: Add the area**

In `backend/internal/rbac/resources.go`, line 66:

```go
var validGlobalAreas = setOf("clusters", "users", "roles", "releases", "audit", "ai")
```

In `backend/internal/rbac/global.go`, inside the returned map of `AllGlobalPerms`, add:

```go
		"ai": {"view", "edit"},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/rbac/ -run TestAIGlobalArea`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/rbac/resources.go backend/internal/rbac/global.go backend/internal/rbac/ai_area_test.go
git commit -m "feat(ai): add ai global RBAC area (view/edit)"
```

---

## Task 3: Backend — wire Cipher into Handler

**Files:**
- Modify: `backend/internal/handler/handler.go:15-21`
- Modify: `backend/internal/app/providers.go` (`provideHandler`)

- [ ] **Step 1: Add the field**

In `backend/internal/handler/handler.go`, add to the struct:

```go
type Handler struct {
	DB      *gorm.DB
	JWT     *auth.JWTManager
	Pool    *cluster.ClusterPool
	RBAC    *rbac.Service
	Cipher  *crypto.Cipher
	Captcha *captcha.Store
}
```

Add the import `"omnikube/internal/crypto"` to `handler.go` if not present.

- [ ] **Step 2: Pass it in the provider**

In `backend/internal/app/providers.go`, change `provideHandler`:

```go
func provideHandler(db *gorm.DB, jm *auth.JWTManager, pool *cluster.ClusterPool, rbacSvc *rbac.Service, cipher *crypto.Cipher) *handler.Handler {
	return &handler.Handler{DB: db, JWT: jm, Pool: pool, RBAC: rbacSvc, Cipher: cipher, Captcha: captcha.NewStore()}
}
```

`provideCipher` already exists and is in `ProviderSet`, so wire will inject it.

- [ ] **Step 3: Verify it builds**

Run: `cd backend && go build ./...`
Expected: builds clean (wire already re-generated in-tree; if `InitializeApp` is hand-wired in `wire_gen.go`, update that call site to pass `cipher` — grep `provideHandler(` in `backend/internal/app/` and add the cipher arg).

- [ ] **Step 4: Commit**

```bash
git add backend/internal/handler/handler.go backend/internal/app/
git commit -m "feat(ai): expose crypto.Cipher on Handler"
```

---

## Task 4: Backend — AI config/grants store (with encryption)

**Files:**
- Create: `backend/internal/ai/store.go`
- Test: `backend/internal/ai/store_test.go`

- [ ] **Step 1: Write the failing test**

Create `backend/internal/ai/store_test.go`:

```go
package ai

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/crypto"
	"omnikube/internal/database"
)

func testDB(t *testing.T) *gorm.DB {
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

func testCipher(t *testing.T) *crypto.Cipher {
	t.Helper()
	c, err := crypto.New(make([]byte, 32)) // 32-byte zero key is fine for tests
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestConfigRoundTripEncryptsKey(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	s := NewStore(db, cipher)

	if err := s.SaveConfig(ConfigInput{Enabled: true, BaseURL: "https://api.x/v1", APIKey: "secret-key", ModelID: "gpt-x"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !got.Enabled || got.BaseURL != "https://api.x/v1" || got.ModelID != "gpt-x" {
		t.Fatalf("config not persisted: %+v", got)
	}
	if got.APIKey != "secret-key" {
		t.Fatalf("api key not decrypted, got %q", got.APIKey)
	}
	if !got.HasKey {
		t.Fatal("HasKey should be true")
	}
}

func TestSaveConfigBlankKeyKeepsExisting(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	s := NewStore(db, cipher)
	_ = s.SaveConfig(ConfigInput{BaseURL: "u", APIKey: "k1", ModelID: "m"})
	// Second save with empty APIKey must keep k1.
	_ = s.SaveConfig(ConfigInput{BaseURL: "u2", APIKey: "", ModelID: "m"})
	got, _ := s.LoadConfig()
	if got.APIKey != "k1" {
		t.Fatalf("blank key should keep existing, got %q", got.APIKey)
	}
	if got.BaseURL != "u2" {
		t.Fatalf("other fields should update, got %q", got.BaseURL)
	}
}

func TestGrantsRoundTrip(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	s := NewStore(db, cipher)
	ops := map[string][]string{"deployments": {"view", "create"}}
	if err := s.SaveGrant("c1", ops); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadGrant("c1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got["deployments"]) != 2 {
		t.Fatalf("grant not persisted: %+v", got)
	}
	// Unknown cluster → empty map, no error.
	empty, err := s.LoadGrant("nope")
	if err != nil || len(empty) != 0 {
		t.Fatalf("unknown cluster should be empty, got %v err %v", empty, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/ai/`
Expected: FAIL — package `ai` has no `NewStore`.

- [ ] **Step 3: Implement the store**

Create `backend/internal/ai/store.go`:

```go
// Package ai holds the OmniKube AI assistant's configuration, permission
// grants, and (later phases) the ReAct agent runtime.
package ai

import (
	"encoding/json"

	"gorm.io/gorm"

	"omnikube/internal/crypto"
	"omnikube/internal/model"
)

// configRowID is the fixed primary key of the single global AI config row.
const configRowID = 1

// ConfigInput is the writable AI model config. An empty APIKey means "keep the
// stored key" (so the frontend never has to round-trip the secret).
type ConfigInput struct {
	Enabled      bool
	BaseURL      string
	APIKey       string
	ModelID      string
	Temperature  float64
	SystemPrompt string
	MaxSteps     int
}

// Config is the decrypted, readable AI config. APIKey is only populated for
// server-side use (agent); handlers must mask it before returning to clients.
type Config struct {
	Enabled      bool
	BaseURL      string
	APIKey       string
	HasKey       bool
	ModelID      string
	Temperature  float64
	SystemPrompt string
	MaxSteps     int
}

type Store struct {
	db     *gorm.DB
	cipher *crypto.Cipher
}

func NewStore(db *gorm.DB, cipher *crypto.Cipher) *Store {
	return &Store{db: db, cipher: cipher}
}

// LoadConfig returns the current config (decrypted). Zero-value Config when unset.
func (s *Store) LoadConfig() (Config, error) {
	var row model.AIConfig
	err := s.db.First(&row, configRowID).Error
	if err == gorm.ErrRecordNotFound {
		return Config{}, nil
	}
	if err != nil {
		return Config{}, err
	}
	out := Config{
		Enabled: row.Enabled, BaseURL: row.BaseURL, ModelID: row.ModelID,
		Temperature: row.Temperature, SystemPrompt: row.SystemPrompt, MaxSteps: row.MaxSteps,
		HasKey: row.APIKeyEnc != "",
	}
	if row.APIKeyEnc != "" {
		plain, err := s.cipher.Decrypt(row.APIKeyEnc)
		if err != nil {
			return Config{}, err
		}
		out.APIKey = plain
	}
	return out, nil
}

// SaveConfig upserts the single config row; a blank APIKey keeps the stored one.
func (s *Store) SaveConfig(in ConfigInput) error {
	var row model.AIConfig
	err := s.db.First(&row, configRowID).Error
	if err != nil && err != gorm.ErrRecordNotFound {
		return err
	}
	row.ID = configRowID
	row.Enabled = in.Enabled
	row.BaseURL = in.BaseURL
	row.ModelID = in.ModelID
	row.Temperature = in.Temperature
	row.SystemPrompt = in.SystemPrompt
	row.MaxSteps = in.MaxSteps
	if in.APIKey != "" {
		enc, err := s.cipher.Encrypt(in.APIKey)
		if err != nil {
			return err
		}
		row.APIKeyEnc = enc
	}
	return s.db.Save(&row).Error
}

// LoadGrant returns the AI operations matrix for a cluster (empty when unset).
func (s *Store) LoadGrant(clusterID string) (map[string][]string, error) {
	var row model.AIGrant
	err := s.db.Where("cluster_id = ?", clusterID).First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return map[string][]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string][]string{}
	if row.Operations != "" {
		if err := json.Unmarshal([]byte(row.Operations), &out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// SaveGrant upserts the AI operations matrix for a cluster.
func (s *Store) SaveGrant(clusterID string, ops map[string][]string) error {
	raw, err := json.Marshal(ops)
	if err != nil {
		return err
	}
	var row model.AIGrant
	err = s.db.Where("cluster_id = ?", clusterID).First(&row).Error
	if err != nil && err != gorm.ErrRecordNotFound {
		return err
	}
	row.ClusterID = clusterID
	row.Operations = string(raw)
	return s.db.Save(&row).Error
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/ai/`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/ai/
git commit -m "feat(ai): config + grants store with encrypted api key"
```

---

## Task 5: Backend — AI handlers

**Files:**
- Create: `backend/internal/handler/ai.go`
- Test: `backend/internal/handler/ai_test.go`

- [ ] **Step 1: Write the failing test**

Create `backend/internal/handler/ai_test.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"testing"
)

// aiTestHandler builds a Handler with an in-memory DB + a zero-key cipher.
// Reuse the existing test helpers in this package (see release_test.go for the
// DB + cipher + gin setup pattern) to construct `h` and a gin engine `app`
// with routes: GET/PUT /api/v1/ai/config, GET/PUT /api/v1/ai/grants,
// GET /api/v1/ai/status — each wrapped with a header-injected admin user id.

func TestAIConfigMaskAndStatus(t *testing.T) {
	app, _ := aiApp(t) // helper you add below in this file

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
```

> Note: `aiApp` and `aiReq` are small helpers to add at the bottom of `ai_test.go`, mirroring `resApp`/`resReq` in `release_test.go`/`resource_test.go` (in-memory sqlite, `database.Migrate`, `crypto.New(make([]byte,32))`, a gin engine that sets `user_id`/`is_admin` from headers, and registers the five `/ai/*` routes calling the handler methods directly). Copy that existing pattern; do not invent a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run TestAIConfigMaskAndStatus`
Expected: FAIL — `GetAIStatus` etc. undefined.

- [ ] **Step 3: Implement the handlers**

Create `backend/internal/handler/ai.go`:

```go
package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"omnikube/internal/ai"
)

func (h *Handler) aiStore() *ai.Store { return ai.NewStore(h.DB, h.Cipher) }

// GetAIStatus GET /ai/status — any logged-in user; drives the ⚠️ launcher state.
func (h *Handler) GetAIStatus(c *gin.Context) {
	cfg, err := h.aiStore().LoadConfig()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "读取 AI 配置失败"})
		return
	}
	configured := cfg.BaseURL != "" && cfg.ModelID != "" && cfg.HasKey
	c.JSON(http.StatusOK, gin.H{"enabled": cfg.Enabled, "configured": configured})
}

// GetAIConfig GET /ai/config — RequireGlobalPerm("ai","view"); api_key masked.
func (h *Handler) GetAIConfig(c *gin.Context) {
	cfg, err := h.aiStore().LoadConfig()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "读取 AI 配置失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"enabled":       cfg.Enabled,
		"base_url":      cfg.BaseURL,
		"model_id":      cfg.ModelID,
		"temperature":   cfg.Temperature,
		"system_prompt": cfg.SystemPrompt,
		"max_steps":     cfg.MaxSteps,
		"has_key":       cfg.HasKey,
	})
}

type aiConfigReq struct {
	Enabled      bool    `json:"enabled"`
	BaseURL      string  `json:"base_url"`
	APIKey       string  `json:"api_key"` // "" = keep existing
	ModelID      string  `json:"model_id"`
	Temperature  float64 `json:"temperature"`
	SystemPrompt string  `json:"system_prompt"`
	MaxSteps     int     `json:"max_steps"`
}

// PutAIConfig PUT /ai/config — RequireGlobalPerm("ai","edit").
func (h *Handler) PutAIConfig(c *gin.Context) {
	var req aiConfigReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	err := h.aiStore().SaveConfig(ai.ConfigInput{
		Enabled: req.Enabled, BaseURL: req.BaseURL, APIKey: req.APIKey, ModelID: req.ModelID,
		Temperature: req.Temperature, SystemPrompt: req.SystemPrompt, MaxSteps: req.MaxSteps,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "保存 AI 配置失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "已保存"})
}

// GetAIGrants GET /ai/grants?cluster_id= — RequireGlobalPerm("ai","view").
func (h *Handler) GetAIGrants(c *gin.Context) {
	clusterID := c.Query("cluster_id")
	if clusterID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "缺少 cluster_id"})
		return
	}
	ops, err := h.aiStore().LoadGrant(clusterID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "读取 AI 权限失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"cluster_id": clusterID, "operations": ops})
}

type aiGrantReq struct {
	Operations map[string][]string `json:"operations"`
}

// PutAIGrants PUT /ai/grants?cluster_id= — RequireGlobalPerm("ai","edit").
func (h *Handler) PutAIGrants(c *gin.Context) {
	clusterID := c.Query("cluster_id")
	if clusterID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "缺少 cluster_id"})
		return
	}
	var req aiGrantReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	if err := h.aiStore().SaveGrant(clusterID, req.Operations); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "保存 AI 权限失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "已保存"})
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/handler/ -run TestAIConfigMaskAndStatus`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/ai.go backend/internal/handler/ai_test.go
git commit -m "feat(ai): config/grants/status handlers"
```

---

## Task 6: Backend — register `/ai/*` routes

**Files:**
- Modify: `backend/internal/router/router.go` (inside the `authed` group)

- [ ] **Step 1: Add routes**

In `backend/internal/router/router.go`, inside the `authed` group (near the releases/audit routes), add:

```go
			// AI 助手：状态任意登录用户可读（驱动 ⚠️ 态）；配置/权限按 global-perm ai。
			authed.GET("/ai/status", h.GetAIStatus)
			authed.GET("/ai/config", middleware.RequireGlobalPerm(h.GlobalPermCheck, "ai", "view"), h.GetAIConfig)
			authed.PUT("/ai/config", middleware.RequireGlobalPerm(h.GlobalPermCheck, "ai", "edit"), h.PutAIConfig)
			authed.GET("/ai/grants", middleware.RequireGlobalPerm(h.GlobalPermCheck, "ai", "view"), h.GetAIGrants)
			authed.PUT("/ai/grants", middleware.RequireGlobalPerm(h.GlobalPermCheck, "ai", "edit"), h.PutAIGrants)
```

- [ ] **Step 2: Verify build + all backend tests**

Run: `cd backend && go build ./... && go test ./...`
Expected: builds; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/router/router.go
git commit -m "feat(ai): register /ai config/grants/status routes"
```

---

## Task 7: Frontend — add `ai` to the RBAC role model

**Files:**
- Modify: `frontend/src/api/role.ts:107,113,114` + `actionsForGlobalArea`
- Modify: all 7 `frontend/src/i18n/locales/*.ts` — `role.area.ai`
- Test: `frontend/src/test/roles.test.tsx` (extend if it asserts areas) — otherwise rely on tsc.

- [ ] **Step 1: Extend the types + lists**

In `frontend/src/api/role.ts`:

```ts
export type GlobalArea = 'clusters' | 'users' | 'roles' | 'releases' | 'audit' | 'ai';
```
```ts
export const SYSTEM_AREAS: Exclude<GlobalArea, 'releases' | 'audit'>[] = ['clusters', 'users', 'roles', 'ai'];
export const GLOBAL_AREAS: GlobalArea[] = ['clusters', 'users', 'roles', 'releases', 'audit', 'ai'];
```

Find `actionsForGlobalArea` in `role.ts`. It currently returns `['view']` for `releases`/`audit` and the full set for the rest. Add an `ai` case returning `['view', 'edit']`:

```ts
export function actionsForGlobalArea(area: GlobalArea): GlobalAction[] {
  if (area === 'releases' || area === 'audit') return ['view'];
  if (area === 'ai') return ['view', 'edit'];
  return ['view', 'create', 'edit', 'delete'];
}
```
(Adapt to the exact existing signature/return type of that function; keep its style.)

- [ ] **Step 2: Add the label i18n key**

Add `ai: '<label>'` under the `role.area` object in each locale (`role.area.ai`):

```
zh: 'AI 助手'  | en: 'AI assistant' | ja: 'AI アシスタント' | ko: 'AI 어시스턴트'
fr: 'Assistant IA' | de: 'KI-Assistent' | es: 'Asistente de IA'
```
(If the role global matrix labels areas via `role.area.<area>` — confirm the exact key path used by the role editor and match it.)

- [ ] **Step 3: Verify**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/test/roles.test.tsx`
Expected: PASS. The role editor's global-permission matrix now shows an "AI 助手" row with view/edit.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/role.ts frontend/src/i18n/locales/*.ts
git commit -m "feat(ai): add ai global area to the role permission model"
```

---

## Task 8: Frontend — AI API client

**Files:**
- Create: `frontend/src/api/ai.ts`

- [ ] **Step 1: Implement the client**

Create `frontend/src/api/ai.ts` (mirror the style of `src/api/cluster.ts`):

```ts
import client from './client';
import type { Operations } from './role';

export interface AiStatus {
  enabled: boolean;
  configured: boolean;
}

export interface AiConfig {
  enabled: boolean;
  base_url: string;
  model_id: string;
  temperature: number;
  system_prompt: string;
  max_steps: number;
  has_key: boolean;
}

export interface AiConfigInput {
  enabled: boolean;
  base_url: string;
  api_key?: string; // omit/empty = keep existing
  model_id: string;
  temperature: number;
  system_prompt: string;
  max_steps: number;
}

export const aiApi = {
  status: () => client.get<AiStatus>('/ai/status').then((r) => r.data),
  getConfig: () => client.get<AiConfig>('/ai/config').then((r) => r.data),
  putConfig: (body: AiConfigInput) => client.put('/ai/config', body).then((r) => r.data),
  getGrants: (clusterId: string) =>
    client
      .get<{ cluster_id: string; operations: Operations }>('/ai/grants', { params: { cluster_id: clusterId } })
      .then((r) => r.data.operations ?? {}),
  putGrants: (clusterId: string, operations: Operations) =>
    client.put('/ai/grants', { operations }, { params: { cluster_id: clusterId } }).then((r) => r.data),
};
```

- [ ] **Step 2: Verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/ai.ts
git commit -m "feat(ai): frontend AI api client"
```

---

## Task 9: Frontend — AI config page + route + nav

**Files:**
- Create: `frontend/src/pages/ai/AiConfig.tsx`
- Modify: `frontend/src/App.tsx` (import + `<GlobalRoute area="ai">` route at `/ai/config`)
- Modify: `frontend/src/nav.ts` (include `ai` in the "any system menu" check)
- Modify: `frontend/src/components/Sidebar.tsx` (AI config menu entry gated by `ai:view`)
- Modify: 7 locales — `nav.aiConfig` + `ai.*` config-page keys
- Test: `frontend/src/test/aiConfig.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/test/aiConfig.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './render';

vi.mock('../store/ctx', () => ({
  useCtxStore: () => ({ currentCluster: 'c1', currentNamespace: null }),
  getCurrentCluster: () => 'c1',
}));
vi.mock('../store/caps', () => ({ useCapabilities: () => ({ can: () => true }) }));
vi.mock('../api/ai', () => ({
  aiApi: {
    getConfig: vi.fn().mockResolvedValue({
      enabled: false, base_url: '', model_id: '', temperature: 0, system_prompt: '', max_steps: 0, has_key: false,
    }),
    putConfig: vi.fn().mockResolvedValue({}),
    getGrants: vi.fn().mockResolvedValue({}),
    putGrants: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('../store/clusters', () => ({
  useClusterStore: () => ({ clusters: [{ id: 'c1', name: 'C1' }], loaded: true, load: vi.fn() }),
}));

import AiConfig from '../pages/ai/AiConfig';

describe('AiConfig', () => {
  beforeEach(() => vi.clearAllMocks());
  it('renders the model form fields', async () => {
    renderWithProviders(<AiConfig />);
    await waitFor(() => expect(screen.getByLabelText(/base ?url/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/test/aiConfig.test.tsx`
Expected: FAIL — cannot find `../pages/ai/AiConfig`.

- [ ] **Step 3: Implement the page**

Create `frontend/src/pages/ai/AiConfig.tsx`. Model form (enabled switch, base_url, api_key masked password with placeholder `••••••` when `has_key`, model_id, temperature, system_prompt, max_steps) + a cluster selector that loads/saves that cluster's grants via `ResourceOpsMatrix`. Use `Form`, `Input`, `Switch`, `InputNumber`, `Select`, `Button`, `Card` from antd; `useApi` for load; `AntApp.useApp().message` for toasts; strings via `t('ai.*')`. Gate the Save button on `useCapabilities().can('ai','edit')` (import as needed) — or rely on the route/global gate. Key behaviors:
  - On mount: `aiApi.getConfig()` → fill form; api_key field starts empty with placeholder indicating a key is set when `has_key`.
  - Save config: `aiApi.putConfig(values)` (omit api_key if the field is blank).
  - Cluster grants: `Select` of clusters (from `useClusterStore`); on change `aiApi.getGrants(id)` → feed `ResourceOpsMatrix operations` (import from `../../pages/roles/Roles` — export `ResourceOpsMatrix` is already `export function`); on matrix change keep local state; Save grants button → `aiApi.putGrants(id, ops)`.

Minimum viable JSX that satisfies the test (labels "Base URL" and "Model"):

```tsx
import { useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Form, Input, InputNumber, Select, Switch } from 'antd';
import { useTranslation } from 'react-i18next';
import { aiApi } from '../../api/ai';
import { useClusterStore } from '../../store/clusters';
import { ResourceOpsMatrix } from '../roles/Roles';
import type { Operations } from '../../api/role';

export default function AiConfig() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [hasKey, setHasKey] = useState(false);
  const { clusters, load: loadClusters } = useClusterStore();
  const [grantCluster, setGrantCluster] = useState<string>();
  const [ops, setOps] = useState<Operations>({});

  useEffect(() => { loadClusters(); }, [loadClusters]);
  useEffect(() => {
    aiApi.getConfig().then((c) => {
      setHasKey(c.has_key);
      form.setFieldsValue({ ...c, api_key: '' });
    });
  }, [form]);
  useEffect(() => {
    if (grantCluster) aiApi.getGrants(grantCluster).then(setOps);
  }, [grantCluster]);

  const saveConfig = async () => {
    const v = await form.validateFields();
    await aiApi.putConfig(v);
    message.success(t('ai.saved'));
    setHasKey(!!v.api_key || hasKey);
  };
  const saveGrants = async () => {
    if (!grantCluster) return;
    await aiApi.putGrants(grantCluster, ops);
    message.success(t('ai.saved'));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title={t('ai.modelConfig')}>
        <Form form={form} layout="vertical">
          <Form.Item label={t('ai.enabled')} name="enabled" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item label="Base URL" name="base_url"><Input placeholder="https://api.openai.com/v1" /></Form.Item>
          <Form.Item label={t('ai.apiKey')} name="api_key">
            <Input.Password placeholder={hasKey ? '••••••（已设置，留空保留）' : ''} autoComplete="off" />
          </Form.Item>
          <Form.Item label="Model" name="model_id"><Input placeholder="gpt-4o-mini" /></Form.Item>
          <Form.Item label={t('ai.temperature')} name="temperature"><InputNumber min={0} max={2} step={0.1} /></Form.Item>
          <Form.Item label={t('ai.maxSteps')} name="max_steps"><InputNumber min={1} max={50} /></Form.Item>
          <Form.Item label={t('ai.systemPrompt')} name="system_prompt"><Input.TextArea rows={3} /></Form.Item>
          <Button type="primary" onClick={saveConfig}>{t('ai.save')}</Button>
        </Form>
      </Card>

      <Card title={t('ai.permScope')}>
        <Select
          style={{ width: 280, marginBottom: 12 }}
          placeholder={t('ai.selectCluster')}
          value={grantCluster}
          onChange={setGrantCluster}
          options={clusters.map((c) => ({ value: c.id, label: c.name || c.id }))}
        />
        {grantCluster && (
          <>
            <ResourceOpsMatrix operations={ops} onChange={setOps} />
            <div style={{ marginTop: 12 }}>
              <Button type="primary" onClick={saveGrants}>{t('ai.save')}</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/test/aiConfig.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add route + nav**

In `frontend/src/App.tsx`: `import AiConfig from './pages/ai/AiConfig';` and add:

```tsx
        <Route path="/ai/config" element={<GlobalRoute area="ai"><AiConfig /></GlobalRoute>} />
```

In `frontend/src/nav.ts`, extend the "has any system menu" check to include `ai`:

```ts
    canGlobal('clusters', 'view', user) ||
    canGlobal('users', 'view', user) ||
    canGlobal('roles', 'view', user) ||
    canGlobal('ai', 'view', user) ||
    canGlobal('audit', 'view', user)
```

In `frontend/src/components/Sidebar.tsx`, add an entry under the system-management group, gated by `canGlobal('ai','view', user)`, linking to `/ai/config` with label `t('nav.aiConfig')` and a robot icon (`RobotOutlined`). Follow the exact pattern used for the clusters/users/roles entries in that file.

Add i18n keys (`nav.aiConfig`, `ai.modelConfig`, `ai.enabled`, `ai.apiKey`, `ai.temperature`, `ai.maxSteps`, `ai.systemPrompt`, `ai.permScope`, `ai.selectCluster`, `ai.save`, `ai.saved`) to all 7 locales. zh values: 配置(nav) `AI 配置`; `模型配置`/`启用`/`API Key`/`温度`/`最大步数`/`系统提示`/`权限范围`/`选择集群`/`保存`/`已保存`. Provide sensible translations for en/ja/ko/fr/de/es.

- [ ] **Step 6: Verify + commit**

Run: `cd frontend && npx tsc --noEmit && npx vitest run && npx eslint . --max-warnings 0`
Expected: all green.

```bash
git add frontend/src/pages/ai/AiConfig.tsx frontend/src/App.tsx frontend/src/nav.ts frontend/src/components/Sidebar.tsx frontend/src/i18n/locales/*.ts frontend/src/test/aiConfig.test.tsx
git commit -m "feat(ai): AI config page + route + system-management menu"
```

---

## Task 10: Frontend — global assistant launcher shell (⚠️ state)

**Files:**
- Create: `frontend/src/components/AiAssistant.tsx`
- Modify: `frontend/src/App.tsx` — mount `<AiAssistant/>` inside the authenticated layout (next to the routed content, so it floats globally)
- Modify: 7 locales — `ai.assistant*` keys
- Test: `frontend/src/test/aiAssistant.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/test/aiAssistant.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './render';

const statusMock = vi.fn();
vi.mock('../api/ai', () => ({ aiApi: { status: () => statusMock() } }));

import AiAssistant from '../components/AiAssistant';

describe('AiAssistant launcher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a warning state and message when AI is not configured', async () => {
    statusMock.mockResolvedValue({ enabled: false, configured: false });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<AiAssistant />);
    const btn = await screen.findByLabelText(/omnikube assistant/i);
    await user.click(btn);
    await waitFor(() =>
      expect(screen.getByText(/contact your administrator|请联系管理员开启/i)).toBeInTheDocument(),
    );
  });

  it('opens the panel when AI is enabled+configured', async () => {
    statusMock.mockResolvedValue({ enabled: true, configured: true });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<AiAssistant />);
    const btn = await screen.findByLabelText(/omnikube assistant/i);
    await user.click(btn);
    await waitFor(() => expect(screen.getByPlaceholderText(/ask omnikube|向 omnikube 提问/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/test/aiAssistant.test.tsx`
Expected: FAIL — no `../components/AiAssistant`.

- [ ] **Step 3: Implement the launcher shell**

Create `frontend/src/components/AiAssistant.tsx`: a fixed bottom-right floating button (`RobotOutlined`), `aria-label="OmniKube assistant"`. On mount call `aiApi.status()`. If not (enabled && configured), the button shows a ⚠️ `Badge`; clicking shows `message.warning(t('ai.notConfigured'))` (or a small popover) and does not open the panel. If enabled+configured, clicking opens a `Drawer` with the chat placeholder: a message area (empty state `t('ai.comingSoon')` for Phase 1) + an input with placeholder `t('ai.askPlaceholder')` (Phase 2 wires the WebSocket). Strings via i18n.

```tsx
import { useEffect, useState } from 'react';
import { App as AntApp, Badge, Button, Drawer, Empty, Input, Tooltip } from 'antd';
import { RobotOutlined, WarningOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { aiApi } from '../api/ai';

export default function AiAssistant() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    aiApi
      .status()
      .then((s) => setReady(s.enabled && s.configured))
      .catch(() => setReady(false));
  }, []);

  const onClick = () => {
    if (!ready) {
      message.warning(t('ai.notConfigured'));
      return;
    }
    setOpen(true);
  };

  return (
    <>
      <Tooltip title="OmniKube">
        <Badge count={ready ? 0 : <WarningOutlined style={{ color: '#F59E0B' }} />} offset={[-4, 4]}>
          <Button
            aria-label="OmniKube assistant"
            type="primary"
            shape="circle"
            size="large"
            icon={<RobotOutlined />}
            onClick={onClick}
            style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 1000 }}
          />
        </Badge>
      </Tooltip>
      <Drawer open={open} onClose={() => setOpen(false)} width="min(480px, 92vw)" title="OmniKube">
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <Empty description={t('ai.comingSoon')} />
          </div>
          <Input.TextArea rows={2} placeholder={t('ai.askPlaceholder')} disabled />
        </div>
      </Drawer>
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/test/aiAssistant.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount globally + i18n**

In `frontend/src/App.tsx`, render `<AiAssistant/>` inside the authenticated app layout (the same wrapper that renders `<AppRoutes/>` for logged-in users), so it floats on every page. Add i18n keys `ai.notConfigured` (zh: `未配置或未开启 AI，请联系管理员开启 AI 功能`), `ai.comingSoon`, `ai.askPlaceholder` to all 7 locales.

- [ ] **Step 6: Verify + commit**

Run: `cd frontend && npx tsc --noEmit && npx vitest run && npx eslint . --max-warnings 0`
Expected: all green.

```bash
git add frontend/src/components/AiAssistant.tsx frontend/src/App.tsx frontend/src/i18n/locales/*.ts frontend/src/test/aiAssistant.test.tsx
git commit -m "feat(ai): global assistant launcher shell with not-configured warning state"
```

---

## Task 11: Phase 1 acceptance

- [ ] Backend: `cd backend && go build ./... && go test ./...` → all green.
- [ ] Frontend: `cd frontend && npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && npm run build` → all green.
- [ ] Manual smoke (optional, against a running stack): admin opens 系统管理 › AI 配置, sets base_url/api_key/model, enables it, sets a cluster's grant matrix; the floating OmniKube button loses its ⚠️ and opens the placeholder panel; a role WITHOUT `ai:view` sees neither the menu nor the config page (redirected), and the launcher shows ⚠️ with the "contact admin" message.

---

# Phases 2–4 (scope only — detailed plans written after Phase 1 lands)

These depend on Eino's **exact** runtime API (ChatModelAgent / ToolsConfig / Runner / interrupt-resume / OpenAI ChatModel component), which must be verified against the pinned version (`go get github.com/cloudwego/eino@<version>` then `go doc`) before writing bite-sized code — otherwise the steps would be guesses. Each phase below is a self-contained, testable increment.

## Phase 2 — Read-only agent (query over WebSocket)

- Add `internal/ai/agent.go`: build a Eino `ChatModelAgent` from `Config` (OpenAI-compatible ChatModel: base_url/api_key/model_id/temperature/system_prompt) with a tools node.
- Add `internal/ai/tools.go`: `list_resources`, `get_resource` (read-only) implemented over `cluster.ClusterPool` + dynamic client; JSON-schema params (resource, namespace?, name?).
- Add `internal/ai/guard.go`: `Allow(userID, cluster, namespace, resource, action) bool` = `aiGrant[resource] ∋ action` **AND** `rbac.Authorize(...)`. Read tools call it before executing; on deny return a structured "permission denied" observation.
- Add `internal/ai/conversation.go` + models `ok_ai_conversations`, `ok_ai_messages` (migration) for persistence.
- Add WS handler `internal/ws` (or `internal/ai/ws.go`) `GET /ai/chat`: query-token auth (reuse the exec/logs token pattern), receive `{type:"user_message",conversation_id,text}`, run the agent, relay Eino events as `{type:"token"|"tool_call"|"tool_result"|"done"}`. No writes yet (write tools registered but disabled/omitted in Phase 2).
- Frontend: real chat panel in `AiAssistant.tsx` — open a WS to `/ai/chat`, stream tokens, render a collapsible tool-step trace, persist/list conversations (`GET/POST /ai/conversations`).
- Tests: guard truth-table (Go), tool read execution with a fake dynamic client, WS message framing; frontend panel render + streamed-token rendering with a mocked WS.

## Phase 3 — Write operations with confirmation

- `create/update/delete_resource` tools: on invocation, `guard.Allow(...)` then **interrupt** carrying an `action_preview` (resource/namespace/name/manifest-or-target); persist `pending_action` + Eino checkpoint on `ok_ai_messages`.
- WS protocol: emit `{type:"confirm_required", action_preview}`; accept `{type:"confirm", approved}`; on approve **resume** → execute the write via the same code path as the resource handlers → audit; on reject resume with a "user rejected" observation.
- `POST /ai/conversations/:id/confirm` REST fallback for reconnect.
- Audit: write an `ok_audit_logs` row per AI-executed write (`action=ai_create|ai_update|ai_delete`, actor = user, note "via OmniKube AI").
- Frontend: confirm card (action preview + Confirm/Reject) inline in the chat.
- Tests: interrupt→confirm→execute happy path; reject path; double-gate denial blocks the write; audit row written.

## Phase 4 — Persistence UI + i18n polish

- Conversation history list/switch/delete UI; titles auto-derived from the first user message.
- Full i18n sweep (7 locales) for all Phase 2–3 strings.
- Polish: error/timeout handling, `max_steps` guard surfaced in UI, empty/loading states, dark-mode check.
- Tests: conversation CRUD; i18n key-parity check.

---

## Self-Review (against the spec)

- **§2 decisions** — Phase 1 realizes: `ai` global area (role-configurable) ✅, model-global + grants-per-cluster data model ✅, ⚠️ not-configured state ✅. Agent/streaming/interrupt/persistence are Phases 2–4 (explicitly scoped) ✅.
- **§4 double gate** — Phase 2 `guard.go` (Allow = AI grant ∩ rbac.Authorize) ✅.
- **§5 flow** — Phases 2–3 (streaming read loop, then interrupt/resume writes) ✅.
- **§6 data model** — `ok_ai_config`/`ok_ai_grants` in Task 1; `ok_ai_conversations`/`ok_ai_messages` in Phase 2 (when chat lands) ✅.
- **§7 API** — config/grants/status in Tasks 5–6; conversations/chat/confirm in Phases 2–3 ✅.
- **§8 RBAC area** — Tasks 2 (backend) + 7 (frontend) ✅.
- **§9 tools / §10 audit** — Phases 2–3 ✅.
- **§11 frontend** — config page (Task 9), launcher + ⚠️ (Task 10); chat panel Phase 2 ✅.
- **Placeholder scan** — Phase 1 tasks contain real code; the two spots that say "match the existing pattern" (test harness in Task 5, sidebar entry in Task 9) point to concrete in-repo exemplars rather than leaving code blank, because copying the established pattern verbatim is the correct, lower-risk action. Phases 2–4 are intentionally scope-only (Eino API must be verified first) and are NOT to be executed until expanded into their own bite-sized plans.
- **Type consistency** — `Store`/`Config`/`ConfigInput` (Task 4) match handler usage (Task 5); `aiApi` shape (Task 8) matches page usage (Task 9); `Operations` reused from `role.ts`.
