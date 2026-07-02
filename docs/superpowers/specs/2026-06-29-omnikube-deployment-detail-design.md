# OmniKube：部署详情页 — 设计文档

> 日期：2026-06-29
> 来源：用户需求——部署列表名称可点击进入详情，展示 Pod / 镜像 / 配置引用等，页面做美观。
> 纯前端，复用既有 OmniKube API，无后端改动。

## 1. 路由与入口
- 新路由 `/workloads/deployments/:namespace/:name`（受 `PageRoute` 守卫，workloads 页面权限）。
- `Deployments.tsx` 列表「名称」列改为可点击链接 → `navigate('/workloads/deployments/<ns>/<name>')`。
- 详情页顶部「← 返回」回列表；面包屑：工作负载 / 部署 / <name>。

## 2. 数据来源（现有 API）
- 部署详情：`GET /api/v1/namespaces/:ns/resources/deployments/:name`（X-Cluster-ID）→ 完整 manifest。
- 归属 Pods：`GET /api/v1/resources/pods?namespace=:ns` → 前端按部署 `spec.selector.matchLabels` 过滤（pod.metadata.labels ⊇ selector）。
- （可选）ReplicaSets：`GET /resources/replicasets?namespace=:ns` 过滤 ownerRef，用于显示当前/历史版本——首版可省略。

## 3. 页面分区（AntD + 现有主题）
1. **头部卡片**：图标 + 名称（大标题）+ 命名空间 Tag + 状态徽标（就绪 `readyReplicas/replicas`，用 Badge/Progress + 颜色）+ 创建时间(相对)。右侧操作按钮：刷新、编辑 YAML（YamlDrawer，需 workloads write）、删除（需 delete）——按 `useCapabilities` 显示。
2. **概览 Descriptions**：镜像（容器镜像列表，多个则多行）、副本（期望/就绪/更新/可用）、选择器（matchLabels → Tag）、更新策略（type + maxSurge/maxUnavailable）、标签/注解（折叠）、状态条件（Available/Progressing/ReplicaFailure → 彩色 Tag + reason）。
3. **容器 Card（每容器一段或 Collapse）**：名称、镜像、镜像拉取策略、端口、资源 requests/limits（表格）、环境变量（name → value 或 valueFrom 来源）、`envFrom`（configMapRef/secretRef 名称）、挂载卷 volumeMounts（name → mountPath）。
4. **配置引用 Card**：从所有容器的 `env[].valueFrom.configMapKeyRef/secretKeyRef`、`envFrom[].configMapRef/secretRef`、`spec.template.spec.volumes[].configMap/secret` 解析去重，列出引用的 **ConfigMap** 与 **Secret**（彩色可点击 Tag → 跳 `/storage/configmaps` 或 `/storage/secrets` 并定位，首版可仅展示名称）。
5. **Pods 表**：列 名称 / 状态(Phase + 颜色) / 就绪容器(n/m) / 重启次数 / 节点 / 存活时长；行操作：日志、终端（终端需 workloads exec，按 capabilities）。复用 `TerminalPanel`。空态友好提示。

## 4. 设计/样式
- 复用全局主题 + 表格配置（`defaultTableProps`，首列/操作列冻结一致）。
- 头部状态用语义色（就绪满=绿、部分=橙、0=红）。
- 卡片间距统一、留白充足；加载用 Skeleton，错误用 Result，空 Pods 用 Empty。
- 镜像、标签等长文本用 Tag/Text ellipsis，不溢出。
- i18n：新增 `deploymentDetail.*`（及通用 pod/container/config 词）到 zh/en/ja。

## 5. 验收
1. 列表名称可点击进入详情，URL 含 ns/name，刷新可直接进。
2. 正确展示镜像、副本/状态、容器 env/挂载、配置引用、归属 Pods（按 selector 过滤准确）。
3. 编辑/删除/终端按钮按 capabilities 显示（admin 全显示）。
4. `npm run build/lint/test` 全绿；页面美观、响应式、空/错/载态完整。

## 6. 备注
- 仅做 Deployment 详情（本次范围）；StatefulSet/DaemonSet 详情可后续按同模式复用。
- 不改后端；如需引用的 ConfigMap/Secret 明细，点击 Tag 跳到对应资源页即可，详情页本身只列引用名。
