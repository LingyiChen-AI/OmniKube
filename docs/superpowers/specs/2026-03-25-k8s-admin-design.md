# K8s Admin 管理系统设计文档

## 概述

基于 Next.js 的多集群 Kubernetes 管理系统，支持用户管理、集群管理、K8s 原生资源操作、应用模板发布、细粒度 RBAC 权限控制和完整审计日志。

## 系统架构

Next.js 全栈单体架构，WebSocket 通过独立 Node.js 进程处理。

```
Browser (Ant Design) ──HTTP/REST──→ Next.js App Router ──→ PostgreSQL
                     ──WebSocket──→ WS Server (ws)     ──→ K8s API Server(s)
```

### 核心组件

- **Next.js App Router** — 前端页面 + API 路由
- **WS Server** — 独立 Node.js 进程，处理 Pod 日志流、事件监听、资源状态变更推送
- **PostgreSQL** — 用户、集群配置、权限、审计日志、应用模板等持久化数据
- **K8sClientManager** — 使用 `@kubernetes/client-node`，按集群动态创建和缓存连接

### 数据流向

- **查看资源** → 前端 → API Route → K8s API → 实时返回（不经数据库）
- **操作资源** → 前端 → API Route → K8s API + 写 audit_logs
- **模板发布** → 前端 → API Route → 渲染模板 → K8s API + 写 app_releases + audit_logs
- **权限检查** → 每次 API 请求 → middleware 查 user_role_bindings + role_permissions

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | Next.js 15 App Router + Ant Design 5 + ahooks |
| 后端 | Next.js API Routes + @kubernetes/client-node |
| 实时 | ws 库（独立进程） |
| ORM | Drizzle ORM + drizzle-kit |
| 数据库 | PostgreSQL 16 |
| 认证 | HTTP-only cookie session |
| 邮件 | nodemailer (SMTP) |
| 部署 | Docker Compose |

## 安全设计

### 凭证加密

集群凭证（kubeconfig、sa_token）使用 AES-256-GCM 加密后存入数据库。加密密钥通过环境变量 `ENCRYPTION_KEY` 注入（32 字节 hex 字符串）。首次部署时由 seed 脚本自动生成并输出到控制台。不支持密钥轮换（MVP 阶段）。

### 认证安全

- **速率限制**：登录接口限制每 IP 每分钟 5 次请求；邮箱验证码发送限制每邮箱每分钟 1 次
- **验证码防爆破**：同一验证码最多 3 次错误尝试后自动失效
- **账户锁定**：连续 5 次密码错误后锁定账户 15 分钟
- **CSRF 防护**：session cookie 设置 `SameSite=Lax` + `HttpOnly` + `Secure`（生产环境）

### TLS

Docker Compose 部署时，通过前置 nginx 反向代理提供 TLS 终结。开发环境可直连 HTTP。

## 数据库模型

K8s 资源状态全部从 K8s API 实时查询，数据库不存储资源状态副本。

### 索引策略

- `email_verifications`: INDEX on `(email, purpose, used)`
- `user_role_bindings`: UNIQUE on `(user_id, role_id, cluster_id, namespace)`
- `role_permissions`: UNIQUE on `(role_id, resource)`
- `audit_logs`: INDEX on `(created_at)`, 按月分区
- `sessions`: INDEX on `(expires_at)` 用于定期清理

### users

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | |
| username | VARCHAR UNIQUE | |
| email | VARCHAR UNIQUE | |
| password_hash | VARCHAR | bcrypt 哈希 |
| must_change_password | BOOLEAN default true | 首次登录强制改密 |
| is_active | BOOLEAN default true | |
| last_login_at | TIMESTAMP | |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

### email_verifications

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | |
| email | VARCHAR | |
| code | VARCHAR(6) | 6位数字验证码 |
| purpose | ENUM(login, reset) | |
| expires_at | TIMESTAMP | 5分钟过期 |
| used | BOOLEAN default false | |
| created_at | TIMESTAMP | |

### sessions

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | |
| user_id | FK → users | |
| token | VARCHAR UNIQUE | |
| ip_address | VARCHAR | |
| user_agent | TEXT | |
| expires_at | TIMESTAMP | 默认24小时 |
| created_at | TIMESTAMP | |

### clusters

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | |
| name | VARCHAR UNIQUE | 集群标识 |
| display_name | VARCHAR | 显示名 |
| api_server_url | VARCHAR | |
| auth_type | ENUM(kubeconfig, token) | |
| kubeconfig | TEXT ENCRYPTED | 加密存储 |
| sa_token | TEXT ENCRYPTED | 加密存储 |
| ca_cert | TEXT | |
| status | ENUM(connected, disconnected, error) | |
| last_health_check_at | TIMESTAMP | 最近一次健康检查时间 |
| description | TEXT | |
| created_by | FK → users | |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

### roles

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | |
| name | VARCHAR UNIQUE | |
| display_name | VARCHAR | |
| description | TEXT | |
| is_system | BOOLEAN | 内置角色不可删除 |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

### role_permissions

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | |
| role_id | FK → roles | |
| resource | VARCHAR | pods, deployments, services, configmaps, secrets, ingresses, namespaces, nodes 等 |
| actions | VARCHAR[] | get, list, create, update, delete, exec, logs |
| created_at | TIMESTAMP | |

### user_role_bindings

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | |
| user_id | FK → users | |
| role_id | FK → roles | |
| cluster_id | FK → clusters, nullable | null 表示全局绑定 |
| namespace | VARCHAR, nullable | null 表示所有命名空间 |
| created_by | FK → users | |
| created_at | TIMESTAMP | |

### app_templates

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | |
| name | VARCHAR UNIQUE | |
| version | INTEGER default 1 | 模板版本号，更新时创建新版本（新行） |
| description | TEXT | |
| template | JSONB | Deployment + Service + Ingress + ConfigMap 等资源定义 |
| variables | JSONB | 可替换变量定义（image, replicas, port, domain 等） |
| created_by | FK → users | |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

注：模板更新采用追加新版本策略（name 相同，version 递增），旧版本保留不可变。UNIQUE 约束在 `(name, version)` 上。

### app_releases

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | |
| app_template_id | FK → app_templates | |
| cluster_id | FK → clusters | |
| namespace | VARCHAR | |
| name | VARCHAR | 发布名 |
| values | JSONB | 填入的变量值 |
| rendered_manifests | JSONB | 实际下发的完整 YAML |
| status | ENUM(pending, applied, failed, rolled_back) | |
| revision | INTEGER | |
| released_by | FK → users | |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

#### 应用发布与回滚策略

- 发布时：渲染模板 → 按顺序 apply 每个资源 → 若某个资源失败，标记 status=failed，已创建的资源不自动回退（记录到 rendered_manifests 中哪些成功哪些失败）
- 回滚时：创建新的 app_release 记录（revision+1），使用目标版本的 rendered_manifests 重新 apply，status 标记为 rolled_back 的是原记录

### audit_logs

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | |
| user_id | FK → users | |
| action | VARCHAR | create, update, delete, login, logout 等 |
| resource_type | VARCHAR | user, cluster, deployment, service, configmap, pod 等 |
| resource_name | VARCHAR | |
| cluster_id | FK → clusters, nullable | |
| namespace | VARCHAR, nullable | |
| request_method | VARCHAR | |
| request_path | VARCHAR | |
| request_body | JSONB | |
| response_status | INTEGER | |
| ip_address | VARCHAR | |
| user_agent | TEXT | |
| created_at | TIMESTAMP | 按月分区 |

### 审计日志保留策略

- 按 `created_at` 月份分区存储
- 默认保留 90 天，超期数据自动清理（定时任务 DROP 过期分区）
- 后续可扩展支持导出到对象存储归档

## 认证设计

### 登录方式

1. **账号密码** — 输入用户名+密码 → 校验 → 生成 session token → 检查 must_change_password
2. **邮箱验证码** — 输入邮箱 → 发送6位验证码(5分钟过期) → 校验 → 生成 session token → 检查 must_change_password

### 首次部署

Docker Compose 启动时 seed 脚本自动执行：
- 生成随机密码，创建 admin 用户（super-admin 角色）
- must_change_password = true
- 控制台输出 admin 密码
- 首次登录后强制跳转改密页面

### Session 管理

- HTTP-only cookie 存储 session token
- 默认 24 小时过期，可配置
- 支持多设备同时登录
- 登出时删除 session 记录
- 定期清理过期 session（每小时执行 `DELETE FROM sessions WHERE expires_at < now()`）

## RBAC 权限设计

### 权限检查流程

1. Auth Middleware：cookie 中取 token → 查 sessions → 获取 user
2. RBAC Middleware：
   - 解析请求：clusterId + namespace + resource + action
   - 查询 user_role_bindings（匹配 user_id）
   - 收集所有匹配的绑定：全局绑定（cluster_id=null）、集群级绑定（cluster_id=X, namespace=null）、命名空间级绑定（cluster_id=X, namespace=Y）
   - 权限为纯加法模型（union）：合并所有匹配角色的 role_permissions，不支持 deny 规则
   - 检查合并后的权限集是否包含所需的 resource + action
3. Audit Middleware：记录操作到 audit_logs
4. Handler：执行业务逻辑

### 内置角色

| 角色 | 资源范围 | 权限 |
|------|---------|------|
| super-admin | 全局 | 所有资源所有操作 + 用户/角色管理 |
| cluster-admin | 指定集群 | 集群内所有资源所有操作 |
| developer | 指定集群+NS | deployments/services/configmaps/pods 的 CRUD + logs |
| viewer | 指定集群+NS | 所有资源的 get/list |

## 页面结构

### 布局

Ant Design ProLayout：深色侧边栏 + 顶部栏（集群切换器 + 通知 + 用户菜单）。

顶部集群切换器为全局选择器，所有资源页面跟随当前选中的集群。

### 侧边栏导航

- **Dashboard** — 概览（集群数/Pod 数/Deployment 数/今日发布、最近事件、集群状态）
- **集群资源**
  - Namespaces
  - Workloads：Deployments / StatefulSets / DaemonSets / Jobs+CronJobs / Pods
  - Networking：Services / Ingresses
  - Config：ConfigMaps / Secrets
  - Storage：PV+PVC / StorageClasses
- **应用发布**
  - 应用模板（列表 + 创建）
  - 发布记录（列表 + 新建发布）
- **系统管理**
  - 用户管理
  - 角色管理
  - 集群管理
  - 审计日志

### 路由结构

```
app/
├── (auth)/
│   ├── login/page.tsx              # 登录页
│   └── change-password/page.tsx    # 首次登录改密
├── (dashboard)/
│   ├── layout.tsx                  # ProLayout
│   ├── page.tsx                    # Dashboard 概览
│   ├── clusters/                   # 集群管理
│   ├── resources/
│   │   ├── namespaces/
│   │   ├── workloads/              # deployments, statefulsets, daemonsets, jobs, pods
│   │   ├── networking/             # services, ingresses
│   │   ├── config/                 # configmaps, secrets
│   │   └── storage/                # pvcs, storageclasses
│   ├── apps/
│   │   ├── templates/              # 应用模板
│   │   └── releases/               # 发布记录
│   └── admin/
│       ├── users/                  # 用户管理
│       ├── roles/                  # 角色管理
│       └── audit/                  # 审计日志
└── api/
    ├── auth/                       # 登录/登出/验证码/改密
    ├── clusters/                   # 集群 CRUD + 连接测试
    ├── k8s/[clusterId]/            # K8s API 代理层
    ├── apps/                       # 模板 + 发布
    ├── admin/                      # 用户/角色管理
    └── audit/                      # 审计日志查询
```

## WebSocket 实时推送

独立进程（ws-server.ts），使用独立的数据库连接池（与 Next.js 共享相同的数据库配置）。

### 订阅频道

- `pod-logs:{clusterId}:{namespace}:{podName}:{container}` — Pod 日志流
- `events:{clusterId}:{namespace}` — K8s 事件流
- `resource-watch:{clusterId}:{namespace}:{resourceType}` — 资源状态变更

### 实现

- 连接时验证 session token
- **每次订阅时执行 RBAC 权限检查**（与 API 相同的 cluster + namespace + resource + action 检查），无权限则拒绝订阅并返回错误消息
- 使用 @kubernetes/client-node Watch API
- 每个集群维护一个 K8s watch 连接池
- 心跳检测 30s，断线自动重连

## K8s 连接管理

K8sClientManager 单例模式：

- 缓存 `Map<clusterId, KubeConfig>`
- `getClient(clusterId)` 从 DB 读集群配置，创建或复用 KubeConfig
- 定时健康检查 60s，更新 clusters.status 和 `last_health_check_at` 字段
- 前端展示时若 `last_health_check_at` 超过 2 分钟，显示状态为"未知"
- 连接失败时自动重试 + 状态标记为 error

## 部署

Docker Compose 三个服务：

```yaml
services:
  app:    # Next.js (端口 3000)
  ws:     # WebSocket Server (端口 3001)
  db:     # PostgreSQL 16 (端口 5432)
```

app 启动时自动运行 migrate + seed。

## 项目目录结构

```
k8s-admin/
├── src/
│   ├── app/                        # Next.js App Router
│   │   ├── (auth)/                 # 登录、改密页面
│   │   ├── (dashboard)/            # 主布局 + 所有业务页面
│   │   └── api/                    # API Routes
│   ├── lib/
│   │   ├── db/
│   │   │   ├── schema.ts           # Drizzle schema 定义
│   │   │   ├── migrate.ts          # 迁移脚本
│   │   │   └── seed.ts             # 初始化 admin + 内置角色
│   │   ├── k8s/
│   │   │   ├── client-manager.ts   # K8s 连接管理器
│   │   │   └── resources.ts        # K8s 资源操作封装
│   │   ├── auth/
│   │   │   ├── session.ts          # Session 管理
│   │   │   └── email.ts            # 邮箱验证码发送
│   │   ├── rbac/
│   │   │   └── check.ts            # 权限检查逻辑
│   │   └── audit/
│   │       └── logger.ts           # 审计日志记录
│   ├── middleware.ts                # Next.js middleware (auth + RBAC)
│   └── ws-server.ts                # WebSocket 独立进程入口
├── drizzle/                        # Drizzle 迁移文件
├── docker-compose.yml
├── Dockerfile
├── .env.example
└── package.json
```
