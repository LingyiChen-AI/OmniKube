# OmniKube 权限模型 v3：分层菜单树 — 设计文档

> 日期：2026-06-30
> 来源：用户要求权限全量改造为「分层、逐级勾选、便于理解」的模型。替换现有「资源组×动作 + 派生页面 + 功能页」整套。
> 决策：系统管理纳入权限树（可授权非超管）；操作粒度到具体资源(子菜单)；每集群独立配 + 一键复用；保留范围(整集群/指定NS)；仪表盘恒可见不受控。

## 1. 核心模型

权限分两层：**全局权限**（不分集群）+ **集群权限**（每集群独立）。

### 1.1 全局权限（Role 级，不分集群）
管理类与跨集群类页面：
| 区域 | 子项 | 可配操作 |
|---|---|---|
| 系统管理 | 集群管理(clusters) | 查看/新建/编辑/删除 |
| | 用户管理(users) | 查看/新建/编辑/删除 |
| | 角色管理(roles) | 查看/新建/编辑/删除 |
| 发布记录 | releases | 查看 |

存储：`Role.GlobalPerms`（JSON）= `{"clusters":[...],"users":[...],"roles":[...],"releases":[...]}`，值为动作数组。

### 1.2 集群权限（每条规则一个集群）
| 字段 | 说明 |
|---|---|
| cluster_id | 单集群；`*`=所有集群 |
| scope | `cluster`(整集群) / `namespace`(指定 NS) |
| namespaces | scope=namespace 时的 NS 列表 |
| operations | **按具体资源**的动作映射：`{"deployments":["view","create","edit","delete"],"pods":["view","exec"],"secrets":["view","reveal"], ...}` |

存储：`RoleRule{ cluster_id, scope, namespaces, operations(JSON map[resource][]action) }`（替换原 `map[group][]action`）。

### 1.3 资源→模块(菜单)映射（前端展示用，逐级勾选）
| 模块(一级菜单) | 子菜单(具体资源) | 适用操作 |
|---|---|---|
| 工作负载 workloads | deployments, statefulsets, daemonsets, pods, jobs, cronjobs | view/create/edit/delete；pods 额外 exec |
| 网络 networking | services, ingresses | view/create/edit/delete |
| 存储 storage | configmaps, secrets, persistentvolumeclaims, persistentvolumes | view/create/edit/delete；secrets 额外 reveal |
| 节点 nodes | nodes | view/create/edit/delete（通常只 view）|

**逐级勾选语义**：勾模块→出现子菜单勾选；勾子菜单→出现操作勾选；取消上层→清空其下。仪表盘(dashboard) 恒可见、不在树中。

### 1.4 动作词表
`view`(读/列表/详情) / `create`(新建) / `edit`(更新) / `delete`(删除) / `exec`(终端，仅 pods) / `reveal`(揭示明文，仅 secrets)。
> 与后端 Casbin 动作对齐：view→read，create→create，edit→write，delete→delete，exec/reveal 同名。

## 2. 后端落地

### 2.1 K8s 资源访问鉴权（Casbin，按具体资源）
- 物化：每条集群规则的 `operations` 展开为合成角色策略 `p(synth, "*", <resource>, <action>)` + `g(user, synth, domain)`（domain 同 v2：cluster 或 cluster:ns，支持 `*`）。
- `resMatch` 保留：策略 obj 现为**具体资源**(如 `deployments`)，请求 obj 也是具体资源 → 精确匹配；仍支持 `*`(全部资源)与资源组名（向后兼容/预设便利，可选）。
- RBACAuthMiddleware、`Authorize`、受控集群级只读、capabilities 逻辑不变，只是 obj 粒度变细。
- 动作映射(middleware parseAction)：GET→read(view)，POST→create，PUT/PATCH→write(edit)，DELETE→delete；exec/reveal 由专用路由。

### 2.2 系统管理端点鉴权（替换 RequireAdmin）
`/clusters`、`/users`、`/roles` 这三组管理端点**去掉 RequireAdmin**，改为新中间件 `RequireGlobalPerm(area, action)`：
- area ∈ {clusters,users,roles}；action 由方法映射（GET→view, POST→create, PUT→edit, DELETE→delete）。
- admin(IsAdmin) 旁路放行。
- 校验：用户所有角色 `GlobalPerms[area]` 的并集是否含该 action。
- `/my/clusters`(顶栏选集群，所有登录用户)、`/me`、`/me/capabilities` 不受此限。
- `/releases` 由 `RequireGlobalPerm(releases, view)`（admin 旁路）。

### 2.3 全局权限聚合
`userGlobalPerms(userID) → map[area]set[action]`：admin→全部；否则取其所有角色 `GlobalPerms` 并集。供 §2.2 与 /me 使用。

### 2.4 /me 返回「有效导航树」
`GET /me` 增加 `nav`(资源子菜单并集) 与 `global`(有效全局权限 map)：
```json
{ "id","username","is_admin","must_reset",
  "nav": { "submenus": ["deployments","pods","services","configmaps","secrets","nodes", ...] },
  "global": { "clusters":["view","create","edit","delete"], "users":[...], "roles":[...], "releases":["view"] } }
```
- `nav.submenus` = 用户在**任一**集群规则里对该资源有 `view`（驱动资源侧边栏，全局展示）。
- `global` = 用户所有角色 GlobalPerms 的并集（驱动「系统管理/发布记录」菜单可见性**与**这些页面的按钮门控：菜单显示当 `global[area]` 含 view；按钮按 `global[area]` 的 create/edit/delete）。
- admin → 全部资源子菜单 + global 全开。
- 仪表盘恒可见（前端固定，不在 nav/global 里）。

### 2.5 capabilities（按具体资源）
`GET /me/capabilities?namespace=` 返回 `{ "resources": { "deployments":["view","create","edit","delete"], "pods":["view","exec"], ... } }`（当前集群+NS 域下，逐资源可用动作；admin 全开）。前端按 `can(resource, action)` 门控按钮。

### 2.6 预设角色（按新模型重建）
- **集群管理员**：所有集群(`*`,整集群) 所有资源 全部动作 + 全局 {clusters/users/roles 全动作, releases view}。
- **集群只读**：所有集群(`*`,整集群) 所有资源 仅 view + 全局 {releases view}（无系统管理）。
- System 角色仍不可删、不可改（只读查看）。

### 2.7 模型/迁移
- `Role` 增 `GlobalPerms string(JSON)`；移除原 `Pages` 用法（列可保留忽略）。
- `RoleRule.Operations` 语义改为 `map[resource][]action`（同字段，内容变细）。
- 开发库重建角色相关表；预设按新模型种子。

## 3. 前端落地

### 3.1 角色编辑抽屉（加宽到 70%）
`width: '70%'`（或 `min(70vw, …)`）。内容两区：
- **全局权限**：折叠树 — 系统管理(集群管理/用户管理/角色管理 各 view/create/edit/delete) + 发布记录(view)。
- **集群权限**：每集群一张卡片 — 集群选择(含「全部集群 *」) + 范围(整集群/指定NS)+NS 多选 + **资源模块树**(工作负载/网络/存储/节点 → 子菜单 → 操作复选)。卡片操作：删除该集群规则。底部「+ 添加集群」「一键复用首个集群配置」(把第一张卡片的 scope/NS/模块树复制到新卡片/指定卡片)。
- 逐级勾选：模块复选(半选态表示部分子菜单)；子菜单复选；操作复选。父取消清子。
- System 角色只读（componentDisabled）。

### 3.2 侧边栏 + 路由守卫（按 /me nav）
- 资源子菜单：`nav.submenus.includes(resource)` 才显示；模块：其任一子菜单可见才显示。
- 节点：`nav.submenus` 含 nodes。存储含 pvc/pv/configmaps/secrets。
- 系统管理：按 `global`（clusters/users/roles 任一含 view 才显示父；各子项按各自 view）。**不再用 is_admin 控制系统管理菜单**（admin 的 global 全开，等价全可见）。
- 发布记录：`global.releases` 含 view。
- 仪表盘恒显示。
- `PageRoute`/守卫同步按 nav 判定（非可见页面重定向到首个可见页或仪表盘）。

### 3.3 capabilities 按资源
`useCapabilities().can(resource, action)`；`ResourceTable` 用自身 `resource` 而非 group 门控按钮（view/create/edit/delete/exec/reveal）。系统管理页(集群/用户/角色)的按钮按 `/me` 的 `global[area]` 门控（view 控页面访问，create/edit/delete 控按钮）。

## 4. 测试

- **后端**：物化按资源(精确匹配)；`Authorize` 对 (具体资源,动作,域) 正确允许/拒绝；系统端点按 GlobalPerm 放行/403（admin 旁路）；/me nav 并集正确(admin 全开)；capabilities 按资源；预设重建；删除集群/用户/角色的级联 sync 不变。`go test ./... -race` 绿。
- **前端**：编辑器逐级勾选(父取消清子、半选态)、一键复用、70% 宽度；侧边栏/路由按 nav 过滤；按钮按 per-resource capabilities；系统管理菜单按 nav.system。`npm run build/lint/test` 绿。

## 5. 验收

1. 角色编辑器逐层勾选：模块→子菜单→操作；仪表盘不在树里且恒可见。
2. 每集群独立配置，可「一键复用首个集群」到其它集群。
3. 全局权限可授系统管理(集群/用户/角色管理)与发布记录给非超管；对应端点按权限放行/拦截。
4. 侧边栏与路由严格按 /me nav；勾了才看得到，没勾啥都看不到。
5. 资源操作按钮按 per-resource 权限显隐；admin 全开。
6. 预设(集群管理员/集群只读)按新模型重建；系统角色只读不可改。
7. 后端 `-race`、前端 build/lint/test 全绿。

## 6. 实施拆分（writing-plans 阶段细化）
- **Part A 后端**：模型/迁移、Casbin 按资源物化、系统端点 GlobalPerm 鉴权、/me nav、capabilities 按资源、预设重建、测试。
- **Part B 前端**：角色编辑器(树/70%/复用)、侧边栏+路由按 nav、capabilities 按资源、系统管理菜单改造、测试。
> A 先行（前端依赖其契约）；A 落地并联调后做 B。

## 7. 取舍 / YAGNI
- 全局权限(系统管理/发布记录)不分集群——它们本就是平台级；不强行塞进每集群树。
- 资源→模块映射在前端维护（后端只存 per-resource 动作），模块是纯展示分组。
- 不做权限继承/角色嵌套；多角色取并集即可。
