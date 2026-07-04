-- 005_integrated_deploy.sql
-- 日期: 2026-07-04
-- 功能: 集成部署 (Integrated Deployment)
-- 改了什么: 新增工单表 ok_deploy_orders 与发布历史表 ok_deploy_order_runs
-- 为什么: 支持把一组 k8s 资源打包成工单、按固定顺序一次性发布并留历史

CREATE TABLE IF NOT EXISTS ok_deploy_orders (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT,
    username    VARCHAR(50),
    cluster_id  VARCHAR(50),
    namespace   VARCHAR(100),
    title       VARCHAR(200),
    description TEXT,
    items       TEXT,
    status      VARCHAR(20) DEFAULT 'draft',
    created_at  TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ok_deploy_orders_user_id ON ok_deploy_orders (user_id);
CREATE INDEX IF NOT EXISTS idx_ok_deploy_orders_cluster_id ON ok_deploy_orders (cluster_id);

CREATE TABLE IF NOT EXISTS ok_deploy_order_runs (
    id         BIGSERIAL PRIMARY KEY,
    order_id   BIGINT,
    user_id    BIGINT,
    username   VARCHAR(50),
    status     VARCHAR(20),
    results    TEXT,
    created_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ok_deploy_order_runs_order_id ON ok_deploy_order_runs (order_id);
CREATE INDEX IF NOT EXISTS idx_ok_deploy_order_runs_created_at ON ok_deploy_order_runs (created_at);
