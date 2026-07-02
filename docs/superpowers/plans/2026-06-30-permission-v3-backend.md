# 权限模型 v3 — Part A 后端 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 executing-plans，按任务逐个实现；TDD（先写失败测试）+ 小步提交。

**Goal:** 把后端权限从「资源组×动作 + 派生页面 + 功能页」全量换成「全局权限 + 每集群按具体资源的操作树」，并据此鉴权、返回导航。

**Architecture:** Casbin 物化改为按具体资源；系统管理端点改 `RequireGlobalPerm`；`/me` 返回 `nav`(资源子菜单并集)+`global`(全局权限并集)；capabilities 按具体资源；预设按新模型重建。

**Tech Stack:** Go + Gin + GORM + Casbin v2，PostgreSQL，内存 sqlite 单测。所有 `go` 命令在 `backend/` 下执行。

来源 spec：`docs/superpowers/specs/2026-06-30-omnikube-permission-v3-design.md`。

---

## 文件结构（均在 `backend/`）

| 文件 | 职责 |
|---|---|
| `internal/model/model.go` | `Role.GlobalPerms` 字段；`RoleRule.Operations` 语义改 per-resource（同列）|
| `internal/rbac/resources.go` | 资源→模块映射、动作适用性、`validResources`、`validGlobalAreas`、`validGlobalActions` |
| `internal/rbac/service.go` | `SyncUserGrants` 按 resource 物化；`UserGlobalPerms`；预设重建 |
| `internal/rbac/operations.go` | 资源子菜单并集 helper、全局权限并集 helper、签名 |
| `internal/rbac/capabilities.go` | capabilities 按具体资源 |
| `internal/middleware/globalperm.go`(new) | `RequireGlobalPerm(area, action)` 中间件 |
| `internal/middleware/rbac.go` | parseAction 不变（POST→create 已在）；resource 解析不变 |
| `internal/handler/auth.go` | `/me` 返回 `nav`+`global`；`/me/capabilities` 按资源 |
| `internal/handler/role.go` | 创建/更新角色接受 `global_perms` + per-resource `operations`；校验 |
| `internal/router/router.go` | 系统端点用 `RequireGlobalPerm` 替换 `RequireAdmin`；`/releases` 同理 |

---

## Task 1: 资源/全局 词表与映射（rbac/resources.go）

**Files:** Modify `internal/rbac/resources.go`; Test `internal/rbac/resources_test.go`

- [ ] **Step 1: 写失败测试**
```go
package rbac
import "testing"
func TestResourceModule(t *testing.T) {
	if ModuleOf("deployments") != "workloads" { t.Fatal("deployments→workloads") }
	if ModuleOf("services") != "networking" { t.Fatal("services→networking") }
	if ModuleOf("secrets") != "storage" { t.Fatal("secrets→storage") }
	if ModuleOf("persistentvolumes") != "storage" { t.Fatal("pv→storage") }
	if ModuleOf("nodes") != "nodes" { t.Fatal("nodes→nodes") }
}
func TestActionApplies(t *testing.T) {
	if !ResourceActionApplies("pods", "exec") { t.Fatal("pods exec applies") }
	if ResourceActionApplies("services", "exec") { t.Fatal("services exec n/a") }
	if !ResourceActionApplies("secrets", "reveal") { t.Fatal("secrets reveal applies") }
	if ResourceActionApplies("deployments", "reveal") { t.Fatal("deploy reveal n/a") }
	if !ResourceActionApplies("deployments", "create") { t.Fatal("create applies") }
}
func TestValidResourceAction(t *testing.T) {
	if !IsValidResource("deployments") { t.Fatal("deployments valid") }
	if IsValidResource("bogus") { t.Fatal("bogus invalid") }
	if !IsValidResourceAction("view") || !IsValidResourceAction("exec") { t.Fatal("actions valid") }
}
func TestGlobalAreas(t *testing.T) {
	if !IsValidGlobalArea("clusters") || !IsValidGlobalArea("releases") { t.Fatal("areas") }
	if IsValidGlobalArea("bogus") { t.Fatal("bogus area") }
}
```

- [ ] **Step 2: 运行确认失败** — `go test ./internal/rbac/ -run 'TestResourceModule|TestActionApplies|TestValidResourceAction|TestGlobalAreas' -v` → undefined。

- [ ] **Step 3: 实现**（追加到 resources.go；保留既有 resourceGroups/aggregatableReads 供 resMatch 与受控只读用）
```go
// 模块(一级菜单) → 其子菜单(具体资源)，顺序固定，驱动前端树与 nav 校验。
var moduleResources = map[string][]string{
	"workloads": {"deployments", "statefulsets", "daemonsets", "pods", "jobs", "cronjobs"},
	"networking": {"services", "ingresses"},
	"storage":   {"configmaps", "secrets", "persistentvolumeclaims", "persistentvolumes"},
	"nodes":     {"nodes"},
}
var resourceModule = func() map[string]string {
	m := map[string]string{}
	for mod, rs := range moduleResources {
		for _, r := range rs { m[r] = mod }
	}
	return m
}()
// AllResources 所有可授权的资源子菜单（用于 admin 全量、校验）。
var AllResources = func() []string {
	out := []string{}
	for _, rs := range moduleResources { out = append(out, rs...) }
	return out
}()
var validResources = setOf(AllResources...)
var validResourceActions = setOf("view", "create", "edit", "delete", "exec", "reveal")
var validGlobalAreas = setOf("clusters", "users", "roles", "releases")
var validGlobalActions = setOf("view", "create", "edit", "delete")

func ModuleOf(resource string) string { return resourceModule[resource] }
func IsValidResource(r string) bool { return validResources[r] }
func IsValidResourceAction(a string) bool { return validResourceActions[a] }
func IsValidGlobalArea(a string) bool { return validGlobalAreas[a] }
func IsValidGlobalAction(a string) bool { return validGlobalActions[a] }

// ResourceActionApplies 该资源是否适用某动作（exec 仅 pods；reveal 仅 secrets）。
func ResourceActionApplies(resource, action string) bool {
	switch action {
	case "exec":   return resource == "pods"
	case "reveal": return resource == "secrets"
	case "view", "create", "edit", "delete": return validResources[resource]
	}
	return false
}

// actionToCasbin 把树动作映射为 Casbin 动作（view→read，edit→write，其余同名）。
func actionToCasbin(a string) string {
	switch a {
	case "view": return "read"
	case "edit": return "write"
	default: return a // create/delete/exec/reveal
	}
}
```

- [ ] **Step 4: 运行确认通过** — 同上命令 → PASS。
- [ ] **Step 5: Commit** — `git add internal/rbac/resources*.go && git commit -m "feat(rbac): resource→module map + resource/global vocab for permission v3"`

---

## Task 2: 模型字段（model.go）

**Files:** Modify `internal/model/model.go`；`database.Migrate` 已含 Role/RoleRule。

- [ ] **Step 1: 改 Role 增 GlobalPerms**
```go
type Role struct {
	ID, Name, Description, System ...   // 既有
	Pages       string `gorm:"type:text"` // 弃用，保留列忽略
	GlobalPerms string `gorm:"type:text" json:"-"` // JSON: {"clusters":["view",...],"users":[...],"roles":[...],"releases":["view"]}
	// 时间戳...
}
```
`RoleRule.Operations` 列不变（内容语义变 per-resource，无需 migration）。

- [ ] **Step 2: 编译** — `go build ./internal/model/` → OK。
- [ ] **Step 3: Commit** — `git add internal/model/model.go && git commit -m "feat(model): Role.GlobalPerms for permission v3"`

---

## Task 3: 按资源物化 SyncUserGrants（rbac/service.go）

**Files:** Modify `internal/rbac/service.go`；Test `internal/rbac/role_sync_test.go`

物化逻辑：每条 RoleRule 的 `Operations`(map[resource][]treeAction) → 对每个 (resource, treeAction) 算 `casbinAction=actionToCasbin`，加 `AddPolicy(synth, "*", resource, casbinAction)`，并对该规则的域 `AddGrant(uid, synth, domain)`。合成角色签名仍按 operations 规范化。

- [ ] **Step 1: 写失败测试**（用内存 sqlite + 真实 Service）
```go
func TestSyncUserGrants_PerResource(t *testing.T) {
	s, db := newTestService(t) // 既有 helper：建 enforcer+service
	u := seedUser(t, db, "alice")
	// 角色：cluster_f 整集群，deployments view+create，pods view+exec
	role := model.Role{Name: "r1"}; db.Create(&role)
	db.Create(&model.RoleRule{RoleID: role.ID, ClusterID: "cluster_f", Scope: "cluster",
		Operations: `{"deployments":["view","create"],"pods":["view","exec"]}`})
	db.Create(&model.UserRole{UserID: u.ID, RoleID: role.ID})
	if err := s.SyncUserGrants(u.ID); err != nil { t.Fatal(err) }
	sid := strconv.FormatUint(uint64(u.ID),10)
	chk := func(res, act string, want bool){
		ok,_,_ := s.Authorize(sid, "cluster_f", "", res, act)
		if ok != want { t.Fatalf("%s/%s want %v", res, act, want) }
	}
	chk("deployments","read",true); chk("deployments","create",true)
	chk("deployments","write",false); chk("deployments","delete",false)
	chk("pods","read",true); chk("pods","exec",true); chk("pods","write",false)
	chk("services","read",false) // 未授予的资源
}
```

- [ ] **Step 2: 运行确认失败** — 当前 Sync 按 group 物化，断言失败。

- [ ] **Step 3: 改 SyncUserGrants 内层**（把「按 group 遍历」改成「按 resource 遍历」）
```go
// 解析 rule.Operations 为 map[string][]string(resource→tree actions)
ops := parseOps(rule.Operations) // 既有 JSON 解析 helper
for resource, treeActs := range ops {
	for _, ta := range treeActs {
		ca := actionToCasbin(ta)
		s.enforcer.AddPolicy(synth, "*", resource, ca) // 幂等
	}
}
// 域展开与 AddGrant 不变（cluster/namespace，支持 "*"）
```
合成角色签名 `canonicalSignature(ops)` 仍基于 operations（resource+action 排序）。

- [ ] **Step 4: 运行确认通过** — PASS。
- [ ] **Step 5: Commit** — `git add internal/rbac/service.go internal/rbac/role_sync_test.go && git commit -m "feat(rbac): materialize grants per concrete resource"`

---

## Task 4: 全局权限聚合 UserGlobalPerms（rbac/service.go）

**Files:** Modify `internal/rbac/service.go`；Test `internal/rbac/global_test.go`

- [ ] **Step 1: 写失败测试**
```go
func TestUserGlobalPerms_Union(t *testing.T) {
	s, db := newTestService(t)
	u := seedUser(t, db, "bob")
	r1 := model.Role{Name:"a", GlobalPerms:`{"users":["view"],"releases":["view"]}`}; db.Create(&r1)
	r2 := model.Role{Name:"b", GlobalPerms:`{"users":["view","create"],"roles":["view"]}`}; db.Create(&r2)
	db.Create(&model.UserRole{UserID:u.ID, RoleID:r1.ID})
	db.Create(&model.UserRole{UserID:u.ID, RoleID:r2.ID})
	g, err := s.UserGlobalPerms(u.ID); if err != nil { t.Fatal(err) }
	if !g["users"]["view"] || !g["users"]["create"] { t.Fatal("users union") }
	if !g["roles"]["view"] { t.Fatal("roles") }
	if !g["releases"]["view"] { t.Fatal("releases") }
	if g["clusters"]["view"] { t.Fatal("clusters none") }
}
```

- [ ] **Step 2: 运行确认失败** → undefined。

- [ ] **Step 3: 实现**
```go
// UserGlobalPerms 返回用户所有角色 GlobalPerms 的并集。area→action集合。
func (s *Service) UserGlobalPerms(userID uint) (map[string]map[string]bool, error) {
	var raws []string
	q := s.db.Table("ok_roles AS r").
		Joins("JOIN ok_user_roles ur ON ur.role_id = r.id").
		Where("ur.user_id = ?", userID).Pluck("r.global_perms", &raws)
	if q.Error != nil { return nil, q.Error }
	out := map[string]map[string]bool{}
	for _, raw := range raws {
		if raw == "" { continue }
		var m map[string][]string
		if json.Unmarshal([]byte(raw), &m) != nil { continue }
		for area, acts := range m {
			if !IsValidGlobalArea(area) { continue }
			if out[area] == nil { out[area] = map[string]bool{} }
			for _, a := range acts { if IsValidGlobalAction(a) { out[area][a] = true } }
		}
	}
	return out, nil
}
// AllGlobalPerms 超管全开（每 area 全动作；releases 仅 view）。
func AllGlobalPerms() map[string][]string {
	full := []string{"view","create","edit","delete"}
	return map[string][]string{"clusters":full,"users":full,"roles":full,"releases":{"view"}}
}
```
（service.go 顶部确保 import "encoding/json"。）

- [ ] **Step 4: 运行确认通过** → PASS。
- [ ] **Step 5: Commit** — `git add internal/rbac/service.go internal/rbac/global_test.go && git commit -m "feat(rbac): UserGlobalPerms union + AllGlobalPerms"`

---

## Task 5: 资源子菜单并集（rbac/operations.go）

**Files:** Modify `internal/rbac/operations.go`；Test `internal/rbac/nav_test.go`

- [ ] **Step 1: 写失败测试**
```go
func TestVisibleSubmenus(t *testing.T) {
	// 两条规则：cluster_f deployments view; cluster_g secrets view+reveal(无 view? 这里给 view)
	ops := []string{
		`{"deployments":["view"],"pods":["exec"]}`,   // pods 只有 exec, 无 view → 不算可见子菜单
		`{"secrets":["view","reveal"]}`,
	}
	got := VisibleSubmenus(ops)
	want := map[string]bool{"deployments":true, "secrets":true}
	if len(got) != 2 || !contains(got,"deployments") || !contains(got,"secrets") { t.Fatalf("got %v", got) }
	if contains(got,"pods") { t.Fatal("pods has no view → not visible") }
}
```

- [ ] **Step 2: 运行确认失败** → undefined。

- [ ] **Step 3: 实现**
```go
// VisibleSubmenus：传入用户所有 RoleRule 的 operations JSON 串，返回有 "view" 的资源子菜单并集(排序)。
func VisibleSubmenus(opsRaws []string) []string {
	set := map[string]bool{}
	for _, raw := range opsRaws {
		if raw == "" { continue }
		var m map[string][]string
		if json.Unmarshal([]byte(raw), &m) != nil { continue }
		for res, acts := range m {
			if !IsValidResource(res) { continue }
			for _, a := range acts { if a == "view" { set[res] = true } }
		}
	}
	out := make([]string, 0, len(set))
	for r := range set { out = append(out, r) }
	sort.Strings(out)
	return out
}
```
（确保 import "encoding/json","sort"。）

- [ ] **Step 4: 运行确认通过** → PASS。
- [ ] **Step 5: Commit** — `git add internal/rbac/operations.go internal/rbac/nav_test.go && git commit -m "feat(rbac): VisibleSubmenus (resource view union for nav)"`

---

## Task 6: capabilities 按具体资源（rbac/capabilities.go）

**Files:** Modify `internal/rbac/capabilities.go`；Test 既有 capabilities 测试更新。

- [ ] **Step 1: 改 groupProbe → resourceProbe**（每个具体资源探测其适用动作）
```go
// 用每个资源 + 其适用动作探测；返回 map[resource][]treeAction(已允许)。
func (s *Service) Capabilities(userID, clusterID, namespace string) map[string][]string {
	out := map[string][]string{}
	for _, res := range AllResources {
		allowed := []string{}
		for _, ta := range []string{"view","create","edit","delete","exec","reveal"} {
			if !ResourceActionApplies(res, ta) { continue }
			ok,_,err := s.Authorize(userID, clusterID, namespace, res, actionToCasbin(ta))
			if err==nil && ok { allowed = append(allowed, ta) }
		}
		out[res] = allowed
	}
	return out
}
// AllCapabilities：每资源其全部适用动作（admin）。
func AllCapabilities() map[string][]string {
	out := map[string][]string{}
	for _, res := range AllResources {
		acts := []string{}
		for _, ta := range []string{"view","create","edit","delete","exec","reveal"} {
			if ResourceActionApplies(res, ta) { acts = append(acts, ta) }
		}
		out[res] = acts
	}
	return out
}
```

- [ ] **Step 2: 写/改测试**
```go
func TestCapabilities_PerResource(t *testing.T) {
	s, db := newTestService(t)
	u := seedUser(t, db, "cap")
	role := model.Role{Name:"c"}; db.Create(&role)
	db.Create(&model.RoleRule{RoleID:role.ID, ClusterID:"cluster_f", Scope:"cluster",
		Operations:`{"pods":["view","exec"]}`})
	db.Create(&model.UserRole{UserID:u.ID, RoleID:role.ID})
	s.SyncUserGrants(u.ID)
	sid := strconv.FormatUint(uint64(u.ID),10)
	caps := s.Capabilities(sid, "cluster_f", "")
	if !contains(caps["pods"],"view") || !contains(caps["pods"],"exec") { t.Fatalf("pods %v", caps["pods"]) }
	if contains(caps["pods"],"edit") { t.Fatal("no edit") }
	if len(caps["deployments"]) != 0 { t.Fatal("deployments none") }
}
```

- [ ] **Step 3: 运行确认通过** — `go test ./internal/rbac/ -race` → PASS。
- [ ] **Step 4: Commit** — `git add internal/rbac/capabilities.go internal/rbac/*_test.go && git commit -m "feat(rbac): capabilities per concrete resource"`

---

## Task 7: RequireGlobalPerm 中间件（middleware/globalperm.go）

**Files:** Create `internal/middleware/globalperm.go`；Test `internal/middleware/globalperm_test.go`

- [ ] **Step 1: 写失败测试**（httptest + gin，注入 is_admin / user_id；用一个最小 GlobalPermChecker 接口）
```go
func TestRequireGlobalPerm(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// fake checker: 用户 7 在 users 有 view,create
	chk := func(uid uint, area, action string) bool {
		return uid==7 && area=="users" && (action=="view"||action=="create")
	}
	run := func(uid uint, isAdmin bool, area, action string) int {
		r := gin.New()
		r.GET("/x", func(c *gin.Context){ c.Set("user_id", uid); c.Set("is_admin", isAdmin); c.Next() },
			RequireGlobalPerm(chk, area, action), func(c *gin.Context){ c.Status(200) })
		w := httptest.NewRecorder(); req,_ := http.NewRequest("GET","/x",nil); r.ServeHTTP(w,req); return w.Code
	}
	if run(7,false,"users","view") != 200 { t.Fatal("user view ok") }
	if run(7,false,"users","delete") != 403 { t.Fatal("user delete 403") }
	if run(9,false,"users","view") != 403 { t.Fatal("other 403") }
	if run(9,true,"users","delete") != 200 { t.Fatal("admin bypass") }
}
```

- [ ] **Step 2: 运行确认失败** → undefined。

- [ ] **Step 3: 实现**
```go
package middleware
import ("net/http"; "github.com/gin-gonic/gin")
// GlobalPermFunc 判断用户对某全局区域是否有某动作。
type GlobalPermFunc func(userID uint, area, action string) bool
// RequireGlobalPerm: admin 旁路；否则按 GlobalPermFunc 校验。
func RequireGlobalPerm(check GlobalPermFunc, area, action string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetBool("is_admin") { c.Next(); return }
		uid, _ := c.Get("user_id")
		id, _ := uid.(uint)
		if check(id, area, action) { c.Next(); return }
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code":403,"message":"无该操作权限"})
	}
}
```

- [ ] **Step 4: 运行确认通过** → PASS。
- [ ] **Step 5: Commit** — `git add internal/middleware/globalperm.go internal/middleware/globalperm_test.go && git commit -m "feat(middleware): RequireGlobalPerm"`

---

## Task 8: 路由改造（router.go）+ Handler 注入 checker

**Files:** Modify `internal/router/router.go`、`internal/handler/handler.go`(若需暴露 check)

- [ ] **Step 1: 在 Handler 上加 global-perm 闭包**
`handler.Handler` 已持 `RBAC *rbac.Service`。新增方法：
```go
// GlobalPermCheck 供路由中间件用：admin 在中间件已旁路；此处仅普通用户。
func (h *Handler) GlobalPermCheck(userID uint, area, action string) bool {
	perms, err := h.RBAC.UserGlobalPerms(userID)
	if err != nil { return false }
	return perms[area][action]
}
```

- [ ] **Step 2: 改路由**（去掉 clusters/users/roles 组上的 `RequireAdmin`，换成 per-端点 `RequireGlobalPerm`；`/releases` 同理）
```go
// 集群管理（注意 /my/clusters 不在此组）
clusters := authed.Group("/clusters")
clusters.GET("",  middleware.RequireGlobalPerm(h.GlobalPermCheck,"clusters","view"),   h.ListClusters)
clusters.POST("", middleware.RequireGlobalPerm(h.GlobalPermCheck,"clusters","create"), h.CreateCluster)
clusters.PUT("/:id",    middleware.RequireGlobalPerm(h.GlobalPermCheck,"clusters","edit"),   h.UpdateCluster)
clusters.DELETE("/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck,"clusters","delete"), h.DeleteCluster)
clusters.POST("/test",  middleware.RequireGlobalPerm(h.GlobalPermCheck,"clusters","create"), h.TestCluster)
// 用户管理 users:view/create/edit/delete（list=view, create=create, disable/enable/setRoles=edit, delete=delete）
// 角色管理 roles:view/create/edit/delete
// 发布记录
authed.GET("/releases", middleware.RequireGlobalPerm(h.GlobalPermCheck,"releases","view"), h.ListReleases)
```
为每个端点选合适 (area,action)：users 的 disable/enable/`:id/roles`→edit；roles 的 create/update/delete 对应；ListReleases→releases view。删除原 `RequireGlobalPerm` 前的 `RequireAdmin` 用法（保留 `RequireAdmin` 定义不动，仅此处不用）。

- [ ] **Step 3: 编译 + 全量测试**
Run: `go build ./... && go test ./internal/handler/ -race -count=1`
Expected: 既有 handler 测试中「非 admin 403」的断言可能需调整为「无对应 global 权限 → 403」。更新这些用例（user/role/cluster handler 测试里 `adminApp` 用 admin token，仍 200；新增「普通用户带 users:view 角色」可访问的用例）。

- [ ] **Step 4: Commit** — `git add internal/router/router.go internal/handler/handler.go internal/handler/*_test.go && git commit -m "feat: gate system endpoints by global perms (replace RequireAdmin)"`

---

## Task 9: /me 返回 nav + global（handler/auth.go）

**Files:** Modify `internal/handler/auth.go`；Test `internal/handler/auth_test.go`

- [ ] **Step 1: 改 Me + 删 effectivePages，新增 nav/global**
```go
func (h *Handler) Me(c *gin.Context) {
	userID := c.MustGet("user_id").(uint)
	var user model.User
	if err := h.DB.First(&user, userID).Error; err != nil { c.JSON(401, gin.H{"code":401,"message":"用户不存在"}); return }
	nav, global := h.navAndGlobal(user)
	c.JSON(200, gin.H{"id":user.ID,"username":user.Username,"is_admin":user.IsAdmin,"must_reset":user.MustReset,
		"nav": gin.H{"submenus": nav}, "global": global})
}
// navAndGlobal: admin→全部资源子菜单 + AllGlobalPerms；否则 VisibleSubmenus(其角色 operations) + UserGlobalPerms。
func (h *Handler) navAndGlobal(user model.User) ([]string, map[string][]string) {
	if user.IsAdmin {
		subs := make([]string, len(rbac.AllResources)); copy(subs, rbac.AllResources); sort.Strings(subs)
		return subs, rbac.AllGlobalPerms()
	}
	var opsRaws []string
	h.DB.Table("ok_role_rules AS rr").Joins("JOIN ok_user_roles ur ON ur.role_id=rr.role_id").
		Where("ur.user_id=?", user.ID).Pluck("rr.operations", &opsRaws)
	subs := rbac.VisibleSubmenus(opsRaws)
	gp, _ := h.RBAC.UserGlobalPerms(user.ID)
	global := map[string][]string{}
	for area, set := range gp { for a := range set { global[area] = append(global[area], a) }; sort.Strings(global[area]) }
	return subs, global
}
```
删除旧 `effectivePages`/`PagesFromOperations` 调用与 `pages` 字段。

- [ ] **Step 2: /me/capabilities 改用资源版**（已在 Task 6 改 Service；handler 这里 admin→`rbac.AllCapabilities()`，否则 `h.RBAC.Capabilities(...)`，返回 `{"resources": <map>}`）。

- [ ] **Step 3: 改测试**（auth_test.go：admin nav.submenus 含全部 AllResources、global 全开；某 workloads-only 角色 → nav.submenus 仅含有 view 的工作负载资源；含 users:view 的角色 → global.users 含 view）。删除依赖旧 `pages` 的断言。

- [ ] **Step 4: 运行** — `go test ./internal/handler/ -race -count=1` → PASS。
- [ ] **Step 5: Commit** — `git add internal/handler/auth.go internal/handler/auth_test.go && git commit -m "feat(auth): /me returns nav(submenus)+global perms; capabilities per resource"`

---

## Task 10: 角色创建/更新接受新结构（handler/role.go）

**Files:** Modify `internal/handler/role.go`；Test `internal/handler/role_test.go`

- [ ] **Step 1: 改入参/视图**
```go
type roleRuleReq struct {
	ClusterID string `json:"cluster_id"`; Scope string `json:"scope"`; Namespaces []string `json:"namespaces"`
	Operations map[string][]string `json:"operations"` // resource → tree actions
}
type roleReq struct {
	Name string `json:"name" binding:"required"`; Description string `json:"description"`
	GlobalPerms map[string][]string `json:"global_perms"` // area → actions
	Rules []roleRuleReq `json:"rules"`
}
```
校验 `validateRules`：每 rule 的 operations key 必须 `IsValidResource`，action 必须 `ResourceActionApplies(resource, action)`；scope/cluster 校验不变。`global_perms` 用 `sanitizeGlobalPerms`(仅合法 area+action) 后 `json.Marshal` 存 `Role.GlobalPerms`。视图 `roleView` 增 `global_perms map[string][]string`、rules.operations 回显。

- [ ] **Step 2: 写/改测试**（创建角色带 operations per-resource + global_perms；非法资源/动作 400；echo global_perms；System 角色 PUT 仍 403）。

- [ ] **Step 3: 运行** — `go test ./internal/handler/ -race -count=1` → PASS。
- [ ] **Step 4: Commit** — `git add internal/handler/role.go internal/handler/role_test.go && git commit -m "feat(role): accept per-resource operations + global_perms"`

---

## Task 11: 预设角色按新模型重建（rbac/service.go seedPresetRoles）

**Files:** Modify `internal/rbac/service.go`；Test `internal/rbac/service_test.go`

- [ ] **Step 1: 改 seedPresetRoles**
- 集群管理员：rule{cluster:"*",scope:cluster, operations=每个 AllResources 的全部适用动作}；GlobalPerms=`AllGlobalPerms()`。
- 集群只读：rule{cluster:"*",scope:cluster, operations=每个 AllResources 仅 ["view"]}；GlobalPerms=`{"releases":["view"]}`。
```go
adminOps := map[string][]string{}
viewOps := map[string][]string{}
for _, res := range AllResources {
	acts := []string{}
	for _, ta := range []string{"view","create","edit","delete","exec","reveal"} {
		if ResourceActionApplies(res, ta) { acts = append(acts, ta) }
	}
	adminOps[res] = acts
	viewOps[res] = []string{"view"}
}
```
GlobalPerms 字段一并 seed。System=true。

- [ ] **Step 2: 改测试**（断言两预设存在、System；集群管理员 operations 覆盖 deployments 全动作、GlobalPerms 全；集群只读 viewOps）。

- [ ] **Step 3: 全量** — `go build ./... && go vet ./... && go test ./... -race -count=1` → 全绿。

- [ ] **Step 4: Commit** — `git add internal/rbac/service.go internal/rbac/service_test.go && git commit -m "feat(rbac): rebuild preset roles for permission v3"`

---

## Task 12: 端到端手动验证（需 PostgreSQL + 重建角色表）

- [ ] **Step 1: 重建角色相关表 + 重启**（dev 库 schema 兼容，但预设需重新种子）
```bash
docker exec omnikube-pg psql -U omnikube -d omnikube -c \
 "DELETE FROM ok_user_roles WHERE role_id IN (SELECT id FROM ok_roles WHERE system=true); \
  DELETE FROM ok_role_rules WHERE role_id IN (SELECT id FROM ok_roles WHERE system=true); \
  DELETE FROM ok_roles WHERE system=true;"
cd backend && go run ./cmd/server -config config.yaml &
```
> 注意：非系统角色若用旧 group 格式 operations，会被新校验/物化忽略——dev 阶段可清空自定义角色重建。

- [ ] **Step 2: 验证（admin token）**
```bash
TOK=$(curl -s -X POST localhost:8080/api/v1/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"NewStrongPw123"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s localhost:8080/api/v1/me -H "Authorization: Bearer $TOK" | python3 -m json.tool   # nav.submenus 全 + global 全开
curl -s 'localhost:8080/api/v1/me/capabilities?namespace=default' -H "Authorization: Bearer $TOK" -H 'X-Cluster-ID: test'  # resources map
curl -s localhost:8080/api/v1/roles -H "Authorization: Bearer $TOK" | python3 -m json.tool  # 预设 operations per-resource + global_perms
```
- [ ] **Step 3: 验证系统端点门控**：建一个仅 `users:["view"]` 的角色绑普通用户 → 该用户 `GET /users` 200、`DELETE /users/:id` 403、`GET /roles` 403。

---

## 自检（Spec 覆盖）
| Spec | 任务 |
|---|---|
| 全局权限模型(GlobalPerms) | Task 2,4,10,11 |
| 每集群 per-resource operations | Task 1,2,3,10 |
| 按资源 Casbin 物化 | Task 3 |
| 系统端点 RequireGlobalPerm 替换 RequireAdmin | Task 7,8 |
| /me nav(submenus)+global | Task 9 |
| capabilities 按资源 | Task 6 |
| 预设重建 | Task 11 |
| 资源→模块映射/词表 | Task 1 |
| 端到端验证 | Task 12 |

**不在本计划**（Part B 前端独立计划）：角色编辑器树/70%/一键复用、侧边栏+路由按 nav、capabilities 按资源前端门控、系统管理菜单改造。
