# OmniKube 子项目 D：K8S 资源看板 API 与 RBAC 中间件 — 设计文档

> 日期：2026-06-29
> 来源 PRD：`PRD/v2.md` §5.3（资源看板）、§7（中间件链 + 三处越权修复）、§4.3（动作）
> 依赖：A、B、C（均已完成）。复用 `cluster.ClusterPool`/`ClusterClient`（Dynamic+RESTMapper）、`rbac.Service`（Authorize/ListVisibleNamespaces）、`audit.Log`、`crypto`、`middleware.JWTAuth`。

## 1. 范围

实现**多租户动态资源流**：用 dynamic client + RESTMapper 做全资源（含 CRD）list/get/create/update/delete，并由 **RBAC gin 中间件**统一鉴权，坐实 PRD §7 的三处越权修复。

**本 spec 覆盖**：
1. `RBACAuthMiddleware`（PRD §7 完整伪代码）：namespace 单一可信来源、受控集群级只读、下发前强制覆盖 body namespace。
2. 通用资源 handler（dynamic + RESTMapper）：list/get/create/update/delete。
3. NS 下拉数据权限：`GET /api/v1/namespaces`（按可见 NS 过滤）。
4. Secret 揭示：`POST .../secrets/:name/reveal`（`reveal` 动作 + 强制审计）。
5. 资源路由注册（`X-Cluster-ID` 头驱动）。

**不在本 spec**（留给 E）：实时日志流、WebSSH（WebSocket，§8）。

## 2. 路由与 namespace 单一可信来源（PRD 修复 #1）

为让「鉴权用的 namespace」与「下发 K8S 的 namespace」严格同源，路由按是否带 `:namespace` 路径段区分：

| 操作 | 方法 + 路由 | namespace 来源 | action |
|---|---|---|---|
| 列表(命名空间型) | GET `/api/v1/resources/:resource?namespace=ns` | **query**（可空=集群级聚合）| read |
| 列表(集群型) | GET `/api/v1/resources/:resource` | 无(`""`) | read |
| 详情 | GET `/api/v1/namespaces/:namespace/resources/:resource/:name` | **path** | read |
| 创建 | POST `/api/v1/namespaces/:namespace/resources/:resource` | **path** | write |
| 更新 | PUT `/api/v1/namespaces/:namespace/resources/:resource/:name` | **path** | write |
| 删除 | DELETE `/api/v1/namespaces/:namespace/resources/:resource/:name` | **path** | write |
| 集群型写 | POST/PUT/DELETE `/api/v1/resources/:resource[/:name]` | 无(`""`) | write |
| NS 下拉 | GET `/api/v1/namespaces` | — | （特殊，见 §5）|
| Secret 揭示 | POST `/api/v1/namespaces/:namespace/resources/secrets/:name/reveal` | path | reveal |

> **关键**：写操作的 namespace 只认 path 段 `:namespace`，**绝不读 query 或 body**。`resolveAuthNamespace` 是唯一裁决点，把结果写入 `c.Set("auth_namespace", ns)`；handler 下发前用它**强制覆盖** `obj.metadata.namespace`，封堵 `path=A` + `body=B` 的参数混淆越权。

集群 ID 始终来自 `X-Cluster-ID` 头（WS 在 E 用 query）。

## 3. `internal/middleware/rbac.go` — RBACAuthMiddleware

落 PRD §7 伪代码，挂在 `JWTAuth` 之后：

```
userID := ctx user_id
if IsSystemAdmin(userID) { c.Next(); return }     // 系统管理员(model.User.IsAdmin)旁路
clusterID := X-Cluster-ID; 校验存在(pool 有该 client) 否则 400
resource := parseK8sResource(c)                    // 取 :resource 路径段, 解析为规范资源名
namespaced := isNamespaced(clusterID, resource)    // 经 RESTMapper 判定
namespace := resolveAuthNamespace(c, namespaced)   // 唯一裁决点(见 §2)
c.Set("auth_namespace", namespace); c.Set("auth_resource", resource)
action := parseAction(c)                            // GET→read; POST/PUT/PATCH/DELETE→write
domain := clusterID; if namespace != "" { domain = clusterID+":"+namespace }
allowed, visibleNS, _ := rbac.Authorize(userID, clusterID, namespace, resource, action)
if !allowed {
    audit deny; abort 403
}
if visibleNS != nil { c.Set("visible_ns", visibleNS) }  // 受控集群级只读, handler 必须据此过滤
if action == "write" { audit allow }
c.Next()
```

- `parseK8sResource`：取 `:resource`，小写化；交给 RESTMapper 校验为已知资源（未知 → 400）。
- `parseAction`：方法映射；`reveal` 不走此中间件的通用映射（reveal 路由单独处理，见 §6）。
- `isNamespaced`：`restMapper.RESTMapping(gk)` 的 `Scope.Name()==RESTScopeNameNamespace`。
- `Authorize` 已封装「受控集群级只读白名单 + visibleNS」（C 已实现），中间件只消费其返回值。

## 4. 通用资源 handler `internal/handler/resource.go`

用 `ClusterClient.Dynamic` + `RESTMapper`：

```go
func (h *Handler) ListResource(c)   // resource(+namespace 或 visible_ns 聚合) → dyn.List
func (h *Handler) GetResource(c)    // namespace/name → dyn.Get
func (h *Handler) CreateResource(c) // 解析 body Unstructured; 强制 SetNamespace(auth_namespace); dyn.Create
func (h *Handler) UpdateResource(c) // 强制 SetNamespace(auth_namespace); dyn.Update
func (h *Handler) DeleteResource(c) // dyn.Delete(namespace,name)
```

- **GVR 解析**：`restMapper.ResourceFor(schema.GroupVersionResource{Resource: resource})` → 完整 GVR；`dyn.Resource(gvr)`，命名空间型再 `.Namespace(ns)`。
- **受控集群级只读聚合（PRD 修复 #2）**：List 时若 `auth_namespace==""` 且 ctx 有 `visible_ns`，则**遍历 visibleNS 逐个 list 后合并**，而非全集群 list——NS-Viewer 绝不会看到未授权空间的数据。若无 `visible_ns`（系统 admin 或集群级角色）则正常全量 list。
- **下发前强制覆盖（PRD 修复 #1）**：Create/Update 把 body 解析为 `unstructured.Unstructured` 后，`obj.SetNamespace(auth_namespace)` 再下发，忽略 body 自带的 namespace。
- 错误：K8S 4xx/5xx 透传为合理 HTTP 码 + `{"code","message"}`；NotFound→404。

## 5. NS 下拉数据权限 `GET /api/v1/namespaces`

- 系统 admin 或集群级角色 → 该集群全部 NS。
- 否则 → `rbac.ListVisibleNamespaces(userID, clusterID)` 的结果（用户有任意角色绑定的 NS）。
- 该端点不经通用 RBAC 资源中间件（它本身就是「列出我能看的 NS」），但需 JWTAuth + 有效 `X-Cluster-ID`；直接调用 C 的 `ListVisibleNamespaces`。

## 6. Secret 揭示 `internal/handler/secret.go`

`POST /api/v1/namespaces/:namespace/resources/secrets/:name/reveal`：
- 独立 handler，**显式**以 `action="reveal"` 调 `rbac.Authorize(userID, clusterID, ns, "secrets", "reveal")`（系统 admin 旁路）；不通过通用 write 映射。
- 通过后用 typed/dynamic 取该 Secret，对 `.data` 做 base64 解码返回明文（PRD 注：本质是按 RBAC 门控的明文展示）。
- **每次揭示强制写审计**：`audit.Log{Action:"reveal", Resource:"secrets", Target:"secret/"+name, Result:"allow"}`；拒绝时记 deny。

## 7. 路由装配

```
api/v1 (JWTAuth)
  ├─ GET  /namespaces                                        → ListVisibleNamespaces (需 X-Cluster-ID)
  └─ group(RBACAuthMiddleware):
       GET    /resources/:resource                            → ListResource
       GET    /namespaces/:namespace/resources/:resource/:name→ GetResource
       POST   /namespaces/:namespace/resources/:resource      → CreateResource
       PUT    /namespaces/:namespace/resources/:resource/:name→ UpdateResource
       DELETE /namespaces/:namespace/resources/:resource/:name→ DeleteResource
       POST   /namespaces/:namespace/resources/secrets/:name/reveal → RevealSecret
       (集群型写: POST/PUT/DELETE /resources/:resource[/:name])
```

`X-Cluster-ID` 头由 `RBACAuthMiddleware` 读取并校验。

## 8. 测试策略（TDD，fake dynamic client + fake RESTMapper）

- **middleware/rbac_test.go**：
  - namespace 单一来源：写路由 path=`dev`、query/body 给 `prod` → 鉴权与下发都用 `dev`（断言 `auth_namespace=="dev"`）。
  - 受控集群级只读：NS-Viewer 列 pods（ns 空）→ 放行且 `visible_ns` 注入；列 nodes → 403。
  - 系统 admin 旁路；非法/缺失 X-Cluster-ID → 400；无权 → 403 且 audit deny 落库。
- **handler/resource_test.go**：用 `dynamicfake.NewSimpleDynamicClient(scheme, objs...)` 注入到 pool 的 fake client。
  - List 命名空间过滤、集群级聚合只遍历 visible_ns（断言未授权 ns 的对象不出现）。
  - Create/Update 强制覆盖 namespace（body 写 `prod`、path `dev` → 落到 `dev`）。
  - Get/Delete 正常路径与 NotFound→404。
- **handler/secret_test.go**：reveal 通过返回解码明文且写一条 reveal 审计；无 reveal 权限 → 403 且写 deny 审计。
- **handler 命名空间端点测试**：admin/集群级 → 全部；NS 角色 → 仅可见。
- 为支持 fake，pool 的 `ClusterClient` 已是接口类型；测试构造带 fake `Dynamic` 与一个测试用 `RESTMapper`（可用 `meta.NewDefaultRESTMapper` 注册测试资源 pods/nodes/secrets 的 scope）。

## 9. 验收标准

1. `go build ./... && go test ./... -race` 全绿。
2. 参数混淆越权被封堵：path 与 body/query 的 namespace 不一致时，一律以 path 为准（单测证明）。
3. 跨 NS 泄露被封堵：NS-Viewer 的集群级 read 只返回其可见 NS 的对象。
4. Secret 揭示需 `reveal` 动作且每次落审计。
5. 未知资源/缺 X-Cluster-ID/无权 分别 400/400/403。
6. 真实集群手动验证（可选）：带 admin token + `X-Cluster-ID` 列出某 NS 的 pods。

## 10. 对既有代码的改动

- `main.go`：注册 §7 资源路由，注入 pool/rbac/db/cipher 到资源 handler。
- 复用 `Handler{DB,JWT,Pool,RBAC}`；如需 cipher 给 secret handler，按需注入。
- 可能给 `cluster.ClusterClient` 暴露只读取 `RESTMapper`/`Dynamic` 的便捷方法（若尚无）。
