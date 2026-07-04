# 集成部署 (Integrated Deployment) — 设计方案

> 状态:已确认，待实现。
> 分支:`feat/integrated-deploy`

## 目标

在 OmniKube 增加一个「集成部署」菜单:把 Deployment / ConfigMap / Service 等一组资源打包成一个**工单**，按固定类型优先级**一次性、有序**发布到集群（先发 config 再发 workload，避免配置未就位导致发布不生效）。工单受权限管理，可复制，复制复用创建权限；页面可选择的资源与用户自身的资源级权限挂钩。

## 术语

- **工单 (Deploy Order)**：绑定到单集群 + 单命名空间的一组资源清单（manifests），可整体编辑、反复发布。
- **资源条目 (Item)**：工单里的一份 manifest，来源可以是「从集群选取已有资源的快照」或「手写/粘贴 YAML」。
- **发布 (Publish)**：把工单里的条目按固定顺序 upsert 到集群，并留一条发布历史。
- **发布历史 (Run)**：一次发布的记录，含每条资源的结果。

## 范围

**做：**
- 单集群 + 单命名空间的工单。
- 资源条目两种来源：从集群选取（快照当前 YAML，可编辑）+ 手写 YAML。
- 固定类型优先级发布顺序，不可由用户调整。
- 遇错即停的顺序发布；每条资源返回结果。
- 可反复发布，每次留一条发布历史。
- 全局权限区域 `integrated_deploy`，动作 `view / create / edit / delete / publish`。
- 复制工单（复用 create 权限）。
- 资源级 RBAC 二次校验（保存 + 发布都校验）。
- 可选资源列表按用户写权限过滤。

**不做（YAGNI）：**
- 跨集群、多命名空间。
- 多人审批流。
- 自动回滚。
- 发布时等待 Pod ready（apply 到 API 成功即算该条成功）。
- 自动写入现有「发布记录 / ReleaseRecord」（避免重复记账与耦合，留待后续）。

## 数据模型

新增 2 张表。遵循 `CLAUDE.md`:改 `backend/internal/model/model.go` 结构体 + 挂 `backend/internal/database/database.go` 的 `AutoMigrate` 列表 + 新增幂等迁移 `backend/migrations/005_integrated_deploy.sql`。

### ok_deploy_orders — 工单本体

| 列 | 类型(GORM → PG) | 说明 |
|---|---|---|
| id | uint → BIGSERIAL PK | |
| user_id | uint → BIGINT，index | 创建者 |
| username | string size:50 → VARCHAR(50) | 创建者名（冗余展示） |
| cluster_id | string size:50 → VARCHAR(50)，index | 绑定集群 |
| namespace | string size:100 → VARCHAR(100) | 绑定命名空间 |
| title | string size:200 → VARCHAR(200) | 工单标题 |
| description | string type:text → TEXT | 说明 |
| items | string type:text → TEXT（存 JSON 数组） | 资源条目，见下 |
| status | string size:20 → VARCHAR(20) | `draft` \| `succeeded` \| `failed`（反映最近一次发布） |
| created_at | time.Time → TIMESTAMPTZ | |
| updated_at | time.Time → TIMESTAMPTZ | |

`items` 是一个 JSON 数组，每个元素:

```json
{
  "kind": "configmap",           // 小写资源名，与 rbac moduleResources 对齐
  "name": "app-config",
  "source": "selected",          // "selected" | "authored"
  "manifest_yaml": "apiVersion: v1\nkind: ConfigMap\n...",
  "sort_index": 0                // 组内相对顺序（添加顺序）
}
```

> items 以 JSON 存在工单行上（工单作为一个 bundle 整体 PUT 保存），不再单独建子表。

### ok_deploy_order_runs — 发布历史

| 列 | 类型 | 说明 |
|---|---|---|
| id | uint → BIGSERIAL PK | |
| order_id | uint → BIGINT，index | 所属工单 |
| user_id | uint → BIGINT | 发布者 |
| username | string size:50 | 发布者名 |
| status | string size:20 | `succeeded` \| `failed` |
| results | string type:text（存 JSON 数组） | 每条资源结果，见下 |
| created_at | time.Time → TIMESTAMPTZ，index | |

`results` 每个元素:

```json
{
  "kind": "deployment",
  "name": "app",
  "phase": "updated",            // "created" | "updated" | "failed" | "skipped"
  "message": ""                  // 失败原因 / 备注
}
```

`skipped` = 遇错即停后，尚未执行的后续条目。

## 发布顺序（固定，不可改）

```
组1 配置/数据 : secrets, configmaps, persistentvolumeclaims
组2 工作负载  : deployments, statefulsets, daemonsets, jobs, cronjobs
组3 暴露      : services, ingresses
```

- 组间顺序:组1 → 组2 → 组3。
- 组内顺序:按条目的 `sort_index`（添加顺序）。
- 不在上述列表的 kind 不允许加入工单（保存时拒绝）。
- 后端有一个 `kindGroup(kind) int` / `kindOrder` 映射决定组序，前端有一份对应常量用于展示预览顺序（两端各一份，值一致）。

## 发布执行语义

每条按顺序 **upsert**（镜像 `handler/resource.go` 的 `CreateResource`/`UpdateResource` 与 `ai/executor.go` 的 `Apply`）:

1. `resolveGVR(cc, kind)` 得到 GVR + namespaced 标志。
2. 解析该条 `manifest_yaml` 为 `*unstructured.Unstructured`；**强制** `SetNamespace(order.Namespace)`（防混淆代理）。
3. `GET` 同名对象：
   - 存在 → 回填 `metadata.resourceVersion` 后 `Update` → `phase=updated`。
   - 不存在（NotFound）→ `Create` → `phase=created`。
4. 出错 → `phase=failed`，记 message，**立即停止**，其余条目标 `skipped`。
5. 汇总 `results`，写一条 `ok_deploy_order_runs`，回写工单 `status`（全成功 `succeeded`，否则 `failed`）。

发布是**同步** HTTP 请求（apply 很快），响应体直接返回本次 `run`（含 `results`）。不使用 WebSocket。

## 权限模型

### 全局区域 `integrated_deploy`

- 后端:加入 `backend/internal/rbac/resources.go` 的 `validGlobalAreas`；`validGlobalActions` **新增 `publish`**；`backend/internal/rbac/global.go` 的 `AllGlobalPerms()` 加 `"integrated_deploy": {"view","create","edit","delete","publish"}`。
- 动作语义:
  - `view` — 看工单列表/详情/历史。
  - `create` — 新建工单；**复制**也走 create。
  - `edit` — 编辑工单。
  - `delete` — 删除工单。
  - `publish` — 真正发布到集群（区域级门槛，可实现「能起草不能发布」）。
- 前端 `api/role.ts`:加入 `GLOBAL_AREAS`；`actionsForGlobalArea('integrated_deploy')` 返回 `['view','create','edit','delete','publish']`；`Roles.tsx` 增加该区域一行。

### 资源级二次校验

区域权限之外，每条资源条目都要过资源级 RBAC:

- **保存工单时**:对每条 `kind` 在 `cluster+namespace` 校验用户有 write（edit）权限；任一条不通过则拒绝保存。
- **发布时**:同样对每条 re-gate（防越权 / 权限期间被收回）。
- **可选资源列表**:`GET /integrated-deploy/selectable?kind=&ns=` 只返回用户在该 ns 对该 kind 有写权限的对象名单（复用 `rbac.Authorize` + 现有 list 路径）。

复制不改变以上校验:复制出的 draft 工单再保存/发布时同样二次校验。

## 后端 API

新文件 `backend/internal/handler/integrated_deploy.go`，方法挂在现有 `*Handler`（无需动 Wire）。路由注册在 `backend/internal/router/router.go` 的 `authed` 组，用 `middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", <action>)` 门控。

| 方法 & 路径 | 区域动作 | 说明 |
|---|---|---|
| `GET  /integrated-deploy/orders` | view | 工单列表（可按 cluster_id 过滤，created_at desc） |
| `POST /integrated-deploy/orders` | create | 新建工单（校验每条资源写权限） |
| `GET  /integrated-deploy/orders/:id` | view | 工单详情 + 发布历史 |
| `PUT  /integrated-deploy/orders/:id` | edit | 编辑工单（校验每条资源写权限） |
| `DELETE /integrated-deploy/orders/:id` | delete | 删除工单 |
| `POST /integrated-deploy/orders/:id/copy` | create | 复制为 draft 新工单 |
| `POST /integrated-deploy/orders/:id/publish` | publish | 顺序发布，返回本次 run |
| `GET  /integrated-deploy/selectable?kind=&ns=` | view | 该 ns 用户有写权限的资源名单 |

审计:写操作经现有 `middleware.Audit` 自动记账。

## 前端

- 菜单:`Sidebar.tsx` 增加「集成部署」项（图标 `DeploymentUnitOutlined` 或 `RocketOutlined`），`canGlobal('integrated_deploy','view',user)` 门控。
- 路由:`App.tsx` 增加 `/integrated-deploy` → `GlobalRoute area="integrated_deploy"`，以及工单编辑/详情子路由。
- 页面（`frontend/src/pages/integratedDeploy/`）:
  - **工单列表**:标题、集群/命名空间、状态、创建人、更新时间；操作按钮按权限显示（编辑/复制/删除/发布）。
  - **工单编辑器**:选集群+命名空间（锁定后不可改）；添加资源条目（两种来源:从集群选取 = 调 selectable 接口挑选，快照其 YAML；手写 = YAML 编辑器）；按组展示发布顺序预览；保存。
  - **发布**:确认弹窗展示有序条目 → 调 publish → 结果时间线（每条 created/updated/failed/skipped）。
- API:`frontend/src/api/integratedDeploy.ts`（类型 + 各接口）。
- 角色页:`Roles.tsx` 渲染 `integrated_deploy` 权限行（5 动作）。
- i18n:7 个语言文件（`{zh,en,ja,ko,fr,de,es}.ts`）补齐 `nav.integratedDeploy` + `integratedDeploy.*` 文案块。

## 错误处理

- 保存/发布任一资源无写权限 → 403，指明是哪条。
- manifest YAML 解析失败 → 400，指明是哪条。
- 发布过程中某条 apply 失败 → 该 run `status=failed`，`results` 记 failed + 后续 skipped；HTTP 200 返回结果（业务失败不算传输错误，前端据 results 展示）。
- k8s API 错误经 `writeK8sError` 透传（复用现有）。

## 测试

**后端（`go test ./...`）:**
- 权限双闸门:无 `integrated_deploy` 区域权限被拒；有区域权限但缺资源写权限保存/发布被拒。
- 固定顺序:组1→组2→组3；组内按 sort_index。
- 遇错即停:中途失败后续 skipped，status=failed。
- 复制:生成 draft、复用 create 权限、items 一致。
- upsert:create 分支（NotFound）与 update 分支（回填 resourceVersion）。
- selectable:仅返回有写权限的资源。

**前端（`vitest`）:**
- 列表渲染与按权限显示操作按钮。
- 无权限时菜单/路由门控（`GlobalRoute`）。
- 发布结果时间线展示各 phase。

## 涉及文件清单

**后端:**
- `backend/internal/model/model.go` — 新增 `DeployOrder`、`DeployOrderRun`。
- `backend/internal/database/database.go` — AutoMigrate 增两结构体。
- `backend/migrations/005_integrated_deploy.sql` — 新表（幂等）。
- `backend/internal/rbac/resources.go` — `validGlobalAreas` 加 `integrated_deploy`；`validGlobalActions` 加 `publish`。
- `backend/internal/rbac/global.go` — `AllGlobalPerms()` 加区域。
- `backend/internal/handler/integrated_deploy.go` — 新 handler。
- `backend/internal/router/router.go` — 注册路由。
- 迁移 README 更新。

**前端:**
- `frontend/src/api/integratedDeploy.ts` — 新 API。
- `frontend/src/api/role.ts` — 加区域 + 动作。
- `frontend/src/pages/integratedDeploy/*.tsx` — 列表/编辑器/发布结果。
- `frontend/src/pages/roles/Roles.tsx` — 权限行。
- `frontend/src/components/Sidebar.tsx` — 菜单项。
- `frontend/src/App.tsx` — 路由。
- `frontend/src/i18n/locales/{zh,en,ja,ko,fr,de,es}.ts` — 文案。
