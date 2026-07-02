# OmniKube 子项目 C：Casbin 权限系统与权限指派中心 — 设计文档

> 日期：2026-06-29
> 来源 PRD：`PRD/v2.md` §4（权限模型）、§5.2（权限指派中心）、§5.4（级联清理）、§3.4（审计）
> 依赖：A（已完成）、B（已完成）。复用 `model`、`database`、`crypto`、`cluster.ClusterPool`、`middleware.JWTAuth/RequireAdmin`、`casbin_rule` 表。

## 1. 范围

构建完整的 **RBAC with Domains** 权限引擎 + **权限指派中心**（admin 专属）+ **级联清理** + **审计日志**。

**本 spec 覆盖**：
1. Casbin enforcer（model.conf + gorm-adapter 挂到既有 `casbin_rule` 表）+ 自定义 `domMatch`/`resMatch` 匹配函数。
2. 四种预设角色 `p` 策略 + 资源组映射的种子化。
3. 权限服务 `rbac.Service`：`Authorize`（含 PRD §7 受控集群级只读白名单）、`ListVisibleNamespaces`。
4. 用户管理 API（创建/列表/禁用/删除普通用户）。
5. 授权矩阵 API（写 `g` 绑定，不写 `p`）。
6. 级联清理：删集群清该集群所有 `g` 绑定（接回 B 的 `DeleteCluster` TODO）；删用户清其所有 `g`。
7. 审计助手 `audit.Log` 写 `ok_audit_logs`。

**不在本 spec**（留给 D/E）：
- 资源看板路由与挂在其上的 RBAC gin 中间件（`parseK8sResource`/`resolveAuthNamespace`/下发前覆盖 namespace）——D 实现，消费本 spec 的 `rbac.Service.Authorize` 与 `audit.Log`。
- WebSocket exec/日志流鉴权（E）。

## 2. Casbin 模型（核心，务必精确）

### 2.1 model.conf（`internal/rbac/model.conf`，用 `go:embed` 内联）

```ini
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && resMatch(r.obj, p.obj) && (r.act == p.act || p.act == "*")
```

> 说明：PRD §4.1 的 `keyMatch(r.dom, p.dom)` 因所有 `p` 的 `dom` 恒为 `*`（恒真）而省略；**域隔离完全由 `g` 的域匹配函数 `domMatch` 负责**（见 2.2），这是修正 PRD 朴素读法下「Cluster-Admin 绑定 `cluster_f` 却命不中 `cluster_f:ns` 请求」缺陷的关键。

### 2.2 自定义域匹配函数 `domMatch`（注册到 g）

```go
// 通过 enforcer.AddNamedDomainMatchingFunc("g", "domMatch", domMatch) 注册。
// reqDom = 请求域, polDom = g 绑定里存的域。
func domMatch(reqDom, polDom string) bool {
    if reqDom == polDom {
        return true
    }
    // 集群级绑定(无冒号)覆盖该集群下所有命名空间域 "clusterID:ns"
    if !strings.Contains(polDom, ":") {
        return strings.HasPrefix(reqDom, polDom+":")
    }
    return false // NS 级绑定只精确匹配，绝不向上覆盖集群级或旁路其他 NS
}
```

**域格式约定**：集群级域 = `clusterID`（如 `cluster_f`）；命名空间级域 = `clusterID:ns`（如 `cluster_f:dev`）。请求域由调用方（D 的中间件）按 PRD §7 构造：`namespace==""` 时为 `clusterID`，否则 `clusterID:namespace`。

**正确性断言（必须有单测覆盖）**：
- Cluster-Admin 绑定 `cluster_f` → 命中 `cluster_f`（集群级资源）与 `cluster_f:dev`（任意 NS）。
- NS-Viewer 绑定 `cluster_g:test-ns` → 命中 `cluster_g:test-ns`；**不**命中 `cluster_g:dev-ns`、**不**命中 `cluster_g`（集群级）。
- 跨集群不串：绑定 `cluster_f` 不命中 `cluster_g*`；前缀不串：`cluster_f` 不命中 `cluster_foo`（要求冒号分隔）。

### 2.3 自定义资源匹配函数 `resMatch`（注册到 m）

```go
// reqObj = 具体资源(如 "pods"), polObj = 策略里的资源或资源组(如 "workloads"/"*")。
func resMatch(reqObj, polObj string) bool {
    if polObj == "*" || polObj == reqObj {
        return true
    }
    set, ok := resourceGroups[polObj]
    return ok && set[reqObj]
}
```

资源组（`internal/rbac/resources.go`，可配置化的 map）：

| 组 | 成员 |
|---|---|
| `workloads` | deployments, statefulsets, daemonsets, pods, jobs, replicasets |
| `network` | services, ingresses, endpoints |
| `config` | configmaps, secrets, persistentvolumeclaims |
| `cluster` | nodes, persistentvolumes, namespaces, customresourcedefinitions |

### 2.4 预设角色 `p` 策略（启动时幂等种子化）

| 角色 | p 策略 (sub, dom, obj, act) |
|---|---|
| Cluster-Admin | `(Cluster-Admin, *, *, *)` |
| Cluster-Viewer | `(Cluster-Viewer, *, *, read)` |
| NS-Editor | `(NS-Editor, *, *, read)`、`(*, workloads, write)`、`(*, network, write)`、`(*, config, write)`、`(*, config, reveal)`、`(*, pods, exec)` |
| NS-Viewer | `(NS-Viewer, *, *, read)` |

> NS-Editor 显式加 `*,*,read`（PRD 表未列但编辑者必须能读）。`reveal`/`exec` 为独立动作，不被 `write` 覆盖（PRD §4.3）。种子化用 `AddPolicy` 幂等（已存在则跳过）。

### 2.5 动作（act）

`read`(GET) / `write`(POST/PUT/PATCH/DELETE) / `exec`(WebSSH) / `reveal`(Secret 揭示)。act 由调用方解析后传入 `Authorize`。

## 3. 权限服务 `internal/rbac/service.go`

```go
type Service struct {
    enforcer *casbin.Enforcer
    pool     *cluster.ClusterPool // 供 ListVisibleNamespaces 列全部 NS
}

func NewService(db *gorm.DB, pool *cluster.ClusterPool) (*Service, error) // 建 adapter+enforcer, 注册函数, 种子角色

// Authorize 实现 PRD §7 的鉴权裁决(不含 namespace 解析, 那在 D)。
// 返回 (allowed, visibleNS, err)。
//   - 正常 Enforce(userID, domain, resource, action) 命中 → (true, nil, nil)
//   - 未命中但满足「受控集群级只读」: isClusterScope(namespace) && action=="read"
//     && isAggregatableRead(resource) && len(visibleNS)>0 → (true, visibleNS, nil)
//   - 否则 (false, nil, nil)
func (s *Service) Authorize(userID, clusterID, namespace, resource, action string) (bool, []string, error)

// ListVisibleNamespaces: 用户在该集群有集群级角色 → 返回该集群全部 NS(经 pool 列举);
// 否则解析其 g 绑定中 domain 形如 "clusterID:ns" 的 ns 集合。
func (s *Service) ListVisibleNamespaces(userID, clusterID string) ([]string, error)

// 角色绑定读写 (供指派 API):
func (s *Service) AddGrant(userID, role, domain string) error
func (s *Service) RemoveGrant(userID, role, domain string) error
func (s *Service) ListGrants(userID string) ([]Grant, error) // Grant{Role, ClusterID, Namespace}

// 级联清理:
func (s *Service) RemoveClusterPolicies(clusterID string) error // 删所有 domain 命中该集群的 g
func (s *Service) RemoveUserGrants(userID string) error         // 删 v0==userID 的 g
```

`isAggregatableRead` 白名单（可聚合的集群级只读资源）：`pods, deployments, statefulsets, daemonsets, jobs, replicasets, services, ingresses, configmaps, secrets, persistentvolumeclaims`（即可按 NS 聚合的命名空间型资源；`nodes/pv/crd` 等真集群级资源不在内）。`isClusterScope(ns)` = `ns==""`。

## 4. API（全部 JWTAuth + RequireAdmin）

### 4.1 用户管理 `internal/handler/user.go`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/users` | 建普通用户 `{username}`；生成随机临时密码，`MustReset=true`，**密码在响应里返回一次**（admin 转交）|
| GET | `/api/v1/users` | 列表（不含密码哈希）|
| PUT | `/api/v1/users/:id/disable` | 置 `Disabled=true`（禁用）|
| PUT | `/api/v1/users/:id/enable` | 置 `Disabled=false` |
| DELETE | `/api/v1/users/:id` | 删用户 + `RemoveUserGrants`（事务）|

**模型改动**：`model.User` 增 `Disabled bool gorm:"default:false"`；A 的 `Login` 增加：`Disabled` 用户拒绝登录（401，文案与防枚举一致）。

### 4.2 授权矩阵 `internal/handler/grant.go`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/grants` | body `{user_id, cluster_id, scope:"cluster"|"namespace", namespaces:[], role}` → 写 `g`：cluster 范围 → `g(user, role, clusterID)`；namespace 范围 → 每个 ns 写 `g(user, role, clusterID:ns)` |
| GET | `/api/v1/grants?user_id=` | 列该用户全部绑定（解析 domain 成 cluster/ns）|
| DELETE | `/api/v1/grants` | body `{user_id, role, domain}` → 删一条绑定 |

**校验**：role ∈ 四种预设；scope 与 role 兼容（`Cluster-*` 仅 cluster 范围，`NS-*` 仅 namespace 范围且 namespaces 非空）；cluster_id 必须存在。

## 5. 级联清理接回 B

修改 `cluster.ClusterPool.DeleteCluster`：在删 DB 行的同一事务/紧邻处调用 `rbac.Service.RemoveClusterPolicies(clusterID)`。为避免 `cluster` 包反向依赖 `rbac` 包（循环依赖），采用**回调注入**：`ClusterPool` 增加可选字段 `OnDelete func(clusterID string) error`，main 装配时设为 `rbacSvc.RemoveClusterPolicies`。B 里原 TODO 注释处替换为调用该回调。

## 6. 审计 `internal/audit/audit.go`

```go
type Entry struct{ UserID, ClusterID, Namespace, Resource, Action, Target, Result, SourceIP string }
func Log(db *gorm.DB, e Entry) // 写 ok_audit_logs, 失败仅记 log 不阻断
```

D/E 在鉴权放行/拒绝、reveal、exec 时调用。C 在用户/授权变更时可选记审计（写操作留痕）。

## 7. 测试策略（TDD，内存 sqlite + B 的 fake builder pool）

- **domMatch/resMatch 单测**：覆盖 2.2 / 2.3 所有断言（含反例：NS 角色不命中集群级、跨集群/前缀不串）。
- **enforcer 集成测**：种子角色后，构造 `g` 绑定，断言 `Enforce` 对 (Cluster-Admin/Viewer/NS-Editor/NS-Viewer) × (read/write/exec/reveal) × (本域/邻域/集群级) 的允许/拒绝矩阵正确。
- **Authorize**：受控集群级只读——NS-Viewer 仅在 dev-ns 有绑定，对 `clusterID + ns="" + pods + read` 返回 (true, [dev-ns])；对 `nodes`(非白名单) 返回 (false)。
- **ListVisibleNamespaces**：集群级角色 → 全部 NS（pool 用 fake client 返回若干 ns）；NS 角色 → 仅其绑定 ns。
- **级联**：RemoveClusterPolicies 删干净该集群所有 NS/集群级绑定，不误删他集群；RemoveUserGrants 只删该用户。
- **handler**：用户 CRUD、grant CRUD 的状态码与 casbin_rule 副作用；非 admin 403；禁用用户登录被拒。

## 8. 验收标准

1. `go build ./... && go test ./... -race` 全绿。
2. 鉴权允许/拒绝矩阵单测全过，域隔离断言全过（无跨 NS/跨集群泄露）。
3. 删除集群后该集群相关 `g` 绑定在 `casbin_rule` 中清零；删用户后其 `g` 清零。
4. 禁用用户无法登录。
5. 非 admin 调用用户/授权 API 一律 403。

## 9. 对 A/B 的改动

- `model.User` 增 `Disabled` 字段；`AutoMigrate` 自动加列。
- A 的 `Login` 拒绝 `Disabled` 用户。
- B 的 `ClusterPool` 增 `OnDelete` 回调并在 `DeleteCluster` 调用。
- `main.go`：建 `rbac.NewService(db, pool)`，注入 `pool.OnDelete`，把 `Service` 注入 handler，注册用户/授权路由。
