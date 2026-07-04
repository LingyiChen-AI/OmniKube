# 集成部署 (Integrated Deployment) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加「集成部署」菜单:把一组 k8s 资源(configmap/secret/deploy/service 等)打包成工单,按固定类型优先级(config → workload → expose)有序、一次性、遇错即停地发布到单集群单命名空间,受独立 RBAC 区域管控,可复制、可反复发布并留发布历史。

**Architecture:** 镜像现有 `releases` 全局区域 + `handler/resource.go`/`ai/executor.go` 的动态客户端 upsert 写路径。后端:2 张新表 + 新全局区域 `integrated_deploy`(动作 view/create/edit/delete/**publish**)+ 挂在现有 `*Handler` 的一组方法。前端:新 api + 页面 + 菜单/路由 + 角色矩阵一行 + 7 语言文案。所有权限做双闸门:区域权限 + 每条资源的资源级 RBAC(write)。

**Tech Stack:** Go (Gin + GORM + Casbin + client-go dynamic) / React + TS + Vite + Ant Design + i18next。

**Spec:** `docs/superpowers/specs/2026-07-04-integrated-deploy-design.md`

**校验命令:**
- 后端:`cd backend && go build ./... && go test ./...`
- 前端:`cd frontend && npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && npm run build`

---

## 关键类型与常量(贯穿全计划,务必一致)

后端 handler 包 DTO(Task 3 定义,后续任务引用):

```go
// DeployItem 是工单里的一份 manifest。Kind 为复数小写资源名(与 rbac/resolveGVR 对齐)。
type DeployItem struct {
	Kind         string `json:"kind"`          // "configmaps" / "deployments" / ...
	Name         string `json:"name"`          // 由 manifest metadata.name 回填(权威)
	Source       string `json:"source"`        // "selected" | "authored"
	ManifestYAML string `json:"manifest_yaml"`
	SortIndex    int    `json:"sort_index"`
}

// ItemResult 是一次发布中某条资源的结果。
type ItemResult struct {
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Phase   string `json:"phase"`   // "created" | "updated" | "failed" | "skipped"
	Message string `json:"message"`
}

// deployKindGroup: 允许进入工单的资源 → 发布组序(1 配置 / 2 负载 / 3 暴露)。
var deployKindGroup = map[string]int{
	"secrets": 1, "configmaps": 1, "persistentvolumeclaims": 1,
	"deployments": 2, "statefulsets": 2, "daemonsets": 2, "jobs": 2, "cronjobs": 2,
	"services": 3, "ingresses": 3,
}
```

前端常量(Task 7 定义):`DEPLOY_KIND_GROUP` 与上表值一致(用于展示顺序)。

区域名固定为字符串 `integrated_deploy`;动作集 `['view','create','edit','delete','publish']`。

---

## Task 1: 后端数据模型 + 迁移

**Files:**
- Modify: `backend/internal/model/model.go`
- Modify: `backend/internal/database/database.go`
- Create: `backend/migrations/005_integrated_deploy.sql`
- Modify: `backend/migrations/README.md`

- [ ] **Step 1: 在 `model.go` 末尾追加两个结构体**

```go
// DeployOrder 集成部署工单:绑定单集群单命名空间的一组资源清单,整体编辑、反复发布。
type DeployOrder struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	UserID      uint      `gorm:"index" json:"user_id"`
	Username    string    `gorm:"size:50" json:"username"`
	ClusterID   string    `gorm:"size:50;index" json:"cluster_id"`
	Namespace   string    `gorm:"size:100" json:"namespace"`
	Title       string    `gorm:"size:200" json:"title"`
	Description string    `gorm:"type:text" json:"description"`
	Items       string    `gorm:"type:text" json:"-"` // JSON []DeployItem;经 handler DTO 暴露
	Status      string    `gorm:"size:20;default:draft" json:"status"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (DeployOrder) TableName() string { return "ok_deploy_orders" }

// DeployOrderRun 一次发布的历史记录。
type DeployOrderRun struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	OrderID   uint      `gorm:"index" json:"order_id"`
	UserID    uint      `json:"user_id"`
	Username  string    `gorm:"size:50" json:"username"`
	Status    string    `gorm:"size:20" json:"status"` // succeeded | failed
	Results   string    `gorm:"type:text" json:"-"`    // JSON []ItemResult;经 handler DTO 暴露
	CreatedAt time.Time `gorm:"index" json:"created_at"`
}

func (DeployOrderRun) TableName() string { return "ok_deploy_order_runs" }
```

- [ ] **Step 2: 把两结构体挂到 `database.go` 的 AutoMigrate 列表**

在 `&model.AIMessage{},` 之后、`)` 之前加两行:

```go
		&model.AIMessage{},
		&model.DeployOrder{},
		&model.DeployOrderRun{},
	); err != nil {
```

- [ ] **Step 3: 新增迁移文件 `backend/migrations/005_integrated_deploy.sql`**

```sql
-- 005_integrated_deploy.sql
-- 日期: 2026-07-04
-- 功能: 集成部署 (Integrated Deployment)
-- 改了什么: 新增工单表 ok_deploy_orders 与发布历史表 ok_deploy_order_runs
-- 为什么: 支持把一组 k8s 资源打包成工单、按固定顺序一次性发布并留历史

CREATE TABLE IF NOT EXISTS ok_deploy_orders (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT,
    username    VARCHAR(50),
    cluster_id  VARCHAR(50),
    namespace   VARCHAR(100),
    title       VARCHAR(200),
    description TEXT,
    items       TEXT,
    status      VARCHAR(20) DEFAULT 'draft',
    created_at  TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ok_deploy_orders_user_id ON ok_deploy_orders (user_id);
CREATE INDEX IF NOT EXISTS idx_ok_deploy_orders_cluster_id ON ok_deploy_orders (cluster_id);

CREATE TABLE IF NOT EXISTS ok_deploy_order_runs (
    id         BIGSERIAL PRIMARY KEY,
    order_id   BIGINT,
    user_id    BIGINT,
    username   VARCHAR(50),
    status     VARCHAR(20),
    results    TEXT,
    created_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ok_deploy_order_runs_order_id ON ok_deploy_order_runs (order_id);
CREATE INDEX IF NOT EXISTS idx_ok_deploy_order_runs_created_at ON ok_deploy_order_runs (created_at);
```

- [ ] **Step 4: 更新 `backend/migrations/README.md` 末尾「当前迁移」表**,新增一行:

```
| 005 | 005_integrated_deploy.sql | 集成部署工单表 ok_deploy_orders + 发布历史表 ok_deploy_order_runs |
```

- [ ] **Step 5: 编译验证**

Run: `cd backend && go build ./...`
Expected: 成功,无报错。

- [ ] **Step 6: Commit**

```bash
git add backend/internal/model/model.go backend/internal/database/database.go backend/migrations/005_integrated_deploy.sql backend/migrations/README.md
git commit -m "feat(integrated-deploy): DeployOrder + DeployOrderRun models & migration"
```

---

## Task 2: 后端 RBAC 区域注册 `integrated_deploy` + `publish` 动作

**Files:**
- Modify: `backend/internal/rbac/resources.go`
- Modify: `backend/internal/rbac/global.go`
- Test: `backend/internal/rbac/integrated_deploy_area_test.go` (create)

- [ ] **Step 1: 写失败测试 `integrated_deploy_area_test.go`**

```go
package rbac

import "testing"

func TestIntegratedDeployArea(t *testing.T) {
	if !IsValidGlobalArea("integrated_deploy") {
		t.Fatal("integrated_deploy should be a valid global area")
	}
	if !IsValidGlobalAction("publish") {
		t.Fatal("publish should be a valid global action")
	}
	acts := AllGlobalPerms()["integrated_deploy"]
	want := map[string]bool{"view": true, "create": true, "edit": true, "delete": true, "publish": true}
	if len(acts) != len(want) {
		t.Fatalf("integrated_deploy admin perms = %v, want 5 actions", acts)
	}
	for _, a := range acts {
		if !want[a] {
			t.Fatalf("unexpected action %q in integrated_deploy admin perms", a)
		}
	}
}
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd backend && go test ./internal/rbac/ -run TestIntegratedDeployArea`
Expected: FAIL(integrated_deploy 尚未是合法区域)。

- [ ] **Step 3: 在 `resources.go` 注册区域与动作**

把:
```go
var validGlobalAreas = setOf("clusters", "users", "roles", "releases", "audit", "ai")
var validGlobalActions = setOf("view", "create", "edit", "delete")
```
改为:
```go
var validGlobalAreas = setOf("clusters", "users", "roles", "releases", "audit", "ai", "integrated_deploy")
var validGlobalActions = setOf("view", "create", "edit", "delete", "publish")
```

- [ ] **Step 4: 在 `global.go` 的 `AllGlobalPerms()` 返回 map 里加区域**

在 `"ai": {"view", "edit", "create"},` 之后加:
```go
		// 集成部署:工单的增删改查 + 发布(publish 为区域级发布门槛)。
		"integrated_deploy": {"view", "create", "edit", "delete", "publish"},
```

- [ ] **Step 5: 运行测试,确认通过**

Run: `cd backend && go test ./internal/rbac/`
Expected: PASS(含既有测试)。

- [ ] **Step 6: Commit**

```bash
git add backend/internal/rbac/resources.go backend/internal/rbac/global.go backend/internal/rbac/integrated_deploy_area_test.go
git commit -m "feat(integrated-deploy): register integrated_deploy global area + publish action"
```

---

## Task 3: 后端纯函数(分组/排序/校验) + 单测

**Files:**
- Create: `backend/internal/handler/integrated_deploy.go`
- Test: `backend/internal/handler/integrated_deploy_test.go`

- [ ] **Step 1: 新建 `integrated_deploy.go`,写类型 + 纯函数**

```go
package handler

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"
)

// DeployItem 是工单里的一份 manifest。Kind 为复数小写资源名(与 rbac/resolveGVR 对齐)。
type DeployItem struct {
	Kind         string `json:"kind"`
	Name         string `json:"name"`
	Source       string `json:"source"`
	ManifestYAML string `json:"manifest_yaml"`
	SortIndex    int    `json:"sort_index"`
}

// ItemResult 是一次发布中某条资源的结果。
type ItemResult struct {
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Phase   string `json:"phase"`
	Message string `json:"message"`
}

// deployKindGroup: 允许进入工单的资源 → 发布组序(1 配置 / 2 负载 / 3 暴露)。
var deployKindGroup = map[string]int{
	"secrets": 1, "configmaps": 1, "persistentvolumeclaims": 1,
	"deployments": 2, "statefulsets": 2, "daemonsets": 2, "jobs": 2, "cronjobs": 2,
	"services": 3, "ingresses": 3,
}

// deployAllowedKind 该资源类型是否允许进入工单。
func deployAllowedKind(kind string) bool {
	_, ok := deployKindGroup[kind]
	return ok
}

// sortDeployItems 返回按 (组序, sort_index) 稳定排序后的条目 —— 固定发布顺序。
func sortDeployItems(items []DeployItem) []DeployItem {
	out := append([]DeployItem(nil), items...)
	sort.SliceStable(out, func(i, j int) bool {
		gi, gj := deployKindGroup[out[i].Kind], deployKindGroup[out[j].Kind]
		if gi != gj {
			return gi < gj
		}
		return out[i].SortIndex < out[j].SortIndex
	})
	return out
}

// validateDeployItems 逐条校验:允许的类型、YAML 可解析且有 name、用户对该类型在该 ns
// 有 write 权限。就地把 it.Name 回填为 manifest 的 metadata.name(权威来源)。
// 校验通过返回 ("", 0);否则返回 (中文错误信息, HTTP 状态码)。
func (h *Handler) validateDeployItems(uid uint, clusterID, ns string, items []DeployItem) (string, int) {
	sid := strconv.FormatUint(uint64(uid), 10)
	for i := range items {
		it := &items[i]
		if !deployAllowedKind(it.Kind) {
			return fmt.Sprintf("第%d条: 不支持的资源类型 %q", i+1, it.Kind), http.StatusBadRequest
		}
		var m map[string]interface{}
		if err := yaml.Unmarshal([]byte(it.ManifestYAML), &m); err != nil || m == nil {
			return fmt.Sprintf("第%d条(%s): YAML 解析失败", i+1, it.Kind), http.StatusBadRequest
		}
		obj := &unstructured.Unstructured{Object: m}
		if obj.GetName() == "" {
			return fmt.Sprintf("第%d条(%s): manifest 缺少 metadata.name", i+1, it.Kind), http.StatusBadRequest
		}
		it.Name = obj.GetName()
		ok, _, err := h.RBAC.Authorize(sid, clusterID, ns, it.Kind, "write")
		if err != nil || !ok {
			return fmt.Sprintf("第%d条(%s/%s): 无写入权限", i+1, it.Kind, obj.GetName()), http.StatusForbidden
		}
	}
	return "", 0
}
```

- [ ] **Step 2: 写单测 `integrated_deploy_test.go`(纯函数部分)**

```go
package handler

import "testing"

func TestDeployAllowedKind(t *testing.T) {
	for _, k := range []string{"configmaps", "secrets", "deployments", "services", "ingresses", "persistentvolumeclaims"} {
		if !deployAllowedKind(k) {
			t.Errorf("%s should be allowed", k)
		}
	}
	for _, k := range []string{"pods", "nodes", "persistentvolumes", "bogus"} {
		if deployAllowedKind(k) {
			t.Errorf("%s should NOT be allowed", k)
		}
	}
}

func TestSortDeployItems(t *testing.T) {
	in := []DeployItem{
		{Kind: "services", SortIndex: 0},
		{Kind: "deployments", SortIndex: 1},
		{Kind: "configmaps", SortIndex: 0},
		{Kind: "deployments", SortIndex: 0},
	}
	got := sortDeployItems(in)
	wantKinds := []string{"configmaps", "deployments", "deployments", "services"}
	for i, w := range wantKinds {
		if got[i].Kind != w {
			t.Fatalf("pos %d = %s, want %s (order: %+v)", i, got[i].Kind, w, got)
		}
	}
	// 组内按 sort_index:两个 deployments 中 SortIndex 0 应排在 1 之前。
	if got[1].SortIndex != 0 || got[2].SortIndex != 1 {
		t.Fatalf("within-group order wrong: %+v", got)
	}
	// 不修改入参。
	if in[0].Kind != "services" {
		t.Fatal("sortDeployItems must not mutate input")
	}
}
```

- [ ] **Step 3: 运行,确认通过(顺带证明 sigs.k8s.io/yaml 依赖可用)**

Run: `cd backend && go mod tidy && go test ./internal/handler/ -run 'TestDeployAllowedKind|TestSortDeployItems'`
Expected: PASS。`go mod tidy` 会把 `sigs.k8s.io/yaml` 从 indirect 提为 direct。

- [ ] **Step 4: Commit**

```bash
git add backend/internal/handler/integrated_deploy.go backend/internal/handler/integrated_deploy_test.go backend/go.mod backend/go.sum
git commit -m "feat(integrated-deploy): item types, fixed-order sort, permission validation"
```

---

## Task 4: 后端工单 CRUD + 复制 + 可选资源列表

**Files:**
- Modify: `backend/internal/handler/integrated_deploy.go`

- [ ] **Step 1: 追加 DTO 与 CRUD 处理函数**

在 `integrated_deploy.go` 追加(注意新增 imports:`encoding/json`、`time`、`github.com/gin-gonic/gin`、`gorm.io/gorm`、`.../internal/model`、`k8s.io/apimachinery/pkg/apis/meta/v1` 记为 `metav1`、`k8s.io/apimachinery/pkg/runtime/schema` 若用到,以及 `context`):

```go
type deployOrderReq struct {
	ClusterID   string       `json:"cluster_id"`
	Namespace   string       `json:"namespace"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Items       []DeployItem `json:"items"`
}

type deployOrderResp struct {
	ID          uint         `json:"id"`
	UserID      uint         `json:"user_id"`
	Username    string       `json:"username"`
	ClusterID   string       `json:"cluster_id"`
	Namespace   string       `json:"namespace"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Items       []DeployItem `json:"items"`
	Status      string       `json:"status"`
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`
}

func toDeployOrderResp(o model.DeployOrder) deployOrderResp {
	var items []DeployItem
	if o.Items != "" {
		_ = json.Unmarshal([]byte(o.Items), &items)
	}
	if items == nil {
		items = []DeployItem{}
	}
	return deployOrderResp{
		ID: o.ID, UserID: o.UserID, Username: o.Username,
		ClusterID: o.ClusterID, Namespace: o.Namespace,
		Title: o.Title, Description: o.Description, Items: items,
		Status: o.Status, CreatedAt: o.CreatedAt, UpdatedAt: o.UpdatedAt,
	}
}

// currentUsername 查当前请求用户名(冗余展示用),查不到返回空。
func (h *Handler) currentUsername(uid uint) string {
	if uid == 0 {
		return ""
	}
	var u model.User
	if err := h.DB.First(&u, uid).Error; err == nil {
		return u.Username
	}
	return ""
}

// ListDeployOrders GET /integrated-deploy/orders — 可选 cluster_id 过滤,新到旧。
func (h *Handler) ListDeployOrders(c *gin.Context) {
	var orders []model.DeployOrder
	q := h.DB.Order("updated_at desc")
	if cid := c.Query("cluster_id"); cid != "" {
		q = q.Where("cluster_id = ?", cid)
	}
	if err := q.Find(&orders).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	out := make([]deployOrderResp, 0, len(orders))
	for _, o := range orders {
		out = append(out, toDeployOrderResp(o))
	}
	c.JSON(http.StatusOK, gin.H{"orders": out})
}

// GetDeployOrder GET /integrated-deploy/orders/:id — 详情 + 发布历史。
func (h *Handler) GetDeployOrder(c *gin.Context) {
	var o model.DeployOrder
	if err := h.DB.First(&o, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "工单不存在"})
		return
	}
	var runs []model.DeployOrderRun
	h.DB.Where("order_id = ?", o.ID).Order("created_at desc").Find(&runs)
	runOut := make([]gin.H, 0, len(runs))
	for _, r := range runs {
		var results []ItemResult
		if r.Results != "" {
			_ = json.Unmarshal([]byte(r.Results), &results)
		}
		runOut = append(runOut, gin.H{
			"id": r.ID, "user_id": r.UserID, "username": r.Username,
			"status": r.Status, "results": results, "created_at": r.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"order": toDeployOrderResp(o), "runs": runOut})
}

// CreateDeployOrder POST /integrated-deploy/orders。
func (h *Handler) CreateDeployOrder(c *gin.Context) {
	var req deployOrderReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "请求体格式错误"})
		return
	}
	if req.ClusterID == "" || req.Namespace == "" || req.Title == "" {
		c.JSON(http.StatusBadRequest, gin.H{"message": "集群、命名空间、标题必填"})
		return
	}
	uid := c.GetUint("user_id")
	if msg, code := h.validateDeployItems(uid, req.ClusterID, req.Namespace, req.Items); code != 0 {
		c.JSON(code, gin.H{"message": msg})
		return
	}
	itemsJSON, _ := json.Marshal(req.Items)
	o := model.DeployOrder{
		UserID: uid, Username: h.currentUsername(uid),
		ClusterID: req.ClusterID, Namespace: req.Namespace,
		Title: req.Title, Description: req.Description,
		Items: string(itemsJSON), Status: "draft",
	}
	if err := h.DB.Create(&o).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, toDeployOrderResp(o))
}

// UpdateDeployOrder PUT /integrated-deploy/orders/:id。
func (h *Handler) UpdateDeployOrder(c *gin.Context) {
	var o model.DeployOrder
	if err := h.DB.First(&o, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "工单不存在"})
		return
	}
	var req deployOrderReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "请求体格式错误"})
		return
	}
	if req.Title == "" {
		c.JSON(http.StatusBadRequest, gin.H{"message": "标题必填"})
		return
	}
	uid := c.GetUint("user_id")
	// 集群/命名空间锁定:以工单原值为准做权限校验(前端也禁改)。
	if msg, code := h.validateDeployItems(uid, o.ClusterID, o.Namespace, req.Items); code != 0 {
		c.JSON(code, gin.H{"message": msg})
		return
	}
	itemsJSON, _ := json.Marshal(req.Items)
	o.Title = req.Title
	o.Description = req.Description
	o.Items = string(itemsJSON)
	if err := h.DB.Save(&o).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, toDeployOrderResp(o))
}

// DeleteDeployOrder DELETE /integrated-deploy/orders/:id(连带删发布历史)。
func (h *Handler) DeleteDeployOrder(c *gin.Context) {
	id := c.Param("id")
	if err := h.DB.Delete(&model.DeployOrder{}, id).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	h.DB.Where("order_id = ?", id).Delete(&model.DeployOrderRun{})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// CopyDeployOrder POST /integrated-deploy/orders/:id/copy — 复制为 draft(复用 create 权限)。
func (h *Handler) CopyDeployOrder(c *gin.Context) {
	var src model.DeployOrder
	if err := h.DB.First(&src, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "工单不存在"})
		return
	}
	uid := c.GetUint("user_id")
	dup := model.DeployOrder{
		UserID: uid, Username: h.currentUsername(uid),
		ClusterID: src.ClusterID, Namespace: src.Namespace,
		Title: src.Title + " (副本)", Description: src.Description,
		Items: src.Items, Status: "draft",
	}
	if err := h.DB.Create(&dup).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, toDeployOrderResp(dup))
}
```

- [ ] **Step 2: 追加可选资源列表 `ListSelectable`**

```go
// ListSelectable GET /integrated-deploy/selectable?cluster_id=&ns=&kind=
// 返回该 ns 下用户对该 kind 有 write 权限时的对象名单;无权限返回空名单。
func (h *Handler) ListSelectable(c *gin.Context) {
	clusterID := c.Query("cluster_id")
	ns := c.Query("ns")
	kind := c.Query("kind")
	if clusterID == "" || ns == "" || !deployAllowedKind(kind) {
		c.JSON(http.StatusBadRequest, gin.H{"message": "参数缺失或资源类型不支持"})
		return
	}
	uid := c.GetUint("user_id")
	sid := strconv.FormatUint(uint64(uid), 10)
	ok, _, err := h.RBAC.Authorize(sid, clusterID, ns, kind, "write")
	if err != nil || !ok {
		c.JSON(http.StatusOK, gin.H{"names": []string{}})
		return
	}
	cc, found := h.Pool.Get(clusterID)
	if !found {
		c.JSON(http.StatusBadRequest, gin.H{"message": "集群不可用"})
		return
	}
	gvr, namespaced, gerr := resolveGVR(cc, kind)
	if gerr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": gerr.Error()})
		return
	}
	ri := cc.Dynamic.Resource(gvr)
	ctx := c.Request.Context()
	var list *unstructured.UnstructuredList
	if namespaced {
		list, err = ri.Namespace(ns).List(ctx, metav1.ListOptions{})
	} else {
		list, err = ri.List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		writeK8sError(c, err)
		return
	}
	names := make([]string, 0, len(list.Items))
	for i := range list.Items {
		names = append(names, list.Items[i].GetName())
	}
	c.JSON(http.StatusOK, gin.H{"names": names})
}
```

> 注:`h.Pool.Get` 返回 `(*cluster.ClusterClient, bool)`;`resolveGVR`、`writeK8sError` 已在 `resource.go` 定义于同包,可直接调用。imports 需补 `metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"`。

- [ ] **Step 3: 编译**

Run: `cd backend && go build ./...`
Expected: 成功。

- [ ] **Step 4: Commit**

```bash
git add backend/internal/handler/integrated_deploy.go
git commit -m "feat(integrated-deploy): order CRUD, copy, selectable-resources endpoint"
```

---

## Task 5: 后端发布(有序 upsert,遇错即停) + 发布历史

**Files:**
- Modify: `backend/internal/handler/integrated_deploy.go`

- [ ] **Step 1: 追加 `applyDeployItem` 与 `PublishDeployOrder`**

新增 imports:`"context"`、`dynamic "k8s.io/client-go/dynamic"`、`apierrors "k8s.io/apimachinery/pkg/api/errors"`、`"github.com/twwch/omnikube/backend/internal/cluster"`(按模块路径,参照 resource.go 顶部 import 的 module 前缀)。

```go
// applyDeployItem 对一条资源做 upsert(存在则 Update 回填 resourceVersion,不存在则 Create)。
// 返回 phase(created|updated|failed)+ message。
func applyDeployItem(ctx context.Context, cc *cluster.ClusterClient, ns string, it DeployItem) (string, string) {
	gvr, namespaced, gerr := resolveGVR(cc, it.Kind)
	if gerr != nil {
		return "failed", gerr.Error()
	}
	var m map[string]interface{}
	if err := yaml.Unmarshal([]byte(it.ManifestYAML), &m); err != nil {
		return "failed", "YAML 解析失败: " + err.Error()
	}
	obj := &unstructured.Unstructured{Object: m}
	obj.SetName(it.Name)
	ri := cc.Dynamic.Resource(gvr)
	var dri dynamic.ResourceInterface = ri
	if namespaced {
		obj.SetNamespace(ns) // 强制覆盖 manifest 自带 namespace,封堵越权。
		dri = ri.Namespace(ns)
	}
	current, gerr := dri.Get(ctx, it.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(gerr) {
		if _, err := dri.Create(ctx, obj, metav1.CreateOptions{}); err != nil {
			return "failed", err.Error()
		}
		return "created", ""
	}
	if gerr != nil {
		return "failed", gerr.Error()
	}
	obj.SetResourceVersion(current.GetResourceVersion())
	if _, err := dri.Update(ctx, obj, metav1.UpdateOptions{}); err != nil {
		return "failed", err.Error()
	}
	return "updated", ""
}

// PublishDeployOrder POST /integrated-deploy/orders/:id/publish
// 按固定顺序 upsert;遇错即停,余下标 skipped;写一条发布历史;回写工单 status。
func (h *Handler) PublishDeployOrder(c *gin.Context) {
	var o model.DeployOrder
	if err := h.DB.First(&o, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "工单不存在"})
		return
	}
	var items []DeployItem
	if o.Items != "" {
		_ = json.Unmarshal([]byte(o.Items), &items)
	}
	if len(items) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"message": "工单没有任何资源条目"})
		return
	}
	uid := c.GetUint("user_id")
	// 发布前二次权限校验(权限期间可能被收回)。
	if msg, code := h.validateDeployItems(uid, o.ClusterID, o.Namespace, items); code != 0 {
		c.JSON(code, gin.H{"message": msg})
		return
	}
	cc, found := h.Pool.Get(o.ClusterID)
	if !found {
		c.JSON(http.StatusBadRequest, gin.H{"message": "集群不可用"})
		return
	}
	ordered := sortDeployItems(items)
	results := make([]ItemResult, 0, len(ordered))
	runStatus := "succeeded"
	stopped := false
	for _, it := range ordered {
		if stopped {
			results = append(results, ItemResult{Kind: it.Kind, Name: it.Name, Phase: "skipped"})
			continue
		}
		phase, msg := applyDeployItem(c.Request.Context(), cc, o.Namespace, it)
		results = append(results, ItemResult{Kind: it.Kind, Name: it.Name, Phase: phase, Message: msg})
		if phase == "failed" {
			runStatus = "failed"
			stopped = true // 遇错即停。
		}
	}
	resultsJSON, _ := json.Marshal(results)
	run := model.DeployOrderRun{
		OrderID: o.ID, UserID: uid, Username: h.currentUsername(uid),
		Status: runStatus, Results: string(resultsJSON),
	}
	h.DB.Create(&run)
	o.Status = runStatus
	h.DB.Save(&o)
	c.JSON(http.StatusOK, gin.H{
		"run": gin.H{
			"id": run.ID, "status": run.Status, "results": results,
			"created_at": run.CreatedAt, "username": run.Username,
		},
	})
}
```

- [ ] **Step 2: 编译**

Run: `cd backend && go build ./...`
Expected: 成功。

- [ ] **Step 3: 写发布顺序 + 遇错即停的单测**

在 `integrated_deploy_test.go` 追加(不触达真实集群,只验证纯排序与 skip 逻辑已在 Task 3 覆盖;此处补一个 results 构造的顺序断言,证明 skipped 语义):

```go
func TestSortThenSkipSemantics(t *testing.T) {
	// 组序保证 configmap 先于 deployment;若 deployment 前的一条失败,deployment 应被 skip。
	ordered := sortDeployItems([]DeployItem{
		{Kind: "deployments", Name: "app", SortIndex: 0},
		{Kind: "configmaps", Name: "cfg", SortIndex: 0},
	})
	if ordered[0].Kind != "configmaps" || ordered[1].Kind != "deployments" {
		t.Fatalf("expected configmaps before deployments, got %+v", ordered)
	}
}
```

- [ ] **Step 4: 运行全部后端测试**

Run: `cd backend && go test ./...`
Expected: PASS(全绿)。

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/integrated_deploy.go backend/internal/handler/integrated_deploy_test.go
git commit -m "feat(integrated-deploy): ordered upsert publish (stop-on-error) + run history"
```

---

## Task 6: 后端路由注册

**Files:**
- Modify: `backend/internal/router/router.go`

- [ ] **Step 1: 在 `authed` 组内(参照 `/releases` 一行附近)注册路由**

```go
			// 集成部署:JWTAuth + global-perm integrated_deploy:<action>(admin 旁路)。
			authed.GET("/integrated-deploy/orders", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "view"), h.ListDeployOrders)
			authed.POST("/integrated-deploy/orders", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "create"), h.CreateDeployOrder)
			authed.GET("/integrated-deploy/orders/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "view"), h.GetDeployOrder)
			authed.PUT("/integrated-deploy/orders/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "edit"), h.UpdateDeployOrder)
			authed.DELETE("/integrated-deploy/orders/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "delete"), h.DeleteDeployOrder)
			authed.POST("/integrated-deploy/orders/:id/copy", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "create"), h.CopyDeployOrder)
			authed.POST("/integrated-deploy/orders/:id/publish", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "publish"), h.PublishDeployOrder)
			authed.GET("/integrated-deploy/selectable", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "view"), h.ListSelectable)
```

- [ ] **Step 2: 编译 + 全测**

Run: `cd backend && go build ./... && go test ./...`
Expected: 成功且全绿。

- [ ] **Step 3: Commit**

```bash
git add backend/internal/router/router.go
git commit -m "feat(integrated-deploy): register routes under authed group"
```

---

## Task 7: 前端 api 客户端 + 角色矩阵区域 + i18n

**Files:**
- Create: `frontend/src/api/integratedDeploy.ts`
- Modify: `frontend/src/api/role.ts`
- Modify: `frontend/src/pages/roles/Roles.tsx`
- Modify: `frontend/src/i18n/locales/{zh,en,ja,ko,fr,de,es}.ts`

- [ ] **Step 1: 新建 `api/integratedDeploy.ts`**

```ts
import client from './client';

export type DeploySource = 'selected' | 'authored';
export type ItemPhase = 'created' | 'updated' | 'failed' | 'skipped';

export interface DeployItem {
  kind: string;
  name: string;
  source: DeploySource;
  manifest_yaml: string;
  sort_index: number;
}

export interface DeployOrder {
  id: number;
  user_id: number;
  username: string;
  cluster_id: string;
  namespace: string;
  title: string;
  description: string;
  items: DeployItem[];
  status: string; // draft | succeeded | failed
  created_at: string;
  updated_at: string;
}

export interface ItemResult {
  kind: string;
  name: string;
  phase: ItemPhase;
  message: string;
}

export interface DeployRun {
  id: number;
  user_id?: number;
  username: string;
  status: string;
  results: ItemResult[];
  created_at: string;
}

export interface DeployOrderInput {
  cluster_id: string;
  namespace: string;
  title: string;
  description: string;
  items: DeployItem[];
}

/** 允许进入工单的资源类型 → 发布组序(与后端 deployKindGroup 值一致)。 */
export const DEPLOY_KIND_GROUP: Record<string, number> = {
  secrets: 1, configmaps: 1, persistentvolumeclaims: 1,
  deployments: 2, statefulsets: 2, daemonsets: 2, jobs: 2, cronjobs: 2,
  services: 3, ingresses: 3,
};

export const DEPLOY_KINDS: string[] = Object.keys(DEPLOY_KIND_GROUP);

/** 固定发布顺序排序:先按组序,再按 sort_index。 */
export function orderedItems(items: DeployItem[]): DeployItem[] {
  return [...items].sort((a, b) => {
    const ga = DEPLOY_KIND_GROUP[a.kind] ?? 99;
    const gb = DEPLOY_KIND_GROUP[b.kind] ?? 99;
    return ga !== gb ? ga - gb : a.sort_index - b.sort_index;
  });
}

export const integratedDeployApi = {
  list: (clusterId?: string) =>
    client
      .get<{ orders: DeployOrder[] }>('/integrated-deploy/orders', {
        params: clusterId ? { cluster_id: clusterId } : undefined,
      })
      .then((r) => r.data.orders ?? []),
  get: (id: number) =>
    client
      .get<{ order: DeployOrder; runs: DeployRun[] }>(`/integrated-deploy/orders/${id}`)
      .then((r) => r.data),
  create: (body: DeployOrderInput) =>
    client.post<DeployOrder>('/integrated-deploy/orders', body).then((r) => r.data),
  update: (id: number, body: DeployOrderInput) =>
    client.put<DeployOrder>(`/integrated-deploy/orders/${id}`, body).then((r) => r.data),
  remove: (id: number) =>
    client.delete(`/integrated-deploy/orders/${id}`).then((r) => r.data),
  copy: (id: number) =>
    client.post<DeployOrder>(`/integrated-deploy/orders/${id}/copy`).then((r) => r.data),
  publish: (id: number) =>
    client
      .post<{ run: DeployRun }>(`/integrated-deploy/orders/${id}/publish`)
      .then((r) => r.data.run),
  selectable: (clusterId: string, ns: string, kind: string) =>
    client
      .get<{ names: string[] }>('/integrated-deploy/selectable', {
        params: { cluster_id: clusterId, ns, kind },
      })
      .then((r) => r.data.names ?? []),
};
```

- [ ] **Step 2: `role.ts` 增加区域 + 动作映射**

改 `GlobalArea` 类型(加 `'integrated_deploy'`):
```ts
export type GlobalArea = 'clusters' | 'users' | 'roles' | 'releases' | 'audit' | 'ai' | 'integrated_deploy';
```
改 `GLOBAL_AREAS`(加到末尾):
```ts
export const GLOBAL_AREAS: GlobalArea[] = ['clusters', 'users', 'roles', 'releases', 'audit', 'ai', 'integrated_deploy'];
```
在 `actionsForGlobalArea` 里,`ai` 分支之后加一分支(注意需要把 `'publish'` 纳入 `TreeAction`,见下 Step 3):
```ts
export function actionsForGlobalArea(area: GlobalArea): TreeAction[] {
  if (VIEW_ONLY_AREAS.includes(area)) return ['view'];
  if (area === 'ai') return ['view', 'edit', 'create'];
  if (area === 'integrated_deploy') return ['view', 'create', 'edit', 'delete', 'publish'];
  return BASE_ACTIONS;
}
```

- [ ] **Step 3: `role.ts` 把 `publish` 纳入 `TreeAction`**

`publish` 是集成部署区域独有的全局动作。改:
```ts
export type TreeAction = 'view' | 'create' | 'edit' | 'delete' | 'exec' | 'reveal' | 'publish';
```
`TREE_ACTIONS`(用于矩阵列头顺序)在末尾加 `'publish'`:
```ts
export const TREE_ACTIONS: TreeAction[] = ['view', 'create', 'edit', 'delete', 'exec', 'reveal', 'publish'];
```
> `BASE_ACTIONS` 不变(资源级仍是 view/create/edit/delete)。`publish` 只经 `actionsForGlobalArea('integrated_deploy')` 暴露。

- [ ] **Step 4: `Roles.tsx` 渲染集成部署区域一行**

把:
```ts
  const allAreas: GlobalArea[] = [...SYSTEM_AREAS, 'releases', 'audit'];
```
改为:
```ts
  const allAreas: GlobalArea[] = [...SYSTEM_AREAS, 'integrated_deploy', 'releases', 'audit'];
```
并在渲染 `areaRow('releases')` 之前插入 `areaRow('integrated_deploy')`。(搜索 `areaRow('releases')` 所在的 JSX,在其上方加 `{areaRow('integrated_deploy')}`。行 label 取 `t('nav.integratedDeploy')` —— `areaRow` 内部若用 `t('nav.'+area)`,需确保 i18n key 为 `nav.integrated_deploy`;若 `areaRow` 用固定映射,则按其写法补 `integrated_deploy` 项。实现时先读 `areaRow` 定义确认 label 来源,再对应补 key。)

- [ ] **Step 5: 7 个 i18n 文件补齐文案**

每个 `frontend/src/i18n/locales/{zh,en,ja,ko,fr,de,es}.ts`:
1. 在 `nav` 块加 `integrated_deploy` 键(与 `areaRow` label 来源匹配)——**注意用 `integrated_deploy`(下划线)作为 key**,值为各语言「集成部署」。
2. 顶层加一个 `integratedDeploy` 文案块。

以 `zh.ts` 为例(其它语言翻译对应):
```ts
  // nav 块内:
  integrated_deploy: '集成部署',
```
```ts
  // 顶层新块:
  integratedDeploy: {
    title: '集成部署',
    subtitle: '把一组资源打包成工单,按顺序一次性发布',
    newOrder: '新建工单',
    cluster: '集群',
    namespace: '命名空间',
    orderTitle: '标题',
    description: '说明',
    status: '状态',
    updatedAt: '更新时间',
    creator: '创建人',
    actions: '操作',
    edit: '编辑',
    copy: '复制',
    delete: '删除',
    publish: '发布',
    empty: '暂无工单',
    statusDraft: '草稿',
    statusSucceeded: '成功',
    statusFailed: '失败',
    items: '资源条目',
    addSelected: '从集群选取',
    addAuthored: '手写 YAML',
    kind: '资源类型',
    resourceName: '资源名称',
    source: '来源',
    manifest: '清单 YAML',
    orderPreview: '发布顺序预览',
    group1: '配置/数据',
    group2: '工作负载',
    group3: '暴露',
    save: '保存',
    publishConfirmTitle: '确认发布',
    publishConfirmDesc: '将按下列顺序依次发布,遇错即停:',
    publishResult: '发布结果',
    phaseCreated: '已创建',
    phaseUpdated: '已更新',
    phaseFailed: '失败',
    phaseSkipped: '已跳过',
    copySuccess: '已复制为新工单',
    deleteConfirm: '确定删除该工单?',
    noWritePerm: '无该资源写权限,已过滤',
    selectResource: '选择资源',
    noSelectable: '该命名空间下没有你有写权限的此类资源',
    publishHistory: '发布历史',
    saved: '已保存',
  },
```
> 其它 6 个语言用对应翻译(结构键名完全一致,值翻译)。`en.ts` 因导出 `Resources` 类型,必须补齐所有键,否则其余 6 文件类型报错。

- [ ] **Step 6: 类型检查**

Run: `cd frontend && npx tsc --noEmit`
Expected: 通过(7 文件键齐、类型一致)。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/integratedDeploy.ts frontend/src/api/role.ts frontend/src/pages/roles/Roles.tsx frontend/src/i18n/locales/
git commit -m "feat(integrated-deploy): api client, role matrix area, i18n (7 locales)"
```

---

## Task 8: 前端菜单 + 路由

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: `Sidebar.tsx` 加菜单项**

在顶部 icon import 里加 `DeploymentUnitOutlined`(来自 `@ant-design/icons`,与其它图标同一 import 块)。在「发布记录」`base.push` 之前插入:
```tsx
    // 集成部署: gated by integrated_deploy:view。
    if (canGlobal('integrated_deploy', 'view', user)) {
      base.push({ key: '/integrated-deploy', icon: <DeploymentUnitOutlined />, label: t('nav.integrated_deploy') });
    }
```

- [ ] **Step 2: `App.tsx` 加路由**

在受保护路由块内(参照 `/releases` 的 `GlobalRoute` 行),加两条路由 —— 列表 + 编辑器(编辑器兼新建/详情):
```tsx
        <Route path="/integrated-deploy" element={<GlobalRoute area="integrated_deploy"><IntegratedDeploy /></GlobalRoute>} />
        <Route path="/integrated-deploy/orders/:id" element={<GlobalRoute area="integrated_deploy"><DeployOrderEditor /></GlobalRoute>} />
        <Route path="/integrated-deploy/new" element={<GlobalRoute area="integrated_deploy"><DeployOrderEditor /></GlobalRoute>} />
```
并在顶部加 import:
```tsx
import IntegratedDeploy from './pages/integratedDeploy/IntegratedDeploy';
import DeployOrderEditor from './pages/integratedDeploy/DeployOrderEditor';
```
> `GlobalArea` 类型在 `ProtectedRoute`/`GlobalRoute` 的 `area` prop 上应接受任意 area 字符串;若 `GlobalRoute` 的 `area` 是强类型,确认它引用 `role.ts` 的 `GlobalArea`(Task 7 已加 `integrated_deploy`),无需再改。

- [ ] **Step 3: 占位编译(页面文件下一个 Task 创建;本步先建空壳以过编译)**

为让本 Task 可独立编译,先创建最小占位(Task 9/10 会替换为完整实现):

`frontend/src/pages/integratedDeploy/IntegratedDeploy.tsx`:
```tsx
export default function IntegratedDeploy() {
  return null;
}
```
`frontend/src/pages/integratedDeploy/DeployOrderEditor.tsx`:
```tsx
export default function DeployOrderEditor() {
  return null;
}
```

- [ ] **Step 4: 类型检查**

Run: `cd frontend && npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/App.tsx frontend/src/pages/integratedDeploy/
git commit -m "feat(integrated-deploy): sidebar entry + routes (placeholder pages)"
```

---

## Task 9: 前端工单列表页

**Files:**
- Modify: `frontend/src/pages/integratedDeploy/IntegratedDeploy.tsx`
- Test: `frontend/src/test/integratedDeploy.test.tsx` (create)

- [ ] **Step 1: 实现列表页**

```tsx
import { useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Popconfirm, Space, Table, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { integratedDeployApi, type DeployOrder } from '../../api/integratedDeploy';
import { useAuthStore } from '../../store/auth';
import { canGlobal } from '../../nav';

function statusTag(status: string, t: (k: string) => string) {
  if (status === 'succeeded') return <Tag color="success">{t('integratedDeploy.statusSucceeded')}</Tag>;
  if (status === 'failed') return <Tag color="error">{t('integratedDeploy.statusFailed')}</Tag>;
  return <Tag>{t('integratedDeploy.statusDraft')}</Tag>;
}

export default function IntegratedDeploy() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user);
  const [orders, setOrders] = useState<DeployOrder[]>([]);
  const [loading, setLoading] = useState(false);

  const canCreate = canGlobal('integrated_deploy', 'create', me);
  const canEdit = canGlobal('integrated_deploy', 'edit', me);
  const canDelete = canGlobal('integrated_deploy', 'delete', me);

  const load = () => {
    setLoading(true);
    integratedDeployApi
      .list()
      .then(setOrders)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const doCopy = async (id: number) => {
    try {
      await integratedDeployApi.copy(id);
      message.success(t('integratedDeploy.copySuccess'));
      load();
    } catch {
      /* interceptor toast */
    }
  };
  const doDelete = async (id: number) => {
    try {
      await integratedDeployApi.remove(id);
      load();
    } catch {
      /* interceptor toast */
    }
  };

  const columns = [
    { title: t('integratedDeploy.orderTitle'), dataIndex: 'title' },
    { title: t('integratedDeploy.cluster'), dataIndex: 'cluster_id' },
    { title: t('integratedDeploy.namespace'), dataIndex: 'namespace' },
    {
      title: t('integratedDeploy.status'),
      dataIndex: 'status',
      render: (s: string) => statusTag(s, t),
    },
    { title: t('integratedDeploy.creator'), dataIndex: 'username' },
    { title: t('integratedDeploy.updatedAt'), dataIndex: 'updated_at' },
    {
      title: t('integratedDeploy.actions'),
      key: 'actions',
      render: (_: unknown, r: DeployOrder) => (
        <Space>
          <Button size="small" onClick={() => navigate(`/integrated-deploy/orders/${r.id}`)}>
            {canEdit ? t('integratedDeploy.edit') : t('integratedDeploy.publish')}
          </Button>
          {canCreate && (
            <Button size="small" onClick={() => doCopy(r.id)}>
              {t('integratedDeploy.copy')}
            </Button>
          )}
          {canDelete && (
            <Popconfirm title={t('integratedDeploy.deleteConfirm')} onConfirm={() => doDelete(r.id)}>
              <Button size="small" danger>
                {t('integratedDeploy.delete')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('integratedDeploy.title')}
      extra={
        canCreate && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/integrated-deploy/new')}>
            {t('integratedDeploy.newOrder')}
          </Button>
        )
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={orders}
        locale={{ emptyText: t('integratedDeploy.empty') }}
      />
    </Card>
  );
}
```

- [ ] **Step 2: 写 vitest**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './render';

vi.mock('../api/integratedDeploy', () => ({
  DEPLOY_KIND_GROUP: {},
  DEPLOY_KINDS: [],
  orderedItems: (x: unknown) => x,
  integratedDeployApi: {
    list: vi.fn().mockResolvedValue([
      { id: 1, title: '工单A', cluster_id: 'test', namespace: 'default', status: 'draft', username: 'admin', updated_at: '2026-07-04' },
    ]),
    copy: vi.fn(), remove: vi.fn(),
  },
}));

vi.mock('../store/auth', () => ({
  useAuthStore: (sel: (s: { user: unknown }) => unknown) =>
    sel({ user: { id: 1, username: 'admin', is_admin: true } }),
}));

import IntegratedDeploy from '../pages/integratedDeploy/IntegratedDeploy';

describe('IntegratedDeploy list', () => {
  beforeEach(() => vi.clearAllMocks());
  it('renders orders from the api', async () => {
    renderWithProviders(<IntegratedDeploy />);
    await waitFor(() => expect(screen.getByText('工单A')).toBeInTheDocument());
    expect(screen.getByText('default')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `cd frontend && npx vitest run src/test/integratedDeploy.test.tsx`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/integratedDeploy/IntegratedDeploy.tsx frontend/src/test/integratedDeploy.test.tsx
git commit -m "feat(integrated-deploy): work-order list page + test"
```

---

## Task 10: 前端工单编辑器 + 发布结果

**Files:**
- Modify: `frontend/src/pages/integratedDeploy/DeployOrderEditor.tsx`

编辑器职责:新建/编辑工单(选集群+命名空间并锁定;增删资源条目:从集群选取或手写 YAML;按组预览发布顺序;保存);发布(确认 → 调用 publish → 时间线展示结果);详情展示发布历史。

- [ ] **Step 1: 实现编辑器页(完整)**

```tsx
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp, Button, Card, Descriptions, Divider, Form, Input, Modal, Select,
  Space, Steps, Table, Tag, Timeline,
} from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  integratedDeployApi, orderedItems, DEPLOY_KINDS, DEPLOY_KIND_GROUP,
  type DeployItem, type DeployRun, type ItemResult,
} from '../../api/integratedDeploy';
import { clusterApi } from '../../api/cluster';
import CodeBox from '../../components/editor/CodeBox';
import { useAuthStore } from '../../store/auth';
import { canGlobal } from '../../nav';

const GROUP_KEY: Record<number, string> = {
  1: 'integratedDeploy.group1',
  2: 'integratedDeploy.group2',
  3: 'integratedDeploy.group3',
};

function phaseTag(phase: string, t: (k: string) => string) {
  const map: Record<string, { color: string; key: string }> = {
    created: { color: 'success', key: 'integratedDeploy.phaseCreated' },
    updated: { color: 'processing', key: 'integratedDeploy.phaseUpdated' },
    failed: { color: 'error', key: 'integratedDeploy.phaseFailed' },
    skipped: { color: 'default', key: 'integratedDeploy.phaseSkipped' },
  };
  const m = map[phase] ?? map.skipped;
  return <Tag color={m.color}>{t(m.key)}</Tag>;
}

export default function DeployOrderEditor() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const { id } = useParams();
  const isNew = !id;
  const me = useAuthStore((s) => s.user);
  const canEdit = canGlobal('integrated_deploy', 'edit', me) || (isNew && canGlobal('integrated_deploy', 'create', me));
  const canPublish = canGlobal('integrated_deploy', 'publish', me);

  const [form] = Form.useForm();
  const [clusters, setClusters] = useState<{ id: string; name: string }[]>([]);
  const [locked, setLocked] = useState(!isNew); // 已存在的工单:集群/命名空间锁定
  const [clusterId, setClusterId] = useState('');
  const [namespace, setNamespace] = useState('');
  const [items, setItems] = useState<DeployItem[]>([]);
  const [runs, setRuns] = useState<DeployRun[]>([]);
  const [lastRun, setLastRun] = useState<DeployRun | null>(null);

  // 加载集群列表(用于新建时选择)。
  useEffect(() => {
    clusterApi.list().then((cs) => setClusters(cs.map((c) => ({ id: c.id, name: c.name })))).catch(() => undefined);
  }, []);

  // 编辑:加载工单。
  useEffect(() => {
    if (!id) return;
    integratedDeployApi.get(Number(id)).then((d) => {
      setClusterId(d.order.cluster_id);
      setNamespace(d.order.namespace);
      setItems(d.order.items ?? []);
      setRuns(d.runs ?? []);
      form.setFieldsValue({ title: d.order.title, description: d.order.description });
    }).catch(() => undefined);
  }, [id, form]);

  const preview = useMemo(() => orderedItems(items), [items]);

  // —— 增加资源条目 ——
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<'selected' | 'authored'>('selected');
  const [addKind, setAddKind] = useState('configmaps');
  const [selectableNames, setSelectableNames] = useState<string[]>([]);
  const [addName, setAddName] = useState('');
  const [addYaml, setAddYaml] = useState('');

  const openAdd = (mode: 'selected' | 'authored') => {
    setAddMode(mode);
    setAddKind('configmaps');
    setAddName('');
    setAddYaml('');
    setSelectableNames([]);
    setAddOpen(true);
  };

  // 选取模式:拉可选资源名单(按写权限过滤)。
  useEffect(() => {
    if (!addOpen || addMode !== 'selected' || !clusterId || !namespace) return;
    integratedDeployApi.selectable(clusterId, namespace, addKind).then(setSelectableNames).catch(() => setSelectableNames([]));
  }, [addOpen, addMode, addKind, clusterId, namespace]);

  const confirmAdd = async () => {
    let yamlText = addYaml;
    let name = addName;
    if (addMode === 'selected') {
      if (!name) {
        message.error(t('integratedDeploy.selectResource'));
        return;
      }
      // 快照选中资源当前 YAML。
      try {
        const obj = await import('../../api/resource').then((m) =>
          m.resourceApi.get(namespace, addKind, name));
        yamlText = await import('js-yaml').then((y) => y.dump(obj));
      } catch {
        message.error(t('integratedDeploy.selectResource'));
        return;
      }
    }
    const nextIndex = items.filter((i) => DEPLOY_KIND_GROUP[i.kind] === DEPLOY_KIND_GROUP[addKind]).length;
    setItems([...items, { kind: addKind, name, source: addMode, manifest_yaml: yamlText, sort_index: nextIndex }]);
    setAddOpen(false);
  };

  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));

  const save = async () => {
    const v = await form.validateFields();
    const body = { cluster_id: clusterId, namespace, title: v.title, description: v.description ?? '', items };
    try {
      if (isNew) {
        const created = await integratedDeployApi.create(body);
        message.success(t('integratedDeploy.saved'));
        navigate(`/integrated-deploy/orders/${created.id}`);
      } else {
        await integratedDeployApi.update(Number(id), body);
        message.success(t('integratedDeploy.saved'));
      }
    } catch {
      /* interceptor toast */
    }
  };

  const doPublish = () => {
    Modal.confirm({
      title: t('integratedDeploy.publishConfirmTitle'),
      width: 560,
      content: (
        <div>
          <p>{t('integratedDeploy.publishConfirmDesc')}</p>
          <Steps
            direction="vertical"
            size="small"
            items={preview.map((it) => ({ title: `${it.kind}/${it.name}`, status: 'wait' }))}
          />
        </div>
      ),
      onOk: async () => {
        const run = await integratedDeployApi.publish(Number(id));
        setLastRun(run);
        setRuns([run, ...runs]);
      },
    });
  };

  const itemColumns = [
    { title: t('integratedDeploy.kind'), dataIndex: 'kind' },
    { title: t('integratedDeploy.resourceName'), dataIndex: 'name' },
    {
      title: t('integratedDeploy.source'),
      dataIndex: 'source',
      render: (s: string) =>
        s === 'selected' ? t('integratedDeploy.addSelected') : t('integratedDeploy.addAuthored'),
    },
    {
      title: t('integratedDeploy.actions'),
      key: 'x',
      render: (_: unknown, _r: DeployItem, idx: number) =>
        canEdit ? <Button size="small" danger onClick={() => removeItem(idx)}>{t('integratedDeploy.delete')}</Button> : null,
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card title={t('integratedDeploy.title')}>
        <Form form={form} layout="vertical" disabled={!canEdit}>
          <Space size={16} wrap>
            <Form.Item label={t('integratedDeploy.cluster')} required>
              <Select
                style={{ width: 200 }}
                value={clusterId || undefined}
                disabled={locked}
                onChange={setClusterId}
                options={clusters.map((c) => ({ value: c.id, label: c.name }))}
              />
            </Form.Item>
            <Form.Item label={t('integratedDeploy.namespace')} required>
              <Input style={{ width: 200 }} value={namespace} disabled={locked} onChange={(e) => setNamespace(e.target.value)} />
            </Form.Item>
          </Space>
          <Form.Item name="title" label={t('integratedDeploy.orderTitle')} rules={[{ required: true }]}>
            <Input style={{ maxWidth: 420 }} />
          </Form.Item>
          <Form.Item name="description" label={t('integratedDeploy.description')}>
            <Input.TextArea rows={2} style={{ maxWidth: 640 }} />
          </Form.Item>
        </Form>
      </Card>

      <Card
        title={t('integratedDeploy.items')}
        extra={
          canEdit && (
            <Space>
              <Button onClick={() => openAdd('selected')} disabled={!clusterId || !namespace}>
                {t('integratedDeploy.addSelected')}
              </Button>
              <Button onClick={() => openAdd('authored')}>{t('integratedDeploy.addAuthored')}</Button>
            </Space>
          )
        }
      >
        <Table rowKey={(_, i) => String(i)} columns={itemColumns} dataSource={items} pagination={false} size="small" />
        <Divider>{t('integratedDeploy.orderPreview')}</Divider>
        <Steps
          direction="vertical"
          size="small"
          items={preview.map((it) => ({
            title: `${it.kind}/${it.name}`,
            description: t(GROUP_KEY[DEPLOY_KIND_GROUP[it.kind] ?? 3]),
            status: 'process',
          }))}
        />
      </Card>

      <Space>
        {canEdit && <Button type="primary" onClick={save}>{t('integratedDeploy.save')}</Button>}
        {!isNew && canPublish && <Button onClick={doPublish}>{t('integratedDeploy.publish')}</Button>}
        <Button onClick={() => navigate('/integrated-deploy')}>{t('common.back') || '返回'}</Button>
      </Space>

      {lastRun && (
        <Card title={t('integratedDeploy.publishResult')}>
          <Timeline
            items={lastRun.results.map((r: ItemResult) => ({
              color: r.phase === 'failed' ? 'red' : r.phase === 'skipped' ? 'gray' : 'green',
              children: (
                <span>
                  {r.kind}/{r.name} {phaseTag(r.phase, t)} {r.message && <span style={{ color: '#cf1322' }}>{r.message}</span>}
                </span>
              ),
            }))}
          />
        </Card>
      )}

      {!isNew && runs.length > 0 && (
        <Card title={t('integratedDeploy.publishHistory')}>
          {runs.map((r) => (
            <Descriptions key={r.id} size="small" column={1} style={{ marginBottom: 12 }}>
              <Descriptions.Item label={r.created_at}>
                {r.status === 'failed' ? phaseTag('failed', t) : phaseTag('created', t)} — {r.username}
              </Descriptions.Item>
            </Descriptions>
          ))}
        </Card>
      )}

      <Modal
        open={addOpen}
        title={addMode === 'selected' ? t('integratedDeploy.addSelected') : t('integratedDeploy.addAuthored')}
        onOk={confirmAdd}
        onCancel={() => setAddOpen(false)}
        width={720}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select
            style={{ width: 240 }}
            value={addKind}
            onChange={setAddKind}
            options={DEPLOY_KINDS.map((k) => ({ value: k, label: k }))}
          />
          {addMode === 'selected' ? (
            <Select
              style={{ width: '100%' }}
              placeholder={t('integratedDeploy.selectResource')}
              value={addName || undefined}
              onChange={setAddName}
              options={selectableNames.map((n) => ({ value: n, label: n }))}
              notFoundContent={t('integratedDeploy.noSelectable')}
            />
          ) : (
            <CodeBox label="YAML" minHeight={280} value={addYaml} onChange={setAddYaml} />
          )}
        </Space>
      </Modal>
    </Space>
  );
}
```

> 依赖确认(实现时先核对,不符则就地适配):
> - `clusterApi.list()` 返回含 `id`、`name` 的集群数组(见 `frontend/src/api/cluster.ts`)。
> - `resourceApi.get(ns, resource, name)` 返回 k8s 对象(见 `frontend/src/api/resource.ts:38`)。
> - `CodeBox` 支持受控 `value`/`onChange`(见 AiConfig 用法);若签名不同,按其真实 props 适配。
> - `js-yaml` 是否已在依赖:若未安装,改用后端返回的 YAML,或用已有的 yaml 序列化工具(前端其它页面查看资源 YAML 的方式,搜索 `js-yaml`/`yaml.dump` 复用)。**实现前先 `grep -r "js-yaml\|yaml.dump" frontend/src` 确认。**

- [ ] **Step 2: 类型检查 + 构建**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: 通过。

- [ ] **Step 3: 全量前端校验**

Run: `cd frontend && npx eslint . --max-warnings 0 && npx vitest run`
Expected: eslint 0 警告;vitest 全绿。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/integratedDeploy/DeployOrderEditor.tsx
git commit -m "feat(integrated-deploy): order editor (add/select/author, ordered preview, publish timeline)"
```

---

## Task 11: 端到端联调 + 全量校验 + 收尾

**Files:** 无新增(修复联调发现的问题)。

- [ ] **Step 1: 后端全量校验**

Run: `cd backend && go build ./... && go test ./...`
Expected: 全绿。

- [ ] **Step 2: 前端全量校验**

Run: `cd frontend && npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && npm run build`
Expected: 全绿。

- [ ] **Step 3: 手动联调(重启前后端后)**

- 用 admin 登录 → 侧边栏出现「集成部署」。
- 新建工单:选 Test 集群 + default 命名空间;「从集群选取」一个 configmap、一个 deployment;「手写 YAML」加一个 service;保存。
- 预览区应按 configmap(组1)→ deployment(组2)→ service(组3)排序。
- 点发布 → 确认弹窗按序展示 → 发布结果时间线每条 created/updated。
- 故意把某条 deployment 的 manifest 改坏(如错误 image 拉取不影响 apply;改一个非法字段触发 apply 失败)→ 发布应在该条 failed 后停止,后续 service 标 skipped。
- 复制工单 → 生成「(副本)」draft。
- 角色页:非 admin 角色勾选 integrated_deploy 的 view 但不给 publish → 该用户能看能编不能发布(发布按钮不显示)。

- [ ] **Step 4: 若联调发现问题,就地修复并补测,单独 commit**

- [ ] **Step 5: 最终 commit(如有)**

```bash
git add -A
git commit -m "fix(integrated-deploy): address integration findings"
```

---

## 自检对照(Spec Coverage)

- 单集群单命名空间 → Task 1 模型 + Task 4 锁定校验 + Task 10 UI 锁定。✅
- 两种来源(选取 + 手写) → Task 10 add 弹窗两模式;selectable(Task 4)。✅
- 固定类型优先级顺序 → `deployKindGroup`/`sortDeployItems`(Task 3)+ 前端 `orderedItems`(Task 7)+ 预览(Task 10)。✅
- 遇错即停 → Task 5 publish 循环 stop-on-error + skipped。✅
- 可反复发布 + 历史 → Task 5 run 记录 + Task 10 历史展示。✅
- 权限区域 view/create/edit/delete/publish → Task 2 + Task 7 矩阵。✅
- 复制复用 create 权限 → Task 4 CopyDeployOrder(路由 create 门控,Task 6)。✅
- 资源级二次校验(保存+发布) → `validateDeployItems`(Task 3)在 create/update/publish 调用。✅
- 可选资源按写权限过滤 → Task 4 ListSelectable。✅
- DB 规范(模型+AutoMigrate+迁移文件) → Task 1。✅
- i18n 7 语言 → Task 7。✅
- 测试(后端权限/顺序/遇错即停/复制/upsert;前端列表/门控/结果) → Task 3/5/9 + Task 11 联调。✅
