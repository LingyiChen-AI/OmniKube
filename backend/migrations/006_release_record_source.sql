-- 006_release_record_source.sql
-- 2026-07-04 · 集成部署 · 给 ok_release_records 增加 source 列
-- 集成部署一次发布只写一条发布记录(而非逐资源一条),需要与普通单资源发布区分展示,
-- 增加 source 列标记记录来源:'resource'(默认,单资源发布) / 'integrated_deploy'(集成部署)。

ALTER TABLE ok_release_records ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'resource';
