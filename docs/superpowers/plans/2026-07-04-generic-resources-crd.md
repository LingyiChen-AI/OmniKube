# 通用资源 / CRD 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 OmniKube 能浏览/查看/编辑/删除集群里的任意资源类型(含 CRD 及未纳入现有 13 种的内置资源),受一个粗粒度 `customresources` 权限门控;AI 助手同步放开。

**Architecture:** 底层通用能力(Dynamic client + Discovery + DeferredDiscoveryRESTMapper + 通用 CRUD + YAML 回退编辑器)已具备。本方案不逐一打开资源,而是:(1) 引入伪资源 `customresources` 承载「所有非内置资源」的权限,并在 `Authorize` 里把未知资源映射到它做 enforce;(2) 新增 `GET /api-resources` 发现端点;(3) 前端新增「API 资源」页复用 `ResourceTable`;(4) 放开三处硬编码白名单。AI 无需改代码——其工具已 `resolveGVR + guard.Allow(→Authorize)`,customresources 映射对其自动生效。

**Tech Stack:** Go / Gin / GORM / Casbin / client-go(discovery、dynamic、RESTMapper);React / TS / Ant Design 5 / Zustand / react-i18next / vitest。

**无数据库变更:** `customresources` 权限存于既有 `ok_role_rules.operations`(TEXT,JSON)与预置角色种子里,不新增表/列。因此**不需要 migration 文件**(CLAUDE.md 的迁移规范只针对表结构变更)。

**已知限制(v1 接受):** 命名空间型 CRD 不做集群级跨 NS 聚合读取(`isAggregatableRead` 仍是固定内置集);在选定 NS 内列举。既有安装的预置角色不会被回填 customresources(种子只在缺失时创建,不覆盖),但 admin 用户旁路一切,自定义角色可在角色页勾选。

---

## 文件结构

**后端(修改):**
- `internal/rbac/resources.go` — 加 `CustomResource` 常量、并入 `validResources`。
- `internal/rbac/service.go` — `Authorize` 未知资源→customresources 映射;`seedPresetRoles` 给 adminOps 补 customresources。
- `internal/rbac/capabilities.go` — `Capabilities` / `AllCapabilities` 额外算 customresources。
- `internal/rbac/operations.go` — `VisibleSubmenus` 显式跳过 customresources(不产生假子菜单)。
- `internal/router/router.go` — 注册 `GET /api-resources`。

**后端(新建):**
- `internal/handler/apiresources.go` — `ListAPIResources` + `flattenAPIResources` 纯函数。
- `internal/handler/apiresources_test.go` — flatten 过滤/排序/builtin 标记测试。

**前端(修改):**
- `src/api/role.ts` — `CUSTOM_RESOURCE` 常量 + 矩阵迭代表纳入它。
- `src/store/caps.ts` — 导出纯函数 `capabilityAllows`,`can` 对非内置资源回退 customresources。
- `src/components/editor/forms/index.ts` — `createTemplate` 接受 `{apiVersion, kind}` 提示。
- `src/components/EditResourceDrawer.tsx` — 新增 `apiVersion` prop,create 时透传给 `createTemplate`。
- `src/components/ResourceTable.tsx` — 新增 `apiVersion` / `kind` prop 并透传给两处 `EditResourceDrawer`。
- `src/pages/roles/Roles.tsx` — 资源矩阵加「其它/自定义资源」行。
- `src/components/Sidebar.tsx` — 加「API 资源」菜单项。
- `src/App.tsx` — 加 `/api-resources` 路由。
- `src/i18n/locales/{zh,en,ja,ko,fr,de,es}.ts` — 新文案。

**前端(新建):**
- `src/api/apiResources.ts` — 发现端点客户端。
- `src/pages/apiResources/ApiResources.tsx` — 通用资源浏览器页。
- `src/store/caps.test.ts` — `capabilityAllows` 回退单测。

---

## Task 1: 伪资源 `customresources`(rbac/resources.go)

**Files:**
- Modify: `backend/internal/rbac/resources.go`
- Test: `backend/internal/rbac/resources_test.go`(若不存在则创建)

- [ ] **Step 1: 写失败测试**

在 `backend/internal/rbac/resources_test.go` 追加(无则新建文件,`package rbac`):

```go
package rbac

import "testing"

func TestCustomResourcesIsValid(t *testing.T) {
	if !IsValidResource(CustomResource) {
		t.Fatalf("customresources 应为合法资源")
	}
	if CustomResource != "customresources" {
		t.Fatalf("CustomResource = %q, want customresources", CustomResource)
	}
}

func TestCustomResourcesActions(t *testing.T) {
	for _, a := range []string{"view", "create", "edit", "delete"} {
		if !ResourceActionApplies(CustomResource, a) {
			t.Fatalf("customresources 应适用动作 %s", a)
		}
	}
	for _, a := range []string{"exec", "reveal"} {
		if ResourceActionApplies(CustomResource, a) {
			t.Fatalf("customresources 不应适用动作 %s", a)
		}
	}
}

// customresources 不进 AllResources(不生成资源导航子菜单)。
func TestCustomResourcesNotInAllResources(t *testing.T) {
	for _, r := range AllResources {
		if r == CustomResource {
			t.Fatalf("customresources 不应出现在 AllResources")
		}
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/rbac/ -run TestCustomResources -v`
Expected: 编译失败 `undefined: CustomResource`。

- [ ] **Step 3: 实现**

编辑 `backend/internal/rbac/resources.go`。在 `validResources` 定义处(第 64 行附近)改为:

```go
// CustomResource 是承载「所有非内置资源」(CRD 及未纳入的内置资源)权限的粗粒度伪资源。
// 它合法(可授予、可鉴权),但不进 moduleResources/AllResources(不生成导航子菜单)。
const CustomResource = "customresources"

var validResources = func() map[string]bool {
	m := setOf(AllResources...)
	m[CustomResource] = true
	return m
}()
```

`ResourceActionApplies` 无需改:其 `view/create/edit/delete` 分支返回 `validResources[resource]`,customresources 现已在集合中→true;`exec`/`reveal` 分支按 pods/secrets 判定→false。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/rbac/ -run TestCustomResources -v`
Expected: PASS(3 个用例)。

- [ ] **Step 5: 提交**

```bash
cd backend && git add internal/rbac/resources.go internal/rbac/resources_test.go
git commit -m "feat(rbac): add customresources pseudo-resource to valid resources

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Authorize 未知资源 → customresources 映射(rbac/service.go)

**Files:**
- Modify: `backend/internal/rbac/service.go:252`(`Authorize`)、`backend/internal/rbac/service.go:138`(`seedPresetRoles`)
- Test: `backend/internal/rbac/service_test.go`(若不存在则创建)

- [ ] **Step 1: 写失败测试**

先看现有 rbac 测试如何构造 `Service`(可复用其 helper)。若无可复用 helper,用如下自包含测试(直接操作 enforcer,不依赖 DB/pool):

```go
package rbac

import "testing"

// newTestEnforcerService 构造一个仅含 enforcer 的 Service(db=nil, pool=nil)。
// 仅用于不触发 isAdminUser/DB 的鉴权分支测试:subject 用非管理员用户 id 字符串,
// isAdminUser 对 db==nil 会 panic,故此处直接注入一条「已知资源」策略并断言映射逻辑。
func newTestEnforcerService(t *testing.T) *Service {
	t.Helper()
	m, err := casbinModelForTest()
	if err != nil {
		t.Fatal(err)
	}
	_ = m
	t.Skip("使用项目既有 rbac 测试 harness 构造 Service;见下方说明")
	return nil
}
```

> 说明:`Authorize` 首行调用 `s.isAdminUser`(读 DB)。项目里已有 rbac 测试(如 `service_test.go`/`authorize_test.go`)用真实 sqlite + enforcer 构造 `Service`。**执行本任务时,先 `rg -l "NewService\(|func.*Service" backend/internal/rbac/*_test.go` 找到既有构造 helper 并复用它**,在其上添加下面两个断言测试。若确无 helper,则新建一个用 `database`(sqlite in-memory)+ `cluster.ClusterPool{}` 构造 `Service` 的 helper。

用既有 harness 写这两个断言(替换上面的占位):

```go
// 未知资源(如 replicasets,不在内置 13 种)应按 customresources 授权判定。
func TestAuthorizeMapsUnknownToCustomResources(t *testing.T) {
	s := setupTestService(t) // ← 复用既有 harness
	uid := createNonAdminUser(t, s) // ← 复用既有 helper 建普通用户,返回其字符串 id

	// 授予该用户在 cluster "c1" 命名空间 "dev" 对 customresources 的 read。
	if err := s.AddGrant(uid, "perm:test-cr", "c1:dev"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.enforcer.AddPolicy("perm:test-cr", "*", CustomResource, "read"); err != nil {
		t.Fatal(err)
	}
	_ = s.enforcer.BuildRoleLinks()

	// replicasets 不是内置资源 → 映射到 customresources → 放行。
	ok, _, err := s.Authorize(uid, "c1", "dev", "replicasets", "read")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatalf("未知资源 replicasets 应经 customresources 放行")
	}

	// deployments 是内置资源 → 不走 customresources → 该用户无 deployments 授权 → 拒绝。
	ok, _, err = s.Authorize(uid, "c1", "dev", "deployments", "read")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("内置资源 deployments 不应借 customresources 授权放行")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/rbac/ -run TestAuthorizeMapsUnknownToCustomResources -v`
Expected: FAIL — replicasets 未被放行(当前 `Authorize` 用原始 resource 名 enforce,无对应策略)。

- [ ] **Step 3: 实现**

编辑 `backend/internal/rbac/service.go` 的 `Authorize`,在 admin 旁路之后、`dom := domainOf(...)` 之前插入映射:

```go
	// 通用资源支持:请求到达此处时 resource 已被中间件用 RESTMapper 解析为真实存在的
	// 资源。凡非内置 13 种(未在 validResources)的真实资源,统一映射到粗粒度伪资源
	// customresources 做 enforce,使 CRD / 未纳入的内置资源受单一权限门控。
	effResource := resource
	if !IsValidResource(resource) {
		effResource = CustomResource
	}
```

然后把该函数内后续所有 `resource` 的 enforce 用法替换为 `effResource`:
- `ok, err := s.enforcer.Enforce(userID, dom, resource, action)` → `... effResource, action)`
- 集群级聚合分支的 `isAggregatableRead(resource)` **保持用 `resource`**(聚合只读仅对内置可聚合资源开放,customresources 不参与聚合)。
- 聚合分支内 `s.enforcer.Enforce(userID, domainOf(clusterID, ns), resource, "read")` **保持 `resource`**(该分支只在 `isAggregatableRead(resource)` 为真时进入,那时 resource 必是内置资源,effResource==resource)。

即仅顶部主 enforce 改用 `effResource`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/rbac/ -run TestAuthorizeMapsUnknownToCustomResources -v`
Expected: PASS。

- [ ] **Step 5: seedPresetRoles 给 admin 类预置角色补 customresources**

编辑 `seedPresetRoles`,在 `for _, res := range AllResources { adminOps[res] = ...; viewOps[res] = ... }` 循环之后追加一行:

```go
	// 「所有资源全部动作」的预置角色(集群管理员 / 运维工程师)同时对 customresources 全动作,
	// 使其能管理 CRD 与未纳入的内置资源。其余预置角色不含(admin 用户本就旁路)。
	adminOps[CustomResource] = resourceActions(CustomResource)
```

(`resourceActions(CustomResource)` 返回 `[view create edit delete]`。)

- [ ] **Step 6: 全量 rbac 测试**

Run: `cd backend && go test ./internal/rbac/ -v`
Expected: PASS(含既有用例不回归)。

- [ ] **Step 7: 提交**

```bash
cd backend && git add internal/rbac/service.go internal/rbac/service_test.go
git commit -m "feat(rbac): map non-builtin resources to customresources in Authorize

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Capabilities 纳入 customresources(rbac/capabilities.go)

**Files:**
- Modify: `backend/internal/rbac/capabilities.go`
- Test: `backend/internal/rbac/capabilities_test.go`(若不存在则创建)

- [ ] **Step 1: 写失败测试**

用既有 rbac harness(同 Task 2)在 `capabilities_test.go` 加:

```go
package rbac

import "testing"

func TestAllCapabilitiesIncludesCustomResources(t *testing.T) {
	caps := AllCapabilities()
	acts, ok := caps[CustomResource]
	if !ok {
		t.Fatalf("AllCapabilities 应含 customresources")
	}
	want := map[string]bool{"view": true, "create": true, "edit": true, "delete": true}
	if len(acts) != len(want) {
		t.Fatalf("customresources 动作 = %v, want view/create/edit/delete", acts)
	}
	for _, a := range acts {
		if !want[a] {
			t.Fatalf("customresources 含意外动作 %s", a)
		}
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/rbac/ -run TestAllCapabilitiesIncludesCustomResources -v`
Expected: FAIL — `AllCapabilities` 只遍历 `AllResources`,不含 customresources。

- [ ] **Step 3: 实现**

编辑 `backend/internal/rbac/capabilities.go`。在文件顶部 `treeActions` 下加一个「能力资源列表」:

```go
// capabilityResources 是要为其计算能力的资源:内置资源子菜单 + 粗粒度 customresources。
// customresources 让前端能对任意非内置资源用 can("customresources", …) 判定按钮。
var capabilityResources = append(append([]string{}, AllResources...), CustomResource)
```

把 `Capabilities` 与 `AllCapabilities` 里的 `for _, res := range AllResources` 两处都改为 `for _, res := range capabilityResources`,并把两处 `make(map[string][]string, len(AllResources))` 改为 `len(capabilityResources)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/rbac/ -run TestAllCapabilitiesIncludesCustomResources -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd backend && git add internal/rbac/capabilities.go internal/rbac/capabilities_test.go
git commit -m "feat(rbac): expose customresources in capabilities

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: VisibleSubmenus 跳过 customresources(rbac/operations.go)

**Files:**
- Modify: `backend/internal/rbac/operations.go:63`(`VisibleSubmenus`)
- Test: `backend/internal/rbac/operations_test.go`(若不存在则创建)

- [ ] **Step 1: 写失败测试**

```go
package rbac

import (
	"reflect"
	"testing"
)

// customresources 有 view 也不应进导航子菜单(它没有对应的资源专页)。
func TestVisibleSubmenusSkipsCustomResources(t *testing.T) {
	raw := `{"deployments":["view"],"customresources":["view","edit"]}`
	got := VisibleSubmenus([]string{raw})
	want := []string{"deployments"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("VisibleSubmenus = %v, want %v", got, want)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/rbac/ -run TestVisibleSubmenusSkipsCustomResources -v`
Expected: FAIL — 当前 customresources 合法且有 view,会被含入 → `[customresources deployments]`。

- [ ] **Step 3: 实现**

编辑 `VisibleSubmenus`,在 `if !IsValidResource(res) { continue }` 之后加一行:

```go
			if !IsValidResource(res) {
				continue
			}
			if res == CustomResource {
				continue // 粗粒度伪资源无资源专页,不进导航子菜单。
			}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/rbac/ -run TestVisibleSubmenusSkipsCustomResources -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd backend && git add internal/rbac/operations.go internal/rbac/operations_test.go
git commit -m "fix(rbac): skip customresources in VisibleSubmenus (no phantom submenu)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 发现端点 `GET /api-resources`(handler/apiresources.go)

**Files:**
- Create: `backend/internal/handler/apiresources.go`
- Create: `backend/internal/handler/apiresources_test.go`
- Modify: `backend/internal/router/router.go:112`(在 `/namespaces` 后加路由)

- [ ] **Step 1: 写失败测试(测纯函数 flatten)**

`backend/internal/handler/apiresources_test.go`:

```go
package handler

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestFlattenAPIResources(t *testing.T) {
	lists := []*metav1.APIResourceList{
		{
			GroupVersion: "apps/v1",
			APIResources: []metav1.APIResource{
				{Name: "deployments", Kind: "Deployment", Namespaced: true, Verbs: metav1.Verbs{"get", "list", "create"}},
				{Name: "deployments/status", Kind: "Deployment", Namespaced: true, Verbs: metav1.Verbs{"get"}}, // 子资源,跳过
				{Name: "replicasets", Kind: "ReplicaSet", Namespaced: true, Verbs: metav1.Verbs{"get", "list"}},
			},
		},
		{
			GroupVersion: "v1",
			APIResources: []metav1.APIResource{
				{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: metav1.Verbs{"get", "list"}},
				{Name: "componentstatuses", Kind: "ComponentStatus", Namespaced: false, Verbs: metav1.Verbs{"get"}}, // 无 list,跳过
			},
		},
	}
	got := flattenAPIResources(lists)

	// 子资源与无 list 的被过滤:剩 deployments/replicasets/pods,按 group 再 resource 排序
	// (core "" 组排在 "apps" 前 → pods, 然后 apps: deployments, replicasets)。
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3: %+v", len(got), got)
	}
	if got[0].Resource != "pods" || got[0].Group != "" {
		t.Fatalf("got[0] = %+v, want pods(core)", got[0])
	}
	if got[1].Resource != "deployments" || got[1].Group != "apps" {
		t.Fatalf("got[1] = %+v, want apps/deployments", got[1])
	}
	if got[2].Resource != "replicasets" {
		t.Fatalf("got[2] = %+v, want replicasets", got[2])
	}
	// deployments/pods 是内置 13 种 → builtin=true;replicasets 不是 → false。
	if !got[1].Builtin {
		t.Fatalf("deployments 应 builtin=true")
	}
	if got[2].Builtin {
		t.Fatalf("replicasets 应 builtin=false")
	}
	if !got[0].Namespaced {
		t.Fatalf("pods 应 namespaced=true")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/handler/ -run TestFlattenAPIResources -v`
Expected: 编译失败 `undefined: flattenAPIResources`。

- [ ] **Step 3: 实现 handler + 纯函数**

`backend/internal/handler/apiresources.go`:

```go
package handler

import (
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"

	"omnikube/internal/rbac"
)

// apiResourceInfo 是发现端点回传的单条资源类型元数据(非资源数据本身)。
type apiResourceInfo struct {
	Group      string   `json:"group"`
	Version    string   `json:"version"`
	Resource   string   `json:"resource"` // 复数名,用于通用 CRUD 路由的 :resource
	Kind       string   `json:"kind"`
	Namespaced bool     `json:"namespaced"`
	Builtin    bool     `json:"builtin"` // 是否为现有 13 种内置资源(前端可默认隐藏)
	Verbs      []string `json:"verbs"`
}

// ListAPIResources 用 discovery 列出当前集群所有资源类型(含 CRD)。门槛仅 JWT + 有效集群:
// 只返回类型元数据,真正的资源数据仍由 RBAC 中间件逐资源门控。
func (h *Handler) ListAPIResources(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	lists, err := cc.Discovery.ServerPreferredResources()
	// 个别 API 组发现失败(如聚合 API 后端不可用)仍会返回其余部分结果;忽略该错误。
	if err != nil && !discovery.IsGroupDiscoveryFailedError(err) {
		writeK8sError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"resources": flattenAPIResources(lists)})
}

// flattenAPIResources 把 discovery 的分组结果展平为条目数组:剔除子资源(名字含 "/")
// 与不可 list 的类型;标注 builtin;按 group 再 resource 排序。
func flattenAPIResources(lists []*metav1.APIResourceList) []apiResourceInfo {
	out := make([]apiResourceInfo, 0, 128)
	for _, list := range lists {
		if list == nil {
			continue
		}
		gv, err := schema.ParseGroupVersion(list.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range list.APIResources {
			if strings.Contains(r.Name, "/") { // 子资源(如 pods/log)
				continue
			}
			if !hasVerb(r.Verbs, "list") { // 不可列举的类型对浏览无意义
				continue
			}
			out = append(out, apiResourceInfo{
				Group:      gv.Group,
				Version:    gv.Version,
				Resource:   r.Name,
				Kind:       r.Kind,
				Namespaced: r.Namespaced,
				Builtin:    rbac.IsValidResource(r.Name),
				Verbs:      r.Verbs,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Group != out[j].Group {
			return out[i].Group < out[j].Group
		}
		return out[i].Resource < out[j].Resource
	})
	return out
}

// hasVerb 判断 verb 列表是否含目标动词。
func hasVerb(verbs metav1.Verbs, want string) bool {
	for _, v := range verbs {
		if v == want {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/handler/ -run TestFlattenAPIResources -v`
Expected: PASS。

- [ ] **Step 5: 注册路由**

编辑 `backend/internal/router/router.go`,在第 112 行 `authed.GET("/namespaces", h.ListNamespaces)` 之后加:

```go
			// 通用资源类型发现:JWTAuth + 有效 X-Cluster-ID(handler 内校验)。
			// 只回类型元数据,资源数据仍由 RBACAuthMiddleware 逐资源门控。
			authed.GET("/api-resources", h.ListAPIResources)
```

- [ ] **Step 6: 构建 + 全量后端测试**

Run: `cd backend && go build ./... && go test ./...`
Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```bash
cd backend && git add internal/handler/apiresources.go internal/handler/apiresources_test.go internal/router/router.go
git commit -m "feat(handler): add GET /api-resources discovery endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 前端 `CUSTOM_RESOURCE` + 矩阵迭代(api/role.ts)

**Files:**
- Modify: `frontend/src/api/role.ts`

- [ ] **Step 1: 加常量与迭代表**

编辑 `frontend/src/api/role.ts`。在 `ALL_RESOURCES` 定义(第 51 行)之后加:

```ts
/** 粗粒度伪资源:承载所有非内置资源(CRD 等)的权限。与后端 rbac.CustomResource 对齐。 */
export const CUSTOM_RESOURCE = 'customresources';

/** 判断是否为内置(有专页)的具体资源。 */
export function isBuiltinResource(resource: string): boolean {
  return (ALL_RESOURCES as string[]).includes(resource);
}

/** 角色资源矩阵要渲染/持久化的资源:内置资源 + customresources 行。 */
export const MATRIX_RESOURCES: string[] = [...ALL_RESOURCES, CUSTOM_RESOURCE];
```

- [ ] **Step 2: `cleanOperations` 纳入 customresources**

把 `cleanOperations`(第 101 行)里的 `for (const res of ALL_RESOURCES)` 改为 `for (const res of MATRIX_RESOURCES)`。
把 `operationsToCheckedKeys`(第 166 行)里的 `for (const res of ALL_RESOURCES)` 改为 `for (const res of MATRIX_RESOURCES)`。

(`actionAppliesToResource('customresources', a)` 走默认分支:view/create/edit/delete→true,exec/reveal→false,publish→false;`actionsForResource('customresources')` 因此返回 `[view,create,edit,delete]`,无需改。`checkedKeysToOperations` 已按 key 收集任意 resource 再经 `cleanOperations` 过滤,现会保留 customresources。)

- [ ] **Step 3: 类型检查**

Run: `cd frontend && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
cd frontend && git add src/api/role.ts
git commit -m "feat(role): add customresources to the permission matrix helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `can` 对非内置资源回退 customresources(store/caps.ts)

**Files:**
- Modify: `frontend/src/store/caps.ts`
- Create: `frontend/src/store/caps.test.ts`

- [ ] **Step 1: 写失败测试**

`frontend/src/store/caps.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { capabilityAllows } from './caps';
import type { CapabilityResources } from '../api/me';

describe('capabilityAllows', () => {
  const caps: CapabilityResources = {
    deployments: ['view', 'edit'],
    pods: [],
    customresources: ['view', 'create'],
  };

  it('uses the concrete resource entry for built-ins', () => {
    expect(capabilityAllows(caps, 'deployments', 'edit')).toBe(true);
    expect(capabilityAllows(caps, 'deployments', 'delete')).toBe(false);
  });

  it('denies a built-in with an empty action set (no customresources fallback)', () => {
    // pods is built-in and returned empty → must NOT borrow customresources.
    expect(capabilityAllows(caps, 'pods', 'create')).toBe(false);
  });

  it('falls back to customresources for unknown/CRD resources', () => {
    expect(capabilityAllows(caps, 'virtualservices', 'view')).toBe(true);
    expect(capabilityAllows(caps, 'virtualservices', 'create')).toBe(true);
    expect(capabilityAllows(caps, 'virtualservices', 'delete')).toBe(false);
  });

  it('returns false when resource is undefined', () => {
    expect(capabilityAllows(caps, undefined, 'view')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/store/caps.test.ts`
Expected: FAIL — `capabilityAllows` 未导出。

- [ ] **Step 3: 实现**

编辑 `frontend/src/store/caps.ts`。顶部 import 加:

```ts
import { CUSTOM_RESOURCE, isBuiltinResource } from '../api/role';
```

在文件末尾(`useCapabilities` 之前或之后均可)加导出的纯函数:

```ts
/**
 * 判定 `resources` 能力集中,当前用户能否对 `resource` 执行 `action`。
 * 内置资源用其自身条目(可能为空数组=已知但无权);未知/CRD 资源回退到粗粒度
 * customresources 授权。resource 为空一律 false。
 */
export function capabilityAllows(
  resources: CapabilityResources,
  resource: string | undefined,
  action: TreeAction,
): boolean {
  if (!resource) return false;
  const acts = resources[resource] ?? (isBuiltinResource(resource) ? [] : resources[CUSTOM_RESOURCE] ?? []);
  return acts.includes(action);
}
```

把 `useCapabilities` 里的 `can` 改为复用它:

```ts
  const can = useCallback(
    (resource: string | undefined, action: TreeAction): boolean =>
      capabilityAllows(resources, resource, action),
    [resources],
  );
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/store/caps.test.ts`
Expected: PASS(4 用例)。

- [ ] **Step 5: 提交**

```bash
cd frontend && git add src/store/caps.ts src/store/caps.test.ts
git commit -m "feat(caps): fall back to customresources for unknown resources in can()

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: create 模板接受 apiVersion/kind 提示(editor/forms + EditResourceDrawer + ResourceTable)

> 目的:CRD 走「新建」时,YAML 骨架能带上正确的 apiVersion/kind,而非通用 `apiVersion: v1, kind: ''`。内置资源页行为不变(不传这两个 prop)。

**Files:**
- Modify: `frontend/src/components/editor/forms/index.ts:229`(`createTemplate`)
- Modify: `frontend/src/components/EditResourceDrawer.tsx`
- Modify: `frontend/src/components/ResourceTable.tsx`

- [ ] **Step 1: `createTemplate` 接受提示**

编辑 `frontend/src/components/editor/forms/index.ts`,把 `createTemplate` 改为:

```ts
export function createTemplate(
  resource: string,
  namespace: string,
  hint?: { apiVersion?: string; kind?: string },
): CreateTemplate {
  const ns = namespace || 'default';
  const kind = kindFromResource(resource) ?? hint?.kind;
  const make = kind ? TEMPLATES[kind] : undefined;
  if (make) return make(ns);
  return {
    apiVersion: hint?.apiVersion ?? 'v1',
    kind: kind ?? '',
    metadata: { name: '', namespace: ns },
  };
}
```

- [ ] **Step 2: `EditResourceDrawer` 新增 `apiVersion` prop 并透传**

编辑 `frontend/src/components/EditResourceDrawer.tsx`。在 `EditResourceDrawerProps` 里 `kind?: string;`(第 63 行附近)之后加:

```ts
  /** 通用资源页(CRD)可传入 group/version,让 create 骨架带上正确 apiVersion。 */
  apiVersion?: string;
```

在解构参数(第 84 行的 `export default function EditResourceDrawer({`)里加 `apiVersion,`。

把 create 分支的 `const tpl = createTemplate(resource, namespace) as K8sObject;`(第 130 行)改为:

```ts
      const tpl = createTemplate(resource, namespace, { apiVersion, kind }) as K8sObject;
```

- [ ] **Step 3: `ResourceTable` 新增 `apiVersion` / `kind` prop 并透传**

编辑 `frontend/src/components/ResourceTable.tsx`。在 `ResourceTableProps`(第 52 行)里加:

```ts
  /** 通用资源页可覆盖 Kind / apiVersion(内置资源页不传,由 kindFromResource 推断)。 */
  kind?: string;
  apiVersion?: string;
```

在解构参数里加 `kind: kindOverride, apiVersion,`。把两处 `<EditResourceDrawer ... kind={kindFromResource(resource)} .../>`(第 312、326 行)改为:

```tsx
          kind={kindOverride ?? kindFromResource(resource)}
          apiVersion={apiVersion}
```

- [ ] **Step 4: 类型检查 + 既有编辑器测试不回归**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/test/editor.test.tsx`
Expected: 无错误,PASS。

- [ ] **Step 5: 提交**

```bash
cd frontend && git add src/components/editor/forms/index.ts src/components/EditResourceDrawer.tsx src/components/ResourceTable.tsx
git commit -m "feat(editor): thread apiVersion/kind into create templates for CRDs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 发现端点前端客户端(api/apiResources.ts)

**Files:**
- Create: `frontend/src/api/apiResources.ts`

- [ ] **Step 1: 写客户端**

`frontend/src/api/apiResources.ts`:

```ts
import client from './client';

/** 一种集群资源类型的元数据(来自 GET /api-resources)。 */
export interface ApiResourceType {
  group: string;
  version: string;
  resource: string; // 复数名,用于通用 CRUD
  kind: string;
  namespaced: boolean;
  builtin: boolean; // 现有 13 种内置资源(前端默认隐藏)
  verbs: string[];
}

/** group/version 拼成 apiVersion:core 组无 group,直接用 version。 */
export function apiVersionOf(t: ApiResourceType): string {
  return t.group ? `${t.group}/${t.version}` : t.version;
}

export const apiResourcesApi = {
  list: () =>
    client.get<{ resources: ApiResourceType[] }>('/api-resources').then((r) => r.data.resources ?? []),
};
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
cd frontend && git add src/api/apiResources.ts
git commit -m "feat(api): add apiResources discovery client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 「API 资源」页(pages/apiResources/ApiResources.tsx)

**Files:**
- Create: `frontend/src/pages/apiResources/ApiResources.tsx`

- [ ] **Step 1: 写页面**

`frontend/src/pages/apiResources/ApiResources.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Card, Checkbox, Empty, Select, Space, Typography } from 'antd';
import { ApiOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import { apiResourcesApi, apiVersionOf, type ApiResourceType } from '../../api/apiResources';
import { useCtxStore } from '../../store/ctx';

const { Title, Text } = Typography;

/** 通用资源浏览器:发现集群里的任意资源类型(含 CRD),选中后复用 ResourceTable。 */
export default function ApiResources() {
  const { t } = useTranslation();
  const { currentCluster } = useCtxStore();
  const [types, setTypes] = useState<ApiResourceType[]>([]);
  const [loading, setLoading] = useState(false);
  const [hideBuiltin, setHideBuiltin] = useState(true);
  const [selected, setSelected] = useState<string | null>(null); // group/version/resource 的稳定 key

  // 每种类型一个稳定 key(同名资源可能跨组,故带 group/version)。
  const keyOf = (r: ApiResourceType) => `${r.group}/${r.version}/${r.resource}`;

  useEffect(() => {
    if (!currentCluster) {
      setTypes([]);
      setSelected(null);
      return;
    }
    let active = true;
    setLoading(true);
    apiResourcesApi
      .list()
      .then((list) => {
        if (!active) return;
        setTypes(list);
      })
      .catch(() => {
        if (active) setTypes([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // 切换集群时重拉并清空已选(避免展示上一集群的类型)。
  }, [currentCluster]);

  // 切集群后已选类型可能不存在了 → 清空。
  useEffect(() => {
    if (selected && !types.some((r) => keyOf(r) === selected)) setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types]);

  const visible = useMemo(
    () => types.filter((r) => (hideBuiltin ? !r.builtin : true)),
    [types, hideBuiltin],
  );

  // 按 group 分组的下拉选项。
  const options = useMemo(() => {
    const byGroup = new Map<string, ApiResourceType[]>();
    for (const r of visible) {
      const g = r.group || 'core';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(r);
    }
    return Array.from(byGroup.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([g, rs]) => ({
        label: g,
        options: rs.map((r) => ({
          value: keyOf(r),
          label: `${r.kind} · ${r.resource}`,
        })),
      }));
  }, [visible]);

  const sel = useMemo(() => types.find((r) => keyOf(r) === selected) ?? null, [types, selected]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <Title level={4} style={{ margin: 0 }}>
          <ApiOutlined /> {t('apiResources.title')}
        </Title>
        <Text type="secondary">{t('apiResources.desc')}</Text>
      </div>
      <Card>
        <Space wrap size="middle" style={{ width: '100%' }}>
          <Select
            style={{ minWidth: 360 }}
            loading={loading}
            showSearch
            placeholder={t('apiResources.pickType')}
            value={selected ?? undefined}
            onChange={(v) => setSelected(v)}
            options={options}
            optionFilterProp="label"
            disabled={!currentCluster}
          />
          <Checkbox checked={hideBuiltin} onChange={(e) => setHideBuiltin(e.target.checked)}>
            {t('apiResources.hideBuiltin')}
          </Checkbox>
        </Space>
      </Card>
      {sel ? (
        <ResourceTable
          key={selected ?? undefined}
          title={`${sel.kind} · ${sel.resource}`}
          resource={sel.resource}
          namespaced={sel.namespaced}
          kind={sel.kind}
          apiVersion={apiVersionOf(sel)}
        />
      ) : (
        <Card>
          <Empty description={t('apiResources.pickType')} />
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 类型检查 + lint**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/pages/apiResources/ApiResources.tsx --max-warnings 0`
Expected: 无错误(i18n key 尚未加,运行时显示 key 名,Task 12 补齐)。

- [ ] **Step 3: 提交**

```bash
cd frontend && git add src/pages/apiResources/ApiResources.tsx
git commit -m "feat(apiResources): generic resource browser page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: 角色页 customresources 行(pages/roles/Roles.tsx)

**Files:**
- Modify: `frontend/src/pages/roles/Roles.tsx`

- [ ] **Step 1: 先读现有资源矩阵渲染**

Run: `cd frontend && rg -n "MODULE_KEYS|MODULE_RESOURCES|actionsForResource|resActionKey|moduleNodeKey|Tree|treeData|operationsToCheckedKeys" src/pages/roles/Roles.tsx`
先理解资源树/矩阵是如何由 `MODULE_KEYS` + `MODULE_RESOURCES` 构建的(模块父节点 → 资源子节点 → 动作叶子)。

- [ ] **Step 2: 加一个独立的「其它/自定义资源」节点**

在构建资源树 `treeData` 的位置,在所有 module 节点**之后**追加一个顶层节点(不属于任何 module),其子为 customresources 的四个动作叶子。用既有的 `resNodeKey` / `resActionKey` / `actionsForResource` helper,保持与内置资源同构:

```tsx
// 「其它/自定义资源」:粗粒度 customresources,承载所有 CRD / 未纳入内置资源的权限。
// 与内置资源同构:一个资源节点 + view/create/edit/delete 四个动作叶子。
{
  key: resNodeKey(CUSTOM_RESOURCE),
  title: t('role.customResources'),
  children: actionsForResource(CUSTOM_RESOURCE).map((a) => ({
    key: resActionKey(CUSTOM_RESOURCE, a),
    title: t(`role.action.${a}`), // 复用既有动作文案 key;若项目用别的 key,按现有资源动作叶子的写法对齐
  })),
},
```

> 执行时:**照抄现有内置资源叶子节点的 title 生成方式**(动作文案的 i18n key 以现有代码为准),仅把 resource 换成 `CUSTOM_RESOURCE`、节点标题换成 `t('role.customResources')`。`CUSTOM_RESOURCE` / `actionsForResource` / `resNodeKey` / `resActionKey` 从 `../../api/role` 导入。

因 Task 6 已让 `operationsToCheckedKeys` / `checkedKeysToOperations` / `cleanOperations` 覆盖 `MATRIX_RESOURCES`(含 customresources),勾选状态的读出与回写自动生效,无需改保存逻辑。

- [ ] **Step 3: 命名空间 scope 下不禁用**

customresources **不是**集群级专属资源(`CLUSTER_SCOPED_RESOURCES` 只含 nodes/persistentvolumes),故命名空间 scope 下应可正常勾选,无需加入禁用集。确认 `stripClusterScopedOps` / `isClusterScopedResource` 不影响 customresources(它们只针对 nodes/persistentvolumes)——无需改动。

- [ ] **Step 4: 类型检查 + lint + 既有角色相关测试**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/pages/roles/Roles.tsx --max-warnings 0 && npx vitest run`
Expected: 无错误,全部 PASS。

- [ ] **Step 5: 提交**

```bash
cd frontend && git add src/pages/roles/Roles.tsx
git commit -m "feat(roles): add customresources row to the permission matrix

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: 菜单 + 路由 + i18n(Sidebar / App / locales)

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/i18n/locales/{zh,en,ja,ko,fr,de,es}.ts`

- [ ] **Step 1: Sidebar 加「API 资源」入口**

编辑 `frontend/src/components/Sidebar.tsx`。import 里加 `ApiOutlined`(来自 `@ant-design/icons`)。在 `nodes` 项之后、`integrated_deploy` 项之前(第 93–98 行附近)加一个始终对登录用户显示的入口(页面自身按 capability 门控,见 spec 决策):

```tsx
    // API 资源(通用/CRD 浏览器):始终显示入口,页面内按 capability 显示可操作类型。
    base.push({ key: '/api-resources', icon: <ApiOutlined />, label: t('nav.apiResources') });
```

- [ ] **Step 2: App 加路由**

编辑 `frontend/src/App.tsx`。参照现有资源路由的写法(用 `ProtectedRoute`,不套 `GlobalRoute`——它无全局区域,页面自身按 capability 门控)。加:

```tsx
import ApiResources from './pages/apiResources/ApiResources';
// ...
<Route path="/api-resources" element={<ProtectedRoute><ApiResources /></ProtectedRoute>} />
```

> 执行时以 `App.tsx` 现有 `ProtectedRoute` 用法为准(如它已在外层统一包裹,则只加 `<Route path="/api-resources" element={<ApiResources />} />`)。

- [ ] **Step 3: i18n 补 7 语言**

在每个 locale 文件的 `nav` 对象加 `apiResources`,并新增顶层 `apiResources` 段与 `role.customResources`。各语言取值:

`zh.ts`:
```ts
// nav 内:
apiResources: 'API 资源',
// role 内:
customResources: '其它 / 自定义资源',
// 顶层新增:
apiResources: {
  title: 'API 资源',
  desc: '浏览并管理集群里的任意资源类型,包括 CRD 与未纳入专页的内置资源。',
  pickType: '选择资源类型',
  hideBuiltin: '隐藏已有专页的内置资源',
},
```

`en.ts`:
```ts
apiResources: 'API Resources',
customResources: 'Other / Custom Resources',
apiResources: {
  title: 'API Resources',
  desc: 'Browse and manage any resource type in the cluster, including CRDs and built-ins without a dedicated page.',
  pickType: 'Select a resource type',
  hideBuiltin: 'Hide built-in resources that have a dedicated page',
},
```

`ja.ts`:
```ts
apiResources: 'API リソース',
customResources: 'その他 / カスタムリソース',
apiResources: {
  title: 'API リソース',
  desc: 'CRD や専用ページのない組み込みリソースを含む、クラスター内の任意のリソースタイプを閲覧・管理します。',
  pickType: 'リソースタイプを選択',
  hideBuiltin: '専用ページのある組み込みリソースを隠す',
},
```

`ko.ts`:
```ts
apiResources: 'API 리소스',
customResources: '기타 / 사용자 정의 리소스',
apiResources: {
  title: 'API 리소스',
  desc: 'CRD 및 전용 페이지가 없는 기본 리소스를 포함하여 클러스터의 모든 리소스 유형을 탐색하고 관리합니다.',
  pickType: '리소스 유형 선택',
  hideBuiltin: '전용 페이지가 있는 기본 리소스 숨기기',
},
```

`fr.ts`:
```ts
apiResources: 'Ressources API',
customResources: 'Autres / Ressources personnalisées',
apiResources: {
  title: 'Ressources API',
  desc: 'Parcourez et gérez tout type de ressource du cluster, y compris les CRD et les ressources intégrées sans page dédiée.',
  pickType: 'Sélectionner un type de ressource',
  hideBuiltin: 'Masquer les ressources intégrées ayant une page dédiée',
},
```

`de.ts`:
```ts
apiResources: 'API-Ressourcen',
customResources: 'Andere / Benutzerdefinierte Ressourcen',
apiResources: {
  title: 'API-Ressourcen',
  desc: 'Durchsuchen und verwalten Sie beliebige Ressourcentypen im Cluster, einschließlich CRDs und integrierter Ressourcen ohne eigene Seite.',
  pickType: 'Ressourcentyp auswählen',
  hideBuiltin: 'Integrierte Ressourcen mit eigener Seite ausblenden',
},
```

`es.ts`:
```ts
apiResources: 'Recursos API',
customResources: 'Otros / Recursos personalizados',
apiResources: {
  title: 'Recursos API',
  desc: 'Explore y gestione cualquier tipo de recurso del clúster, incluidos los CRD y los recursos integrados sin página dedicada.',
  pickType: 'Seleccione un tipo de recurso',
  hideBuiltin: 'Ocultar recursos integrados que tienen página dedicada',
},
```

> 注意:`nav.apiResources` 放进各文件已有的 `nav: {...}` 对象;`customResources` 放进已有的 `role: {...}` 对象;顶层 `apiResources: {...}` 作为新的一级键。若某语言文件的动作文案 key(view/create/edit/delete)与 Task 11 Step 2 用的不同,以该文件现有资源动作叶子的 key 为准。

- [ ] **Step 4: 全前端校验**

Run: `cd frontend && npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && npm run build`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
cd frontend && git add src/components/Sidebar.tsx src/App.tsx src/i18n/locales
git commit -m "feat(nav): add API Resources menu, route and i18n (7 locales)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: AI 助手确认 + 集成校验

> AI 工具(`list_resources`/`get_resource`/`get_pod_logs`/write tools)已 `resolveGVR + guard.Allow/AllowRead(→Authorize)`,且工具描述已声明「支持任意资源类型」。Task 2 的 customresources 映射在 `Authorize` 内生效,故 AI 对任意资源的操作**自动**受 customresources 门控——**无需改 AI 代码**。本任务仅做验证,不新增 prompt。

**Files:**
- (仅验证)`backend/internal/ai/tools.go`、`backend/internal/ai/write_tools.go`、`backend/internal/ai/executor.go`

- [ ] **Step 1: 确认 AI 无 IsValidResource 类硬编码校验**

Run: `cd backend && rg -n "IsValidResource|validResource|moduleResources|AllResources" internal/ai/`
Expected: 无匹配(AI 包不引用资源白名单;资源名以 RESTMapper 解析为准,鉴权以 guard→Authorize 为准)。若出现意外匹配,移除该校验并说明。

- [ ] **Step 2: 全量后端测试(确保 AI guard 经 Authorize 的映射不回归)**

Run: `cd backend && go test ./...`
Expected: 全部 PASS(Task 2 的 Authorize 映射已被 rbac 测试覆盖;AI guard 转调 Authorize,行为一致)。

- [ ] **Step 3: 无改动则无需提交**

若 Step 1 无需改动,本任务不产生提交。

---

## Task 14: 端到端构建校验 + 收尾

- [ ] **Step 1: 后端**

Run: `cd backend && go build ./... && go test ./...`
Expected: 全部 PASS。

- [ ] **Step 2: 前端**

Run: `cd frontend && npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && npm run build`
Expected: 全部通过。

- [ ] **Step 3: 更新路线图**

编辑 `docs/roadmap-highvalue.md`,把「执行顺序」里第 1 项「通用资源 / CRD 支持(← 当前进行中)」标为已完成(去掉「当前进行中」标注,或在「现状盘点」段补一句)。

- [ ] **Step 4: 提交**

```bash
git add docs/roadmap-highvalue.md
git commit -m "docs(roadmap): mark generic resources / CRD support as done

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review(对照 spec 的覆盖核对)

- **权限模型 customresources**:Task 1(合法性 + 动作)、Task 2(Authorize 映射 + 预置角色种子)。✅
- **发现端点 GET /api-resources**:Task 5(过滤子资源/不可 list、builtin 标记、ErrGroupDiscoveryFailed 容错、排序)。✅
- **放开三处内置校验**:role.go `validateRules` 依赖 `IsValidResource`,Task 1 把 customresources 并入 `validResources` 后自然放行(无需改 role.go);capabilities.go(Task 3);operations.go `VisibleSubmenus`(Task 4)。✅
- **CRUD 不改**:通用 CRUD 已支持任意资源(resource.go 走 dynamic client,不引用 validResources);无任务改动,符合 spec。✅
- **前端 API 资源页**:Task 9(client)、Task 10(页面复用 ResourceTable + EditResourceDrawer YAML 回退)、Task 8(CRD create 骨架)。✅
- **can 回退 customresources**:Task 7。✅
- **角色页 customresources 行**:Task 6(矩阵 helper)、Task 11(UI 行)。✅
- **AI 放开任意资源**:Task 13(已由通用架构 + Task 2 映射自动满足,验证为主)。✅
- **菜单 + 路由 + i18n×7**:Task 12。✅
- **错误处理**:未知资源→RESTMapper 400(既有);无权→403(customresources 闸门,Task 2);发现部分失败→忽略 ErrGroupDiscoveryFailed(Task 5);集群不可用→400(Task 5)。✅
- **测试**:Authorize 映射(T2)、validateRules 经 validResources(T1 覆盖合法性)、Capabilities 含 customresources(T3)、ListAPIResources flatten(T5)、ResourceActionApplies(T1)、can 回退(T7)。✅

**类型/命名一致性**:后端 `CustomResource="customresources"` 与前端 `CUSTOM_RESOURCE='customresources'` 对齐;`flattenAPIResources`/`apiResourceInfo` 前后端字段名一致(group/version/resource/kind/namespaced/builtin/verbs);`capabilityAllows` 在 Task 7 定义并在同任务被 `can` 复用。无占位符。
