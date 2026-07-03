-- 003_drop_ai_grants.sql
-- 2026-07-04 · OmniKube AI 助手 · 权限模型简化
-- 移除「每集群 AI 授予矩阵」表：AI 权限改为一律跟随发起用户自身 RBAC，不再单独配置。
-- 中间版本曾创建过 ok_ai_grants，此处幂等清理（应用启动时 GORM 迁移也会 DropTable）。

DROP TABLE IF EXISTS ok_ai_grants;
