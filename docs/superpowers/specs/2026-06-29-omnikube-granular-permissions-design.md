# OmniKube 子项目 H：细粒度权限（操作权限 + 页面权限 + 预设角色）— 设计文档

> 日期：2026-06-29
> 来源：用户需求——规则按单集群分别配；权限细化到「操作权限(资源组×动作)」+「页面权限(菜单可见)」；预设角色(集群管理员/集群只读…)；默认 admin = 超级管理员。
> 依赖：A–G 已完成。在 G（自定义角色）基础上升级权限粒度。

## 1. 决策（已确认）
- 操作权限粒度 = **资源组 × 动作**。
- 页面权限 = **角色显式勾选可见页面**；集群/用户/角色等**管理页仅超级管理员(admin)**可见。
- 操作权限 **每条规则(每集群/NS)分别配**。
- **每条规则只针对一个集群**（各集群命名空间不同，单独选择）。
- 预设角色开箱即用；`admin`(IsAdmin) 是超级管理员，旁路一切（已实现，保留）。
- 菜单「用户与权限」改名「用户」（已完成）。

## 2. 词表（固定枚举）

- **资源组 group**：`workloads` / `network` / `config` / `cluster`
- **动作 action**：`read`(查看) / `write`(创建·编辑) / `delete`(删除) / `exec`(终端) / `reveal`(揭示明文)
- **页面 page**：`dashboard` / `workloads` / `networking` / `storage`（管理页 clusters/users/roles 不在此列，仅超管可见）

> 【后端改动】新增 `delete` 动作：D 的 `parseAction` 把 `DELETE` 映射为 `delete`（原先归 `write`）。这样可单独控制「能改不能删」。

## 3. 数据模型变更

```go
type Role struct {
    ID, Name(unique), Description
    System bool   `gorm:"default:false"` // 预设角色, 不可删除(可编辑)
    Pages  string `gorm:"type:text"`     // JSON []string, 子集 of {dashboard,workloads,networking,storage}
    timestamps
}

type RoleRule struct {
    ID, RoleID
    ClusterID  string // 单个集群; 特殊值 "*" = 所有集群(仅 scope=cluster 允许)
    Scope      string // cluster | namespace
    Namespaces string // JSON []string, 仅 scope=namespace
    Operations string // JSON: map[group][]action, 如 {"workloads":["read","write","delete","exec"],"config":["read","reveal"]}
}
// 移除旧的 Level 字段，改用 Operations。
```

`UserRole` 不变。`database.Migrate` 自动加列；`RoleRule.Level` 删除。

## 4. Casbin 物化（核心，matcher 不变）

Casbin 模型仍为 `g(r.sub,p.sub,r.dom) && resMatch(r.obj,p.obj) && (r.act==p.act||p.act=="*")` + `domMatch`。把每条规则的「操作集合」物化为**合成角色（synthetic role）**，用户绑定到合成角色：

```
SyncUserGrants(userID):
  RemoveUserGrants(uid)                       // 清空该用户 g
  for role in 用户的角色:
    for rule in role.rules:
      sig := canonicalSignature(rule.Operations)      // 对 operations 规范排序后的稳定签名
      synth := "perm:" + sig
      for (group, action) in rule.Operations:         // 幂等建合成角色的 p 策略
        AddPolicy(synth, "*", group, action)
      domains := rule.Scope=="cluster" ? [rule.ClusterID]
               : [rule.ClusterID+":"+ns for ns in rule.Namespaces]
      for d in domains: AddGrant(uid, synth, d)         // g(uid, synth, domain)
```

- **合成角色按签名去重**：相同操作集合复用同一 `perm:<sig>`，多用户/多角色共享其 p 策略。p 策略幂等 `AddPolicy`。
- **`domMatch` 扩展**：新增 `polDom=="*" → true`（匹配任意请求域=所有集群）。其余不变（相等；polDom 无冒号→覆盖该集群所有 NS）。`"*"` 仅用于 `scope=cluster` 的规则。
- 旧的 4 个内置级别(Cluster-Admin/…)的 p 策略不再被物化使用；可保留(无害)或移除——实现可移除以避免歧义，鉴权完全走合成角色。
- **孤儿合成角色**：可暂不清理(无害且去重)；记 TODO。

> 鉴权 `Authorize`、受控集群级只读、`ListVisibleNamespaces` 等逻辑不变，仍按 (group, action, domain) 命中。

## 5. 预设角色（启动幂等种子，System=true）

| 角色 | Pages | 规则(Operations) |
|---|---|---|
| 集群管理员 (Cluster-Admin) | 全部 4 页 | `{cluster:"*", scope:cluster, ops:{workloads:[read,write,delete,exec], network:[read,write,delete], config:[read,write,delete,reveal], cluster:[read,write,delete]}}` |
| 集群只读 (Cluster-Viewer) | 全部 4 页 | `{cluster:"*", scope:cluster, ops:{workloads:[read], network:[read], config:[read], cluster:[read]}}` |
| 只读审计员 (Auditor) | dashboard | `{cluster:"*", scope:cluster, ops:{所有组:[read]}}` |

- 这些用 `cluster:"*"` → 对所有现有/新增集群生效，无需预先选集群。
- **命名空间级**预设(NS-Editor/NS-Viewer)因需具体集群/NS，不做成种子角色，而是前端规则构建器里的**操作模板**(一键填充勾选)。
- `System` 角色禁止删除（PUT 编辑允许）。删除时返回 409/403。

## 6. /me 返回有效页面（驱动前端导航）

`GET /api/v1/me` 响应增加：
- `is_admin`（已有）
- `pages: []string` —— admin → 全部 4 页 + 管理页标记；非 admin → 其所有角色 `Pages` 的并集。

前端据此渲染侧边栏与路由守卫（非 admin 仅显示其有权的资源页；管理页(clusters/users/roles)仅 admin）。

## 7. API 变更

- `POST/PUT /api/v1/roles` body：`{name, description, pages:[], rules:[{cluster_id, scope, namespaces:[], operations:{group:[actions]}}]}`（每条规则单集群；`cluster_id:"*"` 仅 cluster 范围）。
- `GET /api/v1/roles`：返回含 `pages`、`system`、每 rule 的 `operations`。
- 删除 System 角色 → 拒绝。
- 校验：group/action/page 枚举合法；scope=namespace 需 namespaces 非空且 cluster_id≠"*"；scope=cluster 时 namespaces 忽略；operations 至少一项（空操作规则允许=占位但无权限）。
- 用户/级联逻辑(G)不变，仍 `SyncUserGrants`。

## 8. 前端变更

### 规则构建器（重做）
每条规则一张卡片：
- **集群**：单选（含「全部集群 *」选项，选后范围锁为整集群）。
- **范围**：整集群 / 指定命名空间（命名空间多选，数据来自该集群 `/namespaces`）。
- **操作权限矩阵**：4 资源组(行) × 5 动作(列：查看/编辑/删除/终端/揭示)复选框；顶部「模板」快捷填充（集群管理/集群只读/NS编辑/NS只读）。不适用的格子可禁用(如 cluster 组无 exec/reveal)。
- 「添加规则」加新卡片（每卡片独立集群）。

### 角色级页面权限
角色编辑区一组复选框：仪表盘/工作负载/网络/存储（管理页不在此，超管恒可见）。

### 导航/路由守卫
- 拉 `GET /me` 的 `pages` + `is_admin`；侧边栏与 `ProtectedRoute` 按之过滤：非 admin 仅显示有权资源页；clusters/users/roles 仅 admin。
- 角色列表展示「系统」标签与页面/规则摘要；System 角色禁删（按钮禁用）。

### i18n
补全 group/action/page/模板/页面权限等中英日文案。

## 9. 测试

- **后端**：parseAction DELETE→delete；domMatch "*"；operations→合成角色物化(签名去重、p 幂等、域展开)；Authorize 对各 (group,action,domain) 命中/拒绝矩阵（含 delete 独立于 write、cluster:"*" 跨集群）；预设角色种子存在且 System 禁删；/me pages 并集(admin 全量)；role CRUD 校验。`go test ./... -race` 绿。
- **前端**：规则构建器单集群+操作矩阵+模板填充；页面权限勾选；导航按 /me pages 过滤(非 admin 隐藏无权页与管理页)；System 角色禁删。`npm run build/lint/test` 绿。

## 10. 验收标准
1. 后端 `-race`、前端 build/lint/test 全绿。
2. 规则按单集群配置，命名空间来自对应集群。
3. 操作权限可精确到资源组×动作（含 delete 独立、exec/reveal 独立）；鉴权按之生效。
4. 角色可勾选可见页面；非 admin 用户登录后侧边栏/路由按页面权限过滤；管理页仅 admin。
5. 预设角色(集群管理员/集群只读/审计员)开箱存在且可直接分配；System 角色不可删。
6. admin 仍为超级管理员，拥有全部权限与全部页面。
