# OmniKube 子项目 A：后端地基 — 设计文档

> 日期：2026-06-29
> 来源 PRD：`PRD/v2.md`
> 这是 OmniKube 整体平台的**第一个 spec**。整体按 A→B→C→D→E→F 顺序分多个 spec 实现，每个子项目走自己的 spec → plan → 实现循环。

## 1. 背景与范围

OmniKube 是基于 Golang + React 的企业级多集群多租户 Kubernetes 管控平台。完整平台分解为 6 个子项目：

| 子项目 | 内容 | 依赖 |
|---|---|---|
| **A. 后端地基**（本 spec） | 项目脚手架、GORM 数据模型、JWT 认证、admin 自举、AES-GCM 加密 | 无 |
| B. 多集群连接池 | typed/dynamic/discovery 多客户端、RWMutex 池、启动重建、定时探活、集群 CRUD | A |
| C. 权限系统 | Casbin model.conf、资源组/动作映射、RBAC 中间件链、权限指派中心、级联清理 | A、B |
| D. 资源看板 API | 工作负载/网络/存储 list/CRUD、NS 数据权限过滤、Secret reveal | B、C |
| E. WebSocket | WebSSH(exec) + 实时日志流、升级前鉴权、审计 | B、C |
| F. 前端 | 登录/集群管理/用户权限矩阵/资源看板（AntD + ui-ux-pro-max 精细主题） | A–E |

**本 spec 只覆盖子项目 A**：交付一个**最小可运行的 HTTP 服务**——能连接 PostgreSQL、迁移建表、首启自举 admin、完成登录与改密。后续子项目向此地基增量添加功能。

### 已确认的关键决策

- **数据库**：PostgreSQL
- **JWT 策略**：仅 Access Token（无 refresh token）
- **A 边界**：含最小可运行 HTTP 服务
- **前端栈**（后续 F 用）：Ant Design + ui-ux-pro-max 精细主题定制
- **K8S 环境**（后续 B 用）：有真实集群 kubeconfig

## 2. 架构与项目结构

**Monorepo 布局**：仓库根目录下后端、前端各自一个文件夹，git 仓库在根目录。

```
OmniKube/                        # 仓库根 (git 在此)
├── PRD/                         # 需求文档
├── docs/superpowers/           # spec / plan
├── backend/                    # 后端 (本 spec, Go module = omnikube)
│   ├── cmd/server/main.go      # 入口: 加载配置→连DB→迁移→admin自举→启动Gin
│   ├── internal/
│   │   ├── config/      # 从环境变量加载配置(DSN/JWT密钥/AES主密钥/端口)
│   │   ├── model/       # GORM 模型: User, Cluster, AuditLog
│   │   ├── database/    # DB连接 + AutoMigrate + admin 自举
│   │   ├── crypto/      # AES-256-GCM 加解密 (供 B 加密 kubeconfig 复用)
│   │   ├── auth/        # bcrypt 密码哈希 + JWT 签发/校验
│   │   ├── middleware/  # JWT 认证中间件 (注入 user_id / is_admin)
│   │   ├── handler/     # HTTP handler: login / change-password / me / healthz
│   │   └── router/      # 路由注册
│   ├── go.mod
│   ├── .env.example
│   └── README.md
└── frontend/                   # 前端 (子项目 F, React, 后续创建)
```

> 后端所有 Go 代码与 `go` 命令均以 `backend/` 为工作目录；本 spec 中提到的 `internal/...` 等路径都相对 `backend/`。

**建表范围**：A 阶段建 3 张业务表（`ok_users` / `ok_clusters` / `ok_audit_logs`）+ Casbin GORM adapter 自动建的 `casbin_rule` 表。A 只初始化 Casbin adapter 让 `casbin_rule` 表就绪，**鉴权 enforce 逻辑放到子项目 C**。`ok_clusters` / `ok_audit_logs` 在 A 建表但 CRUD/写入留给后续子项目——避免后续改表结构。

> 模块边界原则：每个 `internal` 子包单一职责、通过明确接口通信、可独立测试。`crypto` / `auth` 不依赖 `handler`；`handler` 依赖 `auth` / `database`。

## 3. 数据模型

完全遵循 PRD 第 3 章。

### 3.1 `ok_users`

```go
type User struct {
    ID        uint   `gorm:"primaryKey"`
    Username  string `gorm:"unique;not null;size:50"`
    Password  string `gorm:"not null;size:100"` // bcrypt 哈希(cost=12)
    IsAdmin   bool   `gorm:"default:false"`
    MustReset bool   `gorm:"default:false"`     // 首登强制改密标记
    CreatedAt time.Time
    UpdatedAt time.Time
}
```

### 3.2 `ok_clusters`（A 阶段仅建表）

```go
type Cluster struct {
    ID         string `gorm:"primaryKey;size:50"`        // 英文唯一标识, 如 cluster_hk
    Name       string `gorm:"not null;size:100"`         // 别名
    Kubeconfig string `gorm:"type:text;not null"`        // AES-256-GCM 密文(含 nonce), 主密钥不落库
    Status     string `gorm:"size:20;default:'Unknown'"` // Healthy / Unreachable / Unknown
    LastCheck  time.Time
    CreatedAt  time.Time
    UpdatedAt  time.Time
}
```

### 3.3 `ok_audit_logs`（A 阶段仅建表）

```go
type AuditLog struct {
    ID         uint      `gorm:"primaryKey"`
    UserID     string    `gorm:"index;size:50"`
    ClusterID  string    `gorm:"index;size:50"`
    Namespace  string    `gorm:"size:100"`
    Resource   string    `gorm:"size:100"`
    Action     string    `gorm:"size:20"`
    Target     string    `gorm:"size:200"`
    Result     string    `gorm:"size:20"`   // allow / deny
    SourceIP   string    `gorm:"size:50"`
    CreatedAt  time.Time `gorm:"index"`
}
```

### 3.4 `casbin_rule`

由 Casbin GORM adapter 自动建表，A 阶段不写入策略。

## 4. 配置

`internal/config` 从环境变量加载，缺关键项 **fail-fast 退出**。

| 变量 | 说明 | 默认 |
|---|---|---|
| `DATABASE_URL` | PostgreSQL DSN | 无（必填）|
| `JWT_SECRET` | JWT 签名密钥 | 无（必填）|
| `MASTER_KEY` | AES-256 主密钥，base64 编码的 32 字节 | 无（必填）|
| `JWT_EXPIRY` | access token 有效期 | `2h` |
| `SERVER_PORT` | 监听端口 | `8080` |
| `ADMIN_USERNAME` | 自举管理员用户名 | `admin` |

**关键约束**：
- `MASTER_KEY` / `JWT_SECRET` 只来自环境变量，**绝不落库、不进日志**。
- 启动时校验 `MASTER_KEY` base64 解码后必须恰为 32 字节，否则拒绝启动。
- 缺任一必填项启动失败并打印清晰错误。

## 5. 核心模块

每个包单一职责、可独立测试。

1. **`crypto`** — `Encrypt(plain string) (string, error)` 返回 `base64(nonce‖ciphertext)`；`Decrypt(cipher string) (string, error)`。AES-256-GCM，每次随机 12 字节 nonce 前置。主密钥从 config 注入。
2. **`auth/password`** — `Hash(pwd string) (string, error)` bcrypt cost=12；`Verify(hash, pwd string) bool`。
3. **`auth/jwt`** — `Issue(userID uint, isAdmin bool) (string, error)`（claims 含 `user_id / is_admin / exp`）；`Parse(token string) (*Claims, error)`（校验签名 + 过期）。
4. **`database`** — 连 PG、`AutoMigrate` 三业务表 + 初始化 Casbin adapter；**admin 自举**：检测 `ok_users` 空 → 生成随机强密码（≥16 位）→ bcrypt 入库 → `IsAdmin=true, MustReset=true` → 明文随机密码**只打印到启动日志一次**。
5. **`middleware.JWTAuth`** — 取 `Authorization: Bearer <token>`，`jwt.Parse` 后注入 `user_id / is_admin` 到 `gin.Context`；失败返回 401。

## 6. API 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/healthz` | 无 | 存活 + DB ping |
| POST | `/api/v1/login` | 无 | 用户名+密码 → 返回 `{token, must_reset}` |
| POST | `/api/v1/change-password` | JWT | 校验旧密码 → 更新 → 清 `MustReset` |
| GET | `/api/v1/me` | JWT | 返回当前用户 `{id, username, is_admin, must_reset}` |

### 数据流（登录）

`POST /login` → 查用户 → `password.Verify` → `jwt.Issue` → 返回 token（若 `must_reset=true` 前端引导改密）→ 后续请求带 `Authorization: Bearer` → `JWTAuth` 中间件注入身份。

## 7. 错误处理

统一 JSON 响应体：`{"code": <int>, "message": <str>}`。

| HTTP | 场景 |
|---|---|
| 400 | 参数错误（缺字段、格式非法）|
| 401 | 未认证（无 token / token 无效或过期）|
| 403 | 预留（鉴权在子项目 C 实现）|
| 500 | 内部错误（DB 故障等）|

**安全约束**：登录失败统一返回「用户名或密码错误」，不区分用户是否存在（防用户名枚举）。

## 8. 测试策略（TDD，先写测试）

- **`crypto`**：加解密往返；错误密钥解密失败；相同明文两次密文不同（nonce 唯一性）。
- **`auth/password`**：hash 后 verify 通过；错误密码 verify 失败。
- **`auth/jwt`**：签发→解析往返；过期 token 拒绝；篡改 token 拒绝。
- **`database`**：空表自举建出 admin（IsAdmin=true, MustReset=true）；非空表不重复创建。
- **`handler`**：
  - login：正确密码返回 token；错误密码 401；`must_reset` 正确透传。
  - change-password：成功改密并清 `MustReset`；旧密码错误拒绝；未带 token 401。
  - me：带有效 token 返回当前用户；无 token 401。

## 9. 验收标准

1. `go build ./...` 通过，`go test ./...` 全绿。
2. 配置好 `.env` 后 `go run cmd/server/main.go` 能启动，`/healthz` 返回 200。
3. 首启自动创建 admin 并在日志打印随机初始密码（仅一次）。
4. 用 admin 初始密码可登录，返回的 `must_reset=true`；调用 change-password 改密后 `must_reset=false`。
5. 改密后用旧密码登录失败、新密码登录成功。
6. PostgreSQL 中存在 `ok_users` / `ok_clusters` / `ok_audit_logs` / `casbin_rule` 四张表。

## 10. 不在本 spec 范围（留给后续子项目）

- 集群连接池、client-go 多客户端、集群 CRUD（B）
- Casbin 鉴权 enforce、RBAC 中间件、权限指派、级联清理（C）
- 资源看板 API、NS 数据权限过滤、Secret reveal（D）
- WebSocket / WebSSH / 日志流（E）
- 前端全部页面（F）
- refresh token、登出/token 撤销（当前仅 access token）
