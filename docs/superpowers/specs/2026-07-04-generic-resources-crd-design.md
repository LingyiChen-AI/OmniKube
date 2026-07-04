# 通用资源 / CRD 支持 — 设计方案

> 状态:已确认,待实现。分支:`feat/next-highvalue`。
> 路线图见 `docs/roadmap-highvalue.md`(本项为第 1 项)。

## 目标

让 OmniKube 能浏览/查看/编辑/删除集群里的**任意资源类型**(含 CRD,以及内置但未纳入现有 13 种的资源如 ReplicaSet / HPA / NetworkPolicy / ServiceAccount / Namespace 等),通过 API discovery 动态发现,受一个**粗粒度权限**门控。AI 助手同步支持任意资源。

## 背景:现状与可复用面

现系统只支持 13 种硬编码资源(`rbac.moduleResources`)。经代码核对,底层通用能力**已具备**:

- `cluster.ClusterClient` 已含 `Discovery`(discovery 客户端)、`RESTMapper`(`DeferredDiscoveryRESTMapper` + memory cache,自动发现 CRD)、`Dynamic`、`Typed`、`Config`(`backend/internal/cluster/client.go`)。
- `resolveGVR(cc, resource)`(`handler/resource.go`)已用 RESTMapper 把任意复数名解析为 GVR 并判定是否命名空间型。
- 通用 CRUD:`ListResource/GetResource/CreateResource/UpdateResource/DeleteResource`(`handler/resource.go`)全部走 dynamic client,**不引用** `validResources`。
- `middleware/rbac.go` 的 `resolveResource` 用 RESTMapper 校验资源,不做硬编码拒绝。
- 前端 `ResourceTable`、`resourceApi.*` 通用(接受任意 resource 字符串);`EditResourceDrawer` 对未知 kind 自动回退 YAML(`getResourceForm` 返回 null 时)。

**阻塞点(硬编码白名单)**:
- `handler/role.go` `validateRules`:`IsValidResource` 拒绝未知资源。
- `rbac/capabilities.go`:只遍历 `AllResources`。
- `rbac/operations.go` `VisibleSubmenus`:`IsValidResource` 过滤。
- 前端 `api/role.ts`:`ResourceKey` 联合类型、`MODULE_RESOURCES`、`CLUSTER_SCOPED_RESOURCES`;`Sidebar.tsx` 硬编码菜单。

本设计不去逐一「打开」所有资源,而是引入一个粗粒度伪资源承载「其它资源」的权限,并新增一个发现端点 + 一个通用浏览器页面。

## 决策(已确认)

1. **权限**:单个粗粒度伪资源 `customresources`(非细粒度按 CRD)。
2. **能力**:完整 CRUD(列表/详情/YAML 编辑/删除),YAML 为主。
3. **AI**:本次同步放开到任意资源。

## 权限模型:`customresources`

- 新增伪资源 `customresources`,动作 `view / create / edit / delete`(不含 exec/reveal)。它代表「**所有非内置 13 种的真实资源**」。
- **合法性**:把 `customresources` 加入 `validResources`(使 `IsValidResource("customresources")==true`,角色矩阵可授予、`validateRules` 通过)。但它**不进** `moduleResources`(不生成资源导航子菜单)。
- **鉴权映射**(核心):在 `rbac.Service.Authorize(userID, clusterID, namespace, resource, action)` 内,enforce 之前:
  ```
  effResource := resource
  if !IsValidResource(resource) {        // 未知/CRD/未纳入的内置资源
      effResource = "customresources"
  }
  // 用 effResource 走 casbin enforce(admin 旁路、聚合读路径不变)
  ```
  说明:请求到达 `Authorize` 时,resource 已被中间件用 RESTMapper 解析为真实存在的资源(否则中间件已 400)。因此「未知」= 「真实但非内置 13 种」。
- **动作适用**:`ResourceActionApplies("customresources", a)` 对 `view/create/edit/delete` 返回 true,`exec/reveal` 返回 false。
- **预置角色**:`seedPresetRoles` 里给「集群管理员」预置角色补 `customresources` 全动作(其余预置角色不给;admin 用户本就旁路)。幂等播种。
- **矩阵展示**:`customresources` 不属于任何 `module`;前端角色页把它作为一个独立行「其它/自定义资源」渲染(见前端章节)。

### 已知限制
- 命名空间型 CRD 的**集群级聚合读取**不做(`isAggregatableRead` 仍是固定内置集)。用户在选定命名空间内列举 customresources;跨 NS 聚合需要集群级 `customresources` 授权。v1 接受此限制。

## 后端

### 新增发现端点 `GET /api-resources`
- 路由:`authed.GET("/api-resources", h.ListAPIResources)`(JWT;handler 内校验有效 `X-Cluster-ID`,与 `/namespaces` 同口径)。
- 实现:`cc.Discovery.ServerPreferredResources()` → 展平为条目数组:
  ```json
  { "resources": [
    { "group": "apps", "version": "v1", "resource": "replicasets", "kind": "ReplicaSet", "namespaced": true, "builtin": false, "verbs": ["get","list","create","update","delete"] }
  ] }
  ```
  - **过滤**:跳过子资源(`APIResource.Name` 含 `/`);跳过不含 `list` verb 的类型。
  - `builtin`:该 `resource`(复数)是否在现有 13 种内(`rbac.IsValidResource`)。
  - `namespaced`:取 `APIResource.Namespaced`。
  - **容错**:`ServerPreferredResources` 可能对个别 API 组返回错误但仍给出部分结果(`discovery.ErrGroupDiscoveryFailed`),忽略该错误、返回已取到的部分。
  - 结果按 `group` 再按 `resource` 排序。
- 鉴权:该端点只返回类型元数据(非资源数据),门槛为 JWT + 有效集群(不额外要求 customresources:view,以便发现页能加载;真正的资源数据仍由 RBAC 中间件逐资源门控)。

### 放开三处内置校验
- `handler/role.go` `validateRules`:`IsValidResource` 需接受 `customresources`(加入 `validResources` 后自然通过)。无需其它改动。
- `rbac/capabilities.go` `Capabilities`:在遍历 `AllResources` 之外,**额外**计算 `customresources` 的动作集(`out["customresources"] = 用户在该 cluster/ns 对 customresources 有的动作`)。这样前端能对任意非内置资源用 `can("customresources", …)` 判定按钮。
- `rbac/operations.go` `VisibleSubmenus`:无需改(customresources 不是导航子菜单);但需确认它不会因为 `customresources` 出现在 operations 里而报错——它用 `IsValidResource` 过滤,customresources 现在合法,会被保留但不对应任何 submenu,前端忽略即可。核对并在必要时显式跳过 `customresources`。

### CRUD:不改
现有通用 CRUD 端点直接支持任意资源。唯一注意:`UpdateResource` 里「工作负载改镜像记发布」的逻辑对非工作负载资源不触发(已按 `workloadKind` 白名单判定,天然跳过)。

## 前端

### 新页面「API 资源」(`pages/apiResources/`)
- 菜单:`Sidebar` 增加「API 资源」项(图标如 `ApiOutlined`),门控:`canGlobal-style` —— 有 `customresources:view` 或 admin 才显示。用现有 `can('customresources','view')`(来自 capabilities)判断;因 capabilities 是按 cluster/ns 的,菜单可用「用户 global/nav 是否含 customresources」近似,或始终显示、进页面再判权限。**采用**:菜单始终对登录用户显示入口,页面内按 capability 显示可操作类型(简单稳妥;与资源页 capability 门控一致)。
- 路由:`App.tsx` 加 `/api-resources` → `ProtectedRoute`(不套 `GlobalRoute`,因无全局区域;页面自身按 capability 门控)。
- 页面结构:
  1. 顶部:资源类型选择器 —— 拉 `apiResourcesApi.list()`(`GET /api-resources`,带当前集群),按 API 组分组、可搜索(kind / resource / group)。默认可加过滤「隐藏已有专页的内置资源」(`builtin` 为 true 的 13 种),默认开启。
  2. 选中类型后:复用 `ResourceTable`(传 `resource`、`namespaced`(来自发现结果));行操作查看/编辑/删除用 `EditResourceDrawer`(YAML 回退)。命名空间型资源受顶栏当前 NS 影响(与现有资源页一致)。
- API:`frontend/src/api/apiResources.ts` —— `list(): Promise<ApiResourceType[]>`。
- capability:`can(resource, action)` 帮助函数增强 —— 若 `resource` 非内置(不在 `ALL_RESOURCES`),回退查 `customresources`。scope(namespaced)一律取发现结果,不用 `CLUSTER_SCOPED_RESOURCES`。

### 角色页:`customresources` 一行
- `api/role.ts`:新增导出 `CUSTOM_RESOURCE = 'customresources'`;`can`/capability 逻辑增强(非内置资源回退 customresources)。
- `Roles.tsx`:在资源权限矩阵(RuleBuilder)里,除现有模块外,增加一行「其它/自定义资源」(`customresources`,列 view/create/edit/delete)。它属于「集群规则」的每资源矩阵(和现有资源同级),而非全局区域。
- i18n:`nav.apiResources`、`role.customResources`(「其它/自定义资源」)等文案补 7 语言。

## AI 助手:放开任意资源

- AI 的读工具(`list_resources` / `get_resource` / `get_pod_logs` 等)与写暂存工具:去掉对固定资源集的校验(若有),改为 `resolveGVR` 解析 + `guard.Allow(userID, cluster, ns, resource, action)`。因 `Authorize` 已把未知资源映射到 `customresources`,AI 对任意资源的操作**自动**受 customresources 授权门控。
- 系统提示(system prompt 常量)补一句:助手可操作集群里的任意资源类型(含 CRD),写操作仍两阶段确认。
- 核对 `ai/tools.go`:确认工具不因未知资源名而拒绝(去掉任何 `IsValidResource` 类校验);资源名以 RESTMapper 解析为准。

## 错误处理

- 未知资源(集群里不存在)→ RESTMapper 解析失败 → 400「未知资源」(现有)。
- 无权限 → 403(customresources 闸门)。
- 发现部分失败 → 忽略 `ErrGroupDiscoveryFailed`,返回部分类型。
- 集群不可用 → 400(与 `/namespaces` 同口径)。

## 测试

**后端(`go test ./...`)**:
- `Authorize`:对未知资源(如 `replicasets`)映射到 `customresources` 后按授权判定;内置资源仍走原路径;admin 旁路不变。
- `validateRules`:接受 `customresources` 授权,拒绝真正非法资源名。
- `Capabilities`:返回含 `customresources` 动作集。
- `ListAPIResources`:过滤子资源与不可 list 类型;标 `builtin`;`ErrGroupDiscoveryFailed` 容错。
- `ResourceActionApplies("customresources", …)`:view/create/edit/delete 适用,exec/reveal 不适用。

**前端(`vitest`)**:
- `can(resource, action)`:非内置资源回退 customresources 判定。
- API 资源页:发现列表渲染 + 类型选择;无 customresources 权限时不显示可操作类型。
- 角色页:customresources 行渲染与勾选。

## 涉及文件清单

**后端:**
- `rbac/resources.go` —— `customresources` 加入 `validResources`;`ResourceActionApplies` 处理;（可选)常量。
- `rbac/service.go` —— `Authorize` 未知资源→customresources 映射;`seedPresetRoles` 给集群管理员补 customresources。
- `rbac/capabilities.go` —— 额外计算 customresources 动作集。
- `rbac/operations.go` —— 确认 `VisibleSubmenus` 对 customresources 不产生假子菜单。
- `handler/apiresources.go`(新)—— `ListAPIResources`。
- `handler/role.go` —— 依赖 validResources 放行(通常无需改)。
- `router/router.go` —— 注册 `GET /api-resources`。
- `ai/tools.go` / `ai/runner.go` —— 工具放开任意资源 + system prompt 补充。

**前端:**
- `api/apiResources.ts`(新)、`api/role.ts`(customresources + can 回退)。
- `pages/apiResources/ApiResources.tsx`(新)。
- `pages/roles/Roles.tsx`(customresources 行)。
- `components/Sidebar.tsx`、`App.tsx`(菜单 + 路由)。
- `nav.ts`(can/scope 增强,如需要)。
- `i18n/locales/{zh,en,ja,ko,fr,de,es}.ts`。
