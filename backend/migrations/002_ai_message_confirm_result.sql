-- 002_ai_message_confirm_result.sql
-- 2026-07-04 · OmniKube AI 助手 · 写操作确认结局持久化
-- 给 ok_ai_messages 增加 confirm_result 列：记录该提案的确认结局，供重载会话时
-- 重建「已解决的确认卡片」。空串=尚待确认；JSON {status:"running|done|cancelled", text}。
-- 同时用作原子认领的抢占标记（'' → 'running'），杜绝并发双执行。

ALTER TABLE ok_ai_messages ADD COLUMN IF NOT EXISTS confirm_result TEXT;
