# 数据库迁移（migrations）

本目录以**编号顺序**记录 OmniKube 的数据库结构变更，每个变更一个文件：

```
NNN_<简短描述>.sql      # 例：001_ai_assistant_tables.sql
```

- `NNN`：三位零填充的递增序号（001、002…），决定应用顺序。
- 内容：PostgreSQL DDL，**必须幂等**（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `DROP TABLE IF EXISTS`）。
- 文件头注释写清：日期、所属功能、做了什么、为什么。

## 与 GORM AutoMigrate 的关系

运行时应用通过 `internal/database.Migrate`（GORM AutoMigrate）自动建表/加列，
**这些 SQL 文件是可版本化、可人读的等价记录**，用途：

1. 变更历史与评审依据（一眼看清每次发布改了哪些表/列）；
2. 供不使用 AutoMigrate 的环境手工应用；
3. 需要回滚/数据修复时的参考。

因此：**改了 `internal/model` 里的表结构，就要同步在此新增一个迁移文件**，
并把对应模型加入 `Migrate` 的 AutoMigrate 列表。详见根目录 `CLAUDE.md`。

## 当前迁移

| 序号 | 文件 | 变更 |
|----|------|------|
| 001 | `001_ai_assistant_tables.sql` | 新增 `ok_ai_config` / `ok_ai_conversations` / `ok_ai_messages` |
| 002 | `002_ai_message_confirm_result.sql` | `ok_ai_messages` 增加 `confirm_result` 列 |
| 003 | `003_drop_ai_grants.sql` | 删除废弃的 `ok_ai_grants`（AI 权限改为跟随用户 RBAC） |
| 004 | `004_release_record_via_ai.sql` | `ok_release_records` 增加 `via_ai` 列（区分 AI 发布），并回填历史 |
| 005 | `005_integrated_deploy.sql` | 集成部署工单表 ok_deploy_orders + 发布历史表 ok_deploy_order_runs |
| 006 | `006_release_record_source.sql` | `ok_release_records` 增加 `source` 列（区分集成部署发布 vs 单资源发布） |
