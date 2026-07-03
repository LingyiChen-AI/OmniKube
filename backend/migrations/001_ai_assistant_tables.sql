-- 001_ai_assistant_tables.sql
-- 2026-07-04 · OmniKube AI 助手（feat/ai-assistant）
-- 新增 AI 助手的模型配置、会话与消息三张表。
-- 说明：运行时由 GORM AutoMigrate 自动建表，此文件为可版本化的等价 DDL 记录，
--       也可用于不走 AutoMigrate 的手工部署。全部幂等（IF NOT EXISTS）。

-- 模型配置（全局一行）。api_key 以 AES-256-GCM 加密后存 api_key_enc。
CREATE TABLE IF NOT EXISTS ok_ai_config (
    id            BIGSERIAL PRIMARY KEY,
    enabled       BOOLEAN,
    base_url      TEXT,
    api_key_enc   TEXT,
    model_id      VARCHAR(200),
    temperature   DECIMAL,
    system_prompt TEXT,
    max_steps     BIGINT,
    updated_at    TIMESTAMPTZ
);

-- 会话：隶属某用户、针对某集群。
CREATE TABLE IF NOT EXISTS ok_ai_conversations (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL,
    cluster_id VARCHAR(50),
    title      VARCHAR(200),
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ok_ai_conversations_user_id ON ok_ai_conversations (user_id);
CREATE INDEX IF NOT EXISTS idx_ok_ai_conversations_updated_at ON ok_ai_conversations (updated_at);

-- 消息：role=user/assistant/tool；tool_calls 为工具轨迹 JSON；
-- pending_action 为暂存写操作 JSON（[]StagedAction），保留以便重载重建确认卡片。
CREATE TABLE IF NOT EXISTS ok_ai_messages (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL,
    role            VARCHAR(20) NOT NULL,
    content         TEXT,
    tool_calls      TEXT,
    pending_action  TEXT,
    created_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ok_ai_messages_conversation_id ON ok_ai_messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_ok_ai_messages_created_at ON ok_ai_messages (created_at);
