# 子项目 A — 审计中心 实现计划

> **执行方式:** 内联执行(inline)。任务级粒度,每个任务自带文件清单、要点、验证命令。TDD:先测后码,任务末提交。

**Goal:** 全写操作自动落审计 + 审计查询页 + CSV 导出 + audit 权限域 + auditor 预置角色。

**Architecture:** 审计中间件在 authed 链尾部对写方法埋点;登录在 handler 显式记;查询/导出 handler 走 GORM 过滤分页;前端新增审计页 + 侧栏入口。

**Tech Stack:** Go/Gin/GORM;React/AntD/i18next。

---

### Task A1: 审计中间件
- Create: `backend/internal/middleware/audit.go`
- Test: `backend/internal/middleware/audit_test.go`
- 要点:`Audit(db) gin.HandlerFunc`;仅 POST/PUT/DELETE;`c.Next()` 后埋点;`deriveAction(method, fullPath/last-seg)`;result 由 `c.Writer.Status()` 映射(2xx=success/403=denied/else=failed);跳过 `.../reveal`(已有专门审计)。
- 测试:写方法记录一行、GET 不记、action 派生(create/update/delete/scale/restart/rollback/roles/disable)、result 映射、reveal 跳过。
- 验证:`cd backend && go test ./internal/middleware/ -run Audit -v`
- 提交。

### Task A2: 登录审计 + 挂载中间件
- Modify: `backend/internal/handler/auth.go`(Login 内成功/失败各记一条 `audit.Log`,action=login)
- Modify: `backend/internal/router/router.go`(authed 组 `Use(middleware.Audit(h.DB))`)
- 测试:`handler/auth_test.go` 断言登录成功/失败各产生一条 login 审计。
- 验证:`go test ./internal/handler/ -run Login -v`
- 提交。

### Task A3: 权限域 audit + auditor 预置角色
- Modify: 全局权限 area 列表(后端 seed/校验处 + 前端矩阵 area 常量)加 `audit`。
- Modify: `backend/internal/database/database.go`(或 seed 处)新增预置角色 `auditor`(Key=auditor,GlobalPerms `{"audit":["view"],"releases":["view"]}`)。
- Modify: 现有 `TestListRoles`/`TestSeedPresetRoles` 预置数 +1、加 auditor 断言。
- 验证:`go test ./internal/... -run Role -v`
- 提交。

### Task A4: 查询 + 导出 handler + 路由
- Create: `backend/internal/handler/audit.go`(`ListAuditLogs`、`ExportAuditLogs`)
- Test: `backend/internal/handler/audit_test.go`
- Modify: `router.go` 加 `GET /audit-logs`、`GET /audit-logs/export`(`RequireGlobalPerm("audit","view")`)
- 要点:过滤 user_id/action/resource/cluster_id/namespace/result/from/to;limit(50)/offset;返回 `{logs,total}`;导出 CSV 流。
- 测试:过滤、分页 total、CSV 行数、403 门控、admin 旁路。
- 验证:`go test ./internal/handler/ -run Audit -v`
- 提交。

### Task A5: 前端 API + 审计页 + 侧栏 + i18n
- Create: `frontend/src/api/audit.ts`、`frontend/src/pages/audit/AuditLogs.tsx`
- Modify: 路由注册、侧栏菜单(`audit:view` 能力门控)、7 语 locale 加 `audit.*`。
- 验证:`cd frontend && npx tsc --noEmit && npm run lint && npm test && npm run build`
- 提交。

---

## Self-Review
- 覆盖 spec:中间件✓ 登录✓ 查询/导出✓ 权限域✓ auditor✓ 前端页/侧栏/i18n✓。
- 无占位符:各任务有文件+验证命令。
- 类型一致:`Audit`/`deriveAction`/`ListAuditLogs`/`ExportAuditLogs` 全程一致。
