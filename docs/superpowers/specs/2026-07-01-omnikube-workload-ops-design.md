# 子项目 B — 工作负载运维(Workload Ops)设计

> 日期:2026-07-01 · P0-3 · 依赖:resource handler(dynamic client)、RBAC edit 门控、审计中间件(A)

## 目标

给工作负载补齐日常高频运维动作:伸缩副本、滚动重启、版本历史+回滚、资源事件查看。均自动进审计(继承 A 的中间件)。

## 非目标

- 不做灰度/金丝雀(P2)。
- 不做 HPA 管理(P1 更多资源类型)。
- Pod 删除/驱逐复用现有 `DeleteResource`,仅前端补按钮,不新增后端端点。

## 架构

新增 `backend/internal/handler/workload_ops.go`,路由挂在命名空间级 `res` 组内,`RequireRBAC(...,"edit")` 门控(与 update 同级)。所有端点用 `h.clusterClientFromHeader(c)` 取 dynamic/typed client。

### 1. 伸缩 Scale
`PUT /namespaces/:namespace/resources/:resource/:name/scale`,body `{ "replicas": N }`(N≥0)。
- 适用 `deployments`、`statefulsets`、`replicasets`。
- 实现:patch scale 子资源 `/scale`(`spec.replicas`),用 dynamic client `.Namespace(ns).Patch(name, MergePatch, {"spec":{"replicas":N}}, subresource="scale")`。
- `daemonsets` 无副本 → 400「该资源不支持伸缩」。

### 2. 滚动重启 Restart
`POST /namespaces/:namespace/resources/:resource/:name/restart`。
- 适用 `deployments`、`statefulsets`、`daemonsets`。
- 实现:strategic/merge patch `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] = <RFC3339 now>`。

### 3. 版本历史 + 回滚
- `GET /namespaces/:namespace/resources/:resource/:name/revisions` → `[{revision, createdAt, images, current}]` 倒序。
  - Deployment:列出属主为该 deploy 的 ReplicaSet(owner ref),按注解 `deployment.kubernetes.io/revision` 排序,提取每个 RS 的容器镜像;`current` = 与当前 deploy pod-template-hash 匹配者。
  - StatefulSet/DaemonSet:列出 `controllerrevisions`(owner ref = 该对象),按 `.revision` 排序。
- `POST /namespaces/:namespace/resources/:resource/:name/rollback`,body `{ "revision": N }`。
  - Deployment:找到 `revision==N` 的 RS,把其 `spec.template` 回填到 deploy `spec.template`(触发新 rollout,新 revision 号)。
  - StatefulSet/DaemonSet:找到 `revision==N` 的 ControllerRevision,其 `data` 内嵌 patch,取 `spec.template` 应用到对象。
  - 找不到 revision → 404。

### 4. 事件(describe-lite)
`GET /namespaces/:namespace/resources/:resource/:name/events` → 该对象相关 k8s Events。
- 实现:`events` 资源,fieldSelector `involvedObject.name=<name>,involvedObject.namespace=<ns>`(可选加 kind)。返回 `[{type, reason, message, count, lastTimestamp, source}]` 按时间倒序。
- 供工作负载详情页「事件」标签,同时为未来「事件中心」打基础。

## 前端

- `frontend/src/api/resource.ts` 增:`scale(resource,ns,name,replicas)`、`restart(...)`、`revisions(...)`、`rollback(...,revision)`、`events(...)`。
- 工作负载列表页(Deployments/StatefulSets/DaemonSets)行操作增:
  - **伸缩**(Deploy/STS):弹窗填副本数。
  - **重启**:二次确认。
- 工作负载详情页(WorkloadDetail / *Detail):
  - **版本历史**抽屉:表格列 revision/时间/镜像/当前,每行「回滚到此版本」按钮(二次确认)。
  - **事件** Tab:事件表格。
- Pod 列表:补「删除」行操作(复用 delete)。
- i18n:`ops.*` key 补 7 语。

## 数据流

前端按钮 → 对应 API → workload_ops handler → typed/dynamic client patch/list → 返回。写操作经审计中间件落审计(action=scale/restart/rollback)。

## 测试

`backend/internal/handler/workload_ops_test.go`(用 fake dynamic client / envtest 风格已有的测试脚手架):
- scale:deploy 成功改副本;daemonset → 400。
- restart:patch 含 restartedAt 注解。
- revisions:deploy 从多个 RS 聚合并排序、标记 current。
- rollback:deploy 回填指定 revision 的 template;不存在 → 404。
- events:按 involvedObject 过滤返回。

前端:相关页组件 render/交互冒烟(参照现有 resourceTable.test 模式,mock resourceApi 新方法)。

## 验收

- 列表可伸缩/重启;详情可查版本历史并回滚;事件 Tab 展示。
- 所有写动作在审计页可见。
- 前端 tsc/lint/test/build 全绿;后端 `go test ./...` 全绿。
