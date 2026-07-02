# OmniKube Backend

多集群多租户 Kubernetes 管控平台的后端。Go module = `omnikube`。

当前进度：**子项目 A（后端地基）** —— 配置加载、AES-256-GCM 加密、bcrypt、JWT 认证、GORM 数据模型、admin 自举、登录/改密/查当前用户。

## 目录结构

```
backend/
├── cmd/server/main.go      # 入口: 配置→连库→迁移→admin自举→启动
└── internal/
    ├── config/     # 环境变量加载 + 校验
    ├── crypto/     # AES-256-GCM 加解密
    ├── auth/       # bcrypt + JWT
    ├── model/      # GORM 模型 (ok_users / ok_clusters / ok_audit_logs / casbin_rule)
    ├── database/   # 连库 / 迁移 / admin 自举
    ├── middleware/ # JWT 认证中间件
    ├── handler/    # healthz / login / change-password / me
    └── router/     # 路由注册
```

## 本地运行

1. 启动 PostgreSQL（示例用 docker，映射到 5433 避免与本机 5432 冲突）：
   ```bash
   docker run -d --name omnikube-pg \
     -e POSTGRES_USER=omnikube -e POSTGRES_PASSWORD=omnikube -e POSTGRES_DB=omnikube \
     -p 5433:5432 postgres:16
   ```
2. 准备 `.env`：
   ```bash
   cp .env.example .env
   # 编辑 .env，填入 DATABASE_URL（端口 5433）、JWT_SECRET，并生成主密钥：
   #   MASTER_KEY=$(openssl rand -base64 32)
   ```
3. 启动：
   ```bash
   go run cmd/server/main.go
   ```
   首次启动会创建 admin 并在日志打印初始随机密码（仅一次）。
4. 登录：`POST /api/v1/login`（首登返回 `must_reset=true`），随后 `POST /api/v1/change-password` 改密。

## API（子项目 A）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/healthz` | 无 | 存活 + DB ping |
| POST | `/api/v1/login` | 无 | 登录，返回 `{token, must_reset}` |
| POST | `/api/v1/change-password` | JWT | 校验旧密码 → 改密 → 清 `must_reset` |
| GET | `/api/v1/me` | JWT | 当前用户信息 |

## 测试

```bash
go test ./...
```

单元测试用内存 SQLite（`glebarez/sqlite`，纯 Go），无需真实 PostgreSQL。
