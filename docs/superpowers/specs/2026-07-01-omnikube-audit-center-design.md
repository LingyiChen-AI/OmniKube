# 子项目 A — 审计中心(Audit Center)设计

> 日期:2026-07-01 · P0-1 · 依赖:已有 `ok_audit_logs` 表、authed 中间件链

## 目标

把「谁 / 何时 / 在哪个集群+命名空间 / 对什么资源 / 做了什么 / 成功失败 / 来源 IP」这类写操作统一落审计,并提供查询页与 CSV 导出。当前审计仅覆盖 Secret 揭示且无查询界面,本子项目补齐。

## 非目标

- 不做读操作(GET/list)审计(噪音大、价值低)。
- 不做审计日志的告警/订阅(留待通知子系统)。
- 不改 `ok_audit_logs` schema(字段已足够)。

## 架构

### 1. 审计中间件(自动埋点)

新增 `backend/internal/middleware/audit.go`:

```
func Audit(db *gorm.DB) gin.HandlerFunc
```

- 挂在 `authed` 组上(在 auth 之后,故 `user_id` 已就绪)。
- 仅对写方法 `POST/PUT/DELETE` 生效;`GET`/`HEAD`/`OPTIONS` 直接跳过。
- 在 `c.Next()` **之后**读取:
  - `UserID` ← `c.GetUint("user_id")`(转字符串)。
  - `ClusterID` ← `X-Cluster-ID` 头。
  - `Namespace` ← `c.Param("namespace")`,回退 `c.GetString("auth_namespace")`。
  - `Resource` ← `c.Param("resource")`,回退 `c.GetString("auth_resource")`;资源型端点若无则用路由分组名(users/roles/clusters)。
  - `Target` ← `c.Param("name")` 回退 `c.Param("id")`。
  - `Action` ← `deriveAction(method, path)`(见下)。
  - `Result` ← 状态码映射:`2xx→success`、`403→denied`、其余→`failed`。
  - `SourceIP` ← `c.ClientIP()`。
- 写入用现成 `audit.Log`(非阻断)。

**deriveAction(method, path)**:先按末段特殊动词覆盖,再回退方法映射。
- 末段命中 → 用该动词:`scale/restart/rollback/reset-password/disable/enable/roles/reveal/test`。
- 否则:`POST→create`、`PUT→update`、`DELETE→delete`。

### 2. 登录审计

登录路由在 authed 之外(无 user_id)。在 `Login` handler 内显式记一条:
- 成功:`Action=login, Result=success, UserID=<id>, Target=<username>`。
- 失败(账号/密码错、禁用):`Action=login, Result=failed, Target=<尝试的用户名>`。
- Secret 揭示保持现有显式审计不变(避免重复,中间件对 reveal 端点跳过——通过在 reveal 路由不套 Audit,或 deriveAction 允许重复但 reveal 已有专门 allow/deny 记录;取简单方案:中间件对 `POST .../reveal` 跳过)。

### 3. 查询 API

`backend/internal/handler/audit.go`,权限门控 `RequireGlobalPerm("audit","view")`:

- `GET /api/v1/audit-logs` — 过滤参数(全部可选):`user_id、action、resource、cluster_id、namespace、result、from、to(RFC3339)、limit(默认50)、offset`。返回 `{ logs: [...], total: N }`(带总数用于分页)。按 `created_at desc`。
- `GET /api/v1/audit-logs/export` — 同过滤,忽略分页,`Content-Type: text/csv`,流式写出表头 + 行。文件名 `audit-<date>.csv`。

### 4. 权限模型扩展

全局权限新增 `audit` 域(仅 `view` 动作):
- 后端 `GlobalPermCheck` 已是通用 area/action 查询,无需改逻辑;需在**预置角色**里给 admin / 新增「审计员(auditor)」角色 `audit:view`,并在前端权限矩阵的 area 列表加入 `audit`。
- 预置角色新增 `auditor`(Key=`auditor`):仅 `audit:view` + `releases:view`。i18n 角色名/描述补 7 语。

### 5. 前端

- `frontend/src/api/audit.ts`:`list(params)`、`exportUrl(params)`(拼 query,走浏览器下载或 client blob)。
- `frontend/src/pages/audit/AuditLogs.tsx`:筛选栏(用户、动作 Select、资源、集群 Select、命名空间、结果 Select、日期范围 RangePicker)+ AntD Table(分页,server-side)+ 导出按钮。
- 侧边栏「系统管理」下加「审计日志」入口,按 `audit:view` 能力显示(参照现有 capability 门控)。
- i18n:`audit.*` key 补齐 7 语。

## 数据流

写请求 → authed 链(auth→...→handler)→ 中间件 `c.Next()` 后埋点 → `audit.Log` 落 `ok_audit_logs`。
查询页 → `GET /audit-logs?filters` → handler 组 where + 分页 → 表格渲染。

## 测试

- `middleware/audit_test.go`:写方法记录、读方法跳过、action 派生(create/update/delete/scale/...)、result 由状态码映射、reveal 跳过。
- `handler/audit_test.go`:过滤(user/action/result/time)、分页 total、CSV 导出表头与行数、权限门控(无 audit:view → 403,admin 旁路)。
- 现有 `TestListRoles`/`TestSeedPresetRoles` 预置角色数 +1(auditor),更新断言。

## 验收

- 任意用户对资源做 create/update/delete/scale/restart/rollback/改权限/登录,审计页可查到对应行。
- 过滤 + 分页 + CSV 导出可用。
- 非授权用户看不到审计入口、访问 API 得 403。
- 前端 tsc/lint/test/build 全绿;后端 `go test ./...` 全绿。
