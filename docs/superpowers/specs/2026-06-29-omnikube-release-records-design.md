# OmniKube：发布记录审计 + 仪表盘增强 + 导航重组 — 设计文档

> 日期：2026-06-29
> 来源：用户需求。依赖 A–H 既有能力。

## 1. 发布记录审计（核心）

### 决策
- **触发**：编辑 **工作负载**(Deployment/StatefulSet/DaemonSet) 且**容器镜像 tag 发生变更**时，记一条发布记录。
- **发布说明(意见) 必填**：镜像变更保存时必须填写说明，否则拒绝(400)。
- **查看权限**：独立的「发布记录」**功能页面权限**（资源页仍按操作权限派生；功能页用显式授权）。
- **前后版本** = 容器镜像（如 `nginx:1.27` → `nginx:1.28`，多容器则记主要/全部）。

### 1.1 数据模型 `ok_release_records`
```go
type ReleaseRecord struct {
    ID         uint
    UserID     uint
    Username   string    // 发布人(冗余, 便于展示)
    ClusterID  string
    Namespace  string
    Kind       string    // Deployment/StatefulSet/DaemonSet
    Name       string
    ImageBefore string   // JSON 或 "container=image" 拼接(多容器)
    ImageAfter  string
    Comment    string    // 发布说明(必填)
    CreatedAt  time.Time `gorm:"index"`
}
```
`database.Migrate` 增加该表。

### 1.2 捕获逻辑（后端，资源 UpdateResource）
- `PUT /namespaces/:ns/resources/:resource/:name` 当 `resource ∈ {deployments,statefulsets,daemonsets}`：
  1. 下发前先取「旧对象」(已有逻辑或额外 GET) 与新对象的容器镜像集合。
  2. 若镜像有变化：
     - 读取发布说明（前端通过 **query 参数 `release_comment`** 或 header `X-Release-Comment` 传）。为空 → 400「发布说明必填」。
     - 正常下发更新成功后，写一条 `ReleaseRecord`（user/cluster/ns/kind/name/before/after/comment）。
  3. 镜像无变化 → 不要求说明，正常更新（不记发布）。
- 镜像对比：比较 `spec.template.spec.containers[].image` 的集合（按容器名）。`ImageBefore/After` 存 `name=image;...` 形式。

### 1.3 API
- `GET /api/v1/releases?cluster_id=&namespace=&limit=` → 发布记录列表（按时间倒序）。
- 鉴权：需要「releases 功能页面权限」（admin 恒可）。后端校验：非 admin 且无 releases 页面权限 → 403。

### 1.4 页面权限（功能页）
- 重新启用 `Role.Pages`（DB 列仍在），**仅存功能页 key**（当前只有 `"releases"`）。资源页(workloads/networking/storage/cluster)仍由操作权限派生，不进 Pages。
- `effectivePages` = 派生资源页 ∪ Role.Pages(功能页)。admin → 全部资源页 + 全部功能页。
- 角色编辑器恢复一个**「功能页面」勾选区**，仅列「发布记录」。

### 1.5 前端
- **发布记录页 `/releases`**（菜单「发布记录」，gated by releases 页面权限）：表格列 时间 / 发布人 / 集群·命名空间 / 类型·名称 / 前→后镜像 / 发布说明。支持按集群、命名空间过滤。
- **发布说明流程**：在 `EditResourceDrawer` 保存工作负载时，若检测到镜像变更 → 弹出「发布说明」必填输入（Modal 或抽屉内字段），填写后带 `release_comment` 调 PUT。非工作负载或镜像未变 → 正常保存，无需说明。
- 角色编辑器：新增「功能页面」勾选（发布记录）。

## 2. 仪表盘增强（参考图）
Dashboard 增加：
- **概览卡片**：集群数(/my/clusters)、运行 Pods(当前集群 pods count)、Deployments(count)、**今日发布**(releases 今日计数)。语义色渐变卡片。
- **最近事件**：当前集群的 K8s Events（`GET /resources/events?namespace=`，按 lastTimestamp 倒序，展示 type/involvedObject/reason/message/time）。
- **集群状态**：每个可访问集群的健康状态(Healthy/Unreachable) + 节点数 + Pods 数（逐集群查询，或用已有 status + 计数）。
- 样式用 ui-ux-pro-max，明暗主题一致。

## 3. 导航重组
- 新增父级菜单 **「系统管理」**(admin 专属, 设置图标)，把 **集群 / 用户 / 角色** 移为其二级子菜单。
- 「发布记录」作为顶级菜单项（按 releases 页面权限显示）。
- 「集群资源」(节点/持久卷, 另一个 agent 正在加) 保持为资源类顶级菜单。
- 最终顶层顺序建议：仪表盘 / 工作负载 / 网络 / 存储 / 集群资源 / 发布记录 / 系统管理(集群·用户·角色)。

## 4. 验收
1. 编辑工作负载改镜像 → 必填发布说明 → 保存后在「发布记录」看到一条(发布人/前后镜像/说明/时间)；改非镜像字段或非工作负载不强制说明、不记录。
2. 「发布记录」菜单与页面按 releases 页面权限控制（admin 恒可；可在角色「功能页面」勾选授予）。
3. 仪表盘展示概览卡片(含今日发布) + 最近事件 + 集群状态。
4. 集群/用户/角色 移入「系统管理」二级菜单。
5. 后端 `go test ./... -race`、前端 build/lint/test 全绿。

## 5. 取舍
- 发布前后版本只记容器镜像（最贴近「发布版本」）；更细的 spec diff 由资源 YAML 差异承担。
- 发布记录是追加型审计，不可改不可删（首版不提供删除）。
