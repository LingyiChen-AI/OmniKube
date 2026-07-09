# OmniKube — 项目约定

多集群 Kubernetes 管理平台。后端 Go（Gin + GORM + Casbin，PostgreSQL），前端 React + TS + Vite + Ant Design。

## 数据库变更规范（重要）

**任何对数据库表结构的改动，都必须同时做两件事：**

1. **改模型 + 挂 AutoMigrate**：在 `backend/internal/model/model.go` 增改结构体，并确保它出现在 `backend/internal/database/database.go` 的 `Migrate()`（GORM `AutoMigrate`）列表里。运行时以此自动建表/加列。

2. **新增一个迁移文件**：在 `backend/migrations/` 下按编号顺序新增一个 SQL 文件,作为可版本化、可人读的变更记录（并可用于不走 AutoMigrate 的手工部署）。

### 迁移文件规范

- 命名：`NNN_<简短描述>.sql`，`NNN` 为三位零填充递增序号（`001`、`002`…），紧接本目录已有的最大序号往后排。例：`004_xxx.sql`。
- 方言：PostgreSQL DDL。
- **必须幂等**：`CREATE TABLE IF NOT EXISTS`、`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`、`DROP TABLE IF EXISTS` 等。
- 文件头注释写清：**日期、所属功能、改了什么、为什么**。
- 一次逻辑变更一个文件（新增表、加列、删表分开），不要把无关变更塞进同一个文件。
- 删除/重命名列属破坏性变更，需在注释中显著标注，并谨慎处理已有数据。
- 类型对照（GORM → PostgreSQL）：`uint` 主键→`BIGSERIAL`；`uint`/`int`→`BIGINT`；`bool`→`BOOLEAN`；`float64`→`DECIMAL`；`string gorm:"type:text"`→`TEXT`；`string gorm:"size:N"`→`VARCHAR(N)`；`time.Time`→`TIMESTAMPTZ`。GORM 默认索引名为 `idx_<表>_<列>`。

改完后更新 `backend/migrations/README.md` 末尾的「当前迁移」表。

## Git 提交规范（强制）

- **禁止**在 commit message（以及 PR / tag 说明）中添加任何 `Co-Authored-By:` 尾注，尤其是 `Co-Authored-By: Claude ...`。提交信息里不得出现 Claude / AI 署名。
- 提交信息用 Conventional Commits 前缀（`feat:` / `fix:` / `docs:` / `chore:` 等），正文用中文说明改了什么、为什么。

## 常用校验

- 后端：`cd backend && go build ./... && go test ./...`
- 前端：`cd frontend && npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && npm run build`
- i18n：新增文案要在 7 个语言文件（`frontend/src/i18n/locales/{zh,en,ja,ko,fr,de,es}.ts`）里同步补齐。
