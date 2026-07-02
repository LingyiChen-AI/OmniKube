# OmniKube：资源可视化编辑器（表单 + YAML + 差异对比）— 设计文档

> 日期：2026-06-29
> 来源：用户需求——编辑资源时支持「可视化表单」与「YAML」双模式自选；常见字段做成表单更新；YAML 模式抽屉加大并对比修改前后差异；所有相关组件统一设计。
> 纯前端，复用既有 OmniKube API（`GET/PUT /namespaces/:ns/resources/:resource/:name`），无后端改动。

## 1. 总览

新增 `EditResourceDrawer` 取代现有 `YamlDrawer` 的编辑用途（查看 YAML 仍可保留只读）。抽屉顶部用 Segmented 切换两种模式：
- **可视化**：按资源类型渲染表单，编辑常见字段。
- **YAML**：文本编辑 + **差异对比**（原始 vs 当前）。

两模式共享同一个「工作对象」(deep clone of the fetched manifest)，互相同步。保存时 `PUT` 整个对象。保存按钮按 `useCapabilities().can(group,'write')` 显示/启用。

抽屉宽度：`min(1100, 90vw)`，body 为可滚动区。

## 2. 状态与同步

- `original`: 拉取到的原始 manifest（只读基准，用于 diff）。
- `draft`: 工作对象（可视化表单直接改它；保存提交它）。
- `yamlText`: YAML 模式的文本缓冲。
- 切换 可视化→YAML：`yamlText = toYAML(draft)`。
- 切换 YAML→可视化：`parse(yamlText)` 成功则 `draft = parsed`；失败则提示 YAML 有误、留在 YAML 模式。
- 保存：当前模式为 YAML 时先 `parse(yamlText)`；强制 `apiVersion/kind/metadata.name/metadata.namespace` 与原始一致（防误改主键）；`resourceApi.update(ns, resource, name, obj)`。
- 用 `js-yaml`（项目已用）做 parse/dump；dump 时 `sortKeys:false`、保留注释不强求。

## 3. 可视化表单（按 kind 注册）

注册表 `getResourceForm(kind): FormComponent | null`。表单组件签名 `({ draft, onChange }) => JSX`，对 `draft` 做不可变更新。

| 资源 | 可编辑常见字段 |
|---|---|
| Deployment / StatefulSet | 副本数 `spec.replicas`；每容器：镜像、端口(containerPort 列表)、环境变量(KV)、资源 requests/limits(cpu·memory)；`spec.template.metadata.labels` 与顶层 labels |
| DaemonSet | 同上但**无副本数** |
| Service | `spec.type`(ClusterIP/NodePort/LoadBalancer)；端口列表(port/targetPort/protocol/nodePort)；`spec.selector`(KV) |
| Ingress | `spec.rules`：host + paths(path/pathType/backend service name+port)；`ingressClassName` |
| ConfigMap | `data`(KV，多行 value) |
| Secret | `type`(只读展示)；`data`(KV；值默认 base64 解码显示、可隐藏，保存时回编码 base64)；`stringData` 二选一 |
| 其它(Pod/PVC/Job/ReplicaSet/Node…) | 不提供表单：可视化页签禁用并提示「该资源暂不支持可视化编辑，请使用 YAML」 |

**复用子组件**：
- `KeyValueEditor`：可增删的键值列表（labels/env/selector/configmap data/secret data 通用；支持多行值开关）。
- `ContainerCard`：单容器的镜像/端口/env/资源编辑（workload 表单内按容器循环）。
- `PortListEditor`、`ResourceLimitsEditor`（cpu/memory requests·limits）。

表单只改「常见项」，不动其它字段（深合并到 draft，保留未触及结构）。

## 4. YAML 模式 + 差异对比

- 文本编辑器：等宽字体 textarea（沿用现 YamlDrawer 风格），加行号可选。
- **差异视图**：抽屉内一个「差异」开关/页签，展示 `toYAML(original)` vs `toYAML(draft 或 解析后的 yamlText)` 的**彩色 side-by-side 行级差异**（新增绿、删除红、修改高亮）。无改动时显示「无变更」。
- 实现：用轻量 `diff`(jsdiff) 计算 `diffLines`，自定义渲染左右两栏；或引入 `react-diff-viewer-continued`（择一，优先体积小）。
- 保存前可在 footer 提供「查看差异」快速预览（可选：保存确认弹窗内嵌 diff）。

## 5. 接入点

- `ResourceTable` 行内「编辑」动作 → 打开 `EditResourceDrawer`（替换原 YamlDrawer 编辑路径；查看 YAML 只读可单独保留或并入只读模式）。
- `WorkloadDetail` 头部「编辑」按钮 → 同一抽屉。
- 保存成功 → toast + 触发列表/详情刷新。

## 6. 设计与体验

- 统一主题；表单分组用 Card/Form section，留白充足、标签清晰。
- 可视化与 YAML 切换无数据丢失（同步规则见 §2）；YAML 解析错误行内提示。
- 加载 Skeleton；保存中按钮 loading；权限不足时只读（隐藏保存、表单 disabled）。
- 长文本/多端口/多容器滚动良好，不溢出。
- i18n：新增 `editor.*`（模式/差异/保存/字段标签/容器/端口/资源/键值 等）到 zh/en/ja。

## 7. 验收

1. 编辑任一支持的资源可在「可视化」与「YAML」间自由切换且不丢数据。
2. 可视化改副本/镜像/env/端口/data 等 → 保存后集群实际生效（PUT）。
3. YAML 模式可查看原始与修改后的**彩色差异**；无变更显示无差异。
4. 保存强制保留 apiVersion/kind/name/namespace；非 write 权限只读。
5. 不支持可视化的资源给出明确提示并仍可用 YAML 编辑。
6. `npm run build/lint/test` 全绿；组件美观、空/错/载/权限态完整。

## 8. 备注 / 取舍
- 首版可视化覆盖上表资源的「常见项」；深度字段（亲和性、探针、卷模板等）仍走 YAML。
- Secret 值的 base64 解码/编码仅在表单层处理，提交按 K8s 约定写 `data`(base64)。
- 不改后端；权限沿用 capabilities。
