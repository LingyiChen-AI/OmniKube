# OmniKube 子项目 G：自定义角色管理（跨集群权限模板）— 设计文档

> 日期：2026-06-29
> 来源：用户需求——「用户绑定角色；建用户时选角色；角色绑定多个集群的各项权限」。
> 依赖：A–F 已完成。复用 C 的 `rbac.Service`（4 个内置级别的 `p` 策略 + `domMatch` + `AddGrant/RemoveGrant/RemoveUserGrants`）。

## 1. 背景与目标

把权限模型从「直接给用户在单集群/NS 上绑预设角色」升级为 **基于自定义角色** 的模型：

- **角色（Role）**：admin 创建的命名权限模板（如「运维组A」），内含若干 **规则（Rule）**。
- **规则**：一个或多个集群 + 权限级别 + 范围。多集群一次配置相同级别。
- **用户 ↔ 角色**：多对多，用户可绑多个角色，权限取并集。
- **完全基于角色**：移除旧的「直接给用户授权矩阵」（`/grants` 端点与前端 GrantForm）。

### 已定决策
- 角色 = 自定义命名（跨集群）；规则用「级别 + 范围」表达（复用 4 个内置级别）；用户可多角色；完全替换直接授权。

## 2. 权限级别与范围（复用内置）

「级别」直接复用 C 已种子化的 4 个 Casbin 原语角色，作为规则里的权限档位：

| 级别 | 适用范围 | 含义 |
|---|---|---|
| `Cluster-Admin` | cluster | 集群级全权 |
| `Cluster-Viewer` | cluster | 集群级只读 |
| `NS-Editor` | namespace | 指定 NS 读写 + exec + reveal |
| `NS-Viewer` | namespace | 指定 NS 只读 |

范围 `scope`：`cluster`（仅 `Cluster-*`）或 `namespace`（仅 `NS-*`，需指定 namespaces）。

## 3. 数据模型（新增 3 张表）

```go
type Role struct {
    ID          uint   `gorm:"primaryKey"`
    Name        string `gorm:"unique;not null;size:100"`
    Description string `gorm:"size:255"`
    CreatedAt, UpdatedAt time.Time
}
func (Role) TableName() string { return "ok_roles" }

// 每条规则绑定到一个集群；UI 多集群选择 → 展开成多行(同 level/scope/namespaces)。
type RoleRule struct {
    ID         uint   `gorm:"primaryKey"`
    RoleID     uint   `gorm:"index;not null"`
    ClusterID  string `gorm:"size:50;not null"`
    Level      string `gorm:"size:20;not null"` // Cluster-Admin/Viewer | NS-Editor/Viewer
    Scope      string `gorm:"size:20;not null"` // cluster | namespace
    Namespaces string `gorm:"type:text"`        // JSON 数组字符串, 仅 scope=namespace
}
func (RoleRule) TableName() string { return "ok_role_rules" }

type UserRole struct {
    UserID uint `gorm:"primaryKey"`
    RoleID uint `gorm:"primaryKey"`
}
func (UserRole) TableName() string { return "ok_user_roles" }
```

`database.Migrate` 增加这 3 张表。

## 4. 物化（核心）：角色 → Casbin g 绑定

自定义角色不直接做成 Casbin 角色；任何变更后**重新物化**受影响用户的 `g` 绑定。鉴权逻辑（C/D/E）完全不变。

```go
// SyncUserGrants 用「用户当前所有角色的规则」重建该用户的 casbin g 绑定。
func (s *Service) SyncUserGrants(userID uint) error {
    s.RemoveUserGrants(strconv.FormatUint(uint64(userID),10)) // 清空该用户 g
    roles := 该用户绑定的所有角色及其规则
    for each rule {
        switch rule.Scope {
        case "cluster":  AddGrant(uid, rule.Level, rule.ClusterID)
        case "namespace":
            for ns in rule.Namespaces { AddGrant(uid, rule.Level, rule.ClusterID+":"+ns) }
        }
    }
}
```

**触发点**（保证一致性，建议放事务后再 sync）：
- 给/取消用户某角色 → `SyncUserGrants(user)`。
- 编辑某角色的规则 → 对**所有绑定该角色的用户**逐个 `SyncUserGrants`。
- 删除角色 → 删 `user_roles` + `role_rules` → 受影响用户 `SyncUserGrants`。
- 删除集群（接回 B 的 OnDelete）→ 删该集群相关 `role_rules` + 受影响用户 `SyncUserGrants` +（保险）`RemoveClusterPolicies`。
- 删除用户 → 删 `user_roles` + `RemoveUserGrants`（已有）。

## 5. API（admin 专属，JWTAuth + RequireAdmin）

### 角色管理 `internal/handler/role.go`
| 方法 | 路径 | body / 说明 |
|---|---|---|
| POST | `/api/v1/roles` | `{name, description, rules:[{cluster_ids:[], level, scope, namespaces:[]}]}`；每条 rule 的 `cluster_ids` 展开成多行 |
| GET | `/api/v1/roles` | `[{id,name,description,rules:[{cluster_id,level,scope,namespaces}]}]` |
| GET | `/api/v1/roles/:id` | 单个角色详情 |
| PUT | `/api/v1/roles/:id` | 全量替换 name/description/rules → 重新 sync 绑定用户 |
| DELETE | `/api/v1/roles/:id` | 删除 + 解绑 + sync |

### 用户（改造 `internal/handler/user.go`）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/users` | `{username, role_ids:[]}` → 建用户 + 绑角色 + sync；返回一次性临时密码 |
| GET | `/api/v1/users` | 增加 `roles:[{id,name}]` 字段 |
| PUT | `/api/v1/users/:id/roles` | `{role_ids:[]}` 设置用户角色 + sync |
| DELETE/disable/enable | 不变 |

### 移除
- 删除 `POST/GET/DELETE /api/v1/grants` 与 `internal/handler/grant.go`（及前端 GrantForm）。`rbac.Service` 的 `AddGrant/RemoveGrant/RemoveUserGrants/ListGrants` **保留**（被物化逻辑与级联复用）。

### 校验
- `name` 唯一；`level`/`scope` 兼容（`Cluster-*`↔cluster，`NS-*`↔namespace 且 namespaces 非空）；`cluster_ids` 必须存在；空规则角色允许（无权限占位）。

## 6. 前端（i18n agent 落地后再做）

- **角色管理页 `/roles`（admin）**：角色表格（名称/描述/规则数/绑定用户数）+ 创建/编辑抽屉。规则构建器：可增删多条规则行，每行 = 多选集群 + 级别下拉 + 范围单选；范围=namespace 时显示 NS 多选（建议项来自所选集群之一的 `/namespaces`，允许手输 tags）。级别/范围联动约束。
- **用户页**：建用户时多选角色；编辑用户角色；列表展示用户的角色标签。**移除旧 GrantForm/授权矩阵**。
- 侧边栏「用户与权限」下新增「角色」入口。
- API：新增 `api/role.ts`；改 `api/user.ts`；移除 `api/grant.ts` 的使用。
- i18n：补 `role.*` 等键到 zh/en/ja。

## 7. 测试

- **rbac/role service**：建角色（多集群规则）→ 绑用户 → 断言物化出的 g 行正确（cluster 范围 1 行/集群，namespace 范围 1 行/ns）；编辑角色规则后绑定用户的 g 重算；多角色并集；删角色/删集群/删用户的级联 sync 正确；level/scope 校验。
- **handler**：role CRUD、user 带 role_ids 创建/改角色的状态码与 DB+casbin 副作用；非 admin 403。
- **前端**：角色规则构建器的级别/范围约束；建用户选多角色；列表展示角色；移除 grant 后无残留调用。Vitest 绿。

## 8. 验收标准

1. 后端 `go test ./... -race`、前端 `npm run build/lint/test` 全绿。
2. 创建一个跨多集群的角色，绑给用户后，该用户在各集群/NS 的访问按角色规则生效（用 `Authorize` 验证允许/拒绝）。
3. 编辑角色规则后，所有绑定用户权限即时随之变化（重新物化）。
4. 一个用户绑多个角色时权限取并集。
5. 旧 `/grants` 端点与前端授权矩阵已移除，无残留引用。
6. 建用户界面可选角色；角色管理页可多选集群配置权限。

## 9. 对既有代码的改动

- `model`：新增 Role/RoleRule/UserRole；`database.Migrate` 加表。
- `rbac.Service`：新增 `SyncUserGrants` + 角色 CRUD/查询（或拆 `internal/role` 服务复用 rbac）。
- `handler`：新增 role.go；改 user.go；删 grant.go。`router`/`main` 相应增删路由。
- B 的 `OnDelete`：扩展为「删 role_rules + sync 用户 + RemoveClusterPolicies」。
- 前端：新增角色页/API，改用户页，删 grant 相关。
