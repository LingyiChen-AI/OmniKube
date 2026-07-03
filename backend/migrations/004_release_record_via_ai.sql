-- 004_release_record_via_ai.sql
-- 2026-07-04 · OmniKube 发布记录 · 标记 AI 发布
-- 给 ok_release_records 增加 via_ai 列，显式区分「由 AI 助手确认执行的发布」，
-- 取代原先靠 comment 文案（"via OmniKube AI"）的脆弱判断。默认 false（手动发布）。

ALTER TABLE ok_release_records ADD COLUMN IF NOT EXISTS via_ai BOOLEAN DEFAULT FALSE;

-- 回填历史：此前 AI 发布靠固定注释标记，据此把历史行标为 true（幂等）。
UPDATE ok_release_records SET via_ai = TRUE WHERE via_ai IS NOT TRUE AND comment = 'via OmniKube AI';
