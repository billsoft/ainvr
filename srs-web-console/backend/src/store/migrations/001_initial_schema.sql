-- 001_initial_schema.sql — 统一配置中心初始 schema
-- PostgreSQL 16+，所有表均带 created_at / updated_at 审计字段
-- 配置文档、版本、变更明细、服务应用状态、审计日志、敏感值加密存储

-- ===== 配置文档：每个服务/分组的当前草稿和已发布 JSONB =====
CREATE TABLE IF NOT EXISTS config_documents (
    id BIGSERIAL PRIMARY KEY,
    service VARCHAR(64) NOT NULL,    -- backend / channels / ai-service / recorder / srs
    "group" VARCHAR(64) NOT NULL DEFAULT 'default',  -- 分组细分，如 ai-service/channels/xxx
    name VARCHAR(128) NOT NULL,       -- 配置项名称，如 system / channel-xxx
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (service, "group", name)
);
CREATE INDEX IF NOT EXISTS idx_config_documents_service ON config_documents(service);

-- ===== 配置版本：每次发布生成一个版本，可回滚 =====
CREATE TABLE IF NOT EXISTS config_versions (
    id BIGSERIAL PRIMARY KEY,
    version INTEGER NOT NULL,          -- 递增版本号 v1, v2...
    status VARCHAR(16) NOT NULL DEFAULT 'draft',  -- draft / published / archived
    published_by VARCHAR(64),          -- 操作者，目前只有 admin，以后可扩展
    published_at TIMESTAMPTZ,
    change_summary TEXT,               -- 本次变更说明
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (version)
);
CREATE INDEX IF NOT EXISTS idx_config_versions_status ON config_versions(status);

-- ===== 配置快照：每个版本的全量配置快照（用于回滚和 diff） =====
CREATE TABLE IF NOT EXISTS config_snapshots (
    id BIGSERIAL PRIMARY KEY,
    version_id BIGINT NOT NULL REFERENCES config_versions(id) ON DELETE CASCADE,
    service VARCHAR(64) NOT NULL,
    "group" VARCHAR(64) NOT NULL DEFAULT 'default',
    name VARCHAR(128) NOT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_config_snapshots_version ON config_snapshots(version_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_snapshots_unique
    ON config_snapshots(version_id, service, "group", name);

-- ===== 服务应用状态：每个服务的实际 applied 版本 =====
CREATE TABLE IF NOT EXISTS config_service_states (
    id BIGSERIAL PRIMARY KEY,
    service_name VARCHAR(64) NOT NULL UNIQUE,  -- backend / ai-service / recorder / srs
    applied_version INTEGER,                    -- 实际应用的版本号
    desired_version INTEGER,                    -- 期望版本号
    status VARCHAR(24) NOT NULL DEFAULT 'unknown',  -- pending / applied / partial / failed / unknown
    restart_required BOOLEAN NOT NULL DEFAULT FALSE,
    error_message TEXT,
    applied_at TIMESTAMPTZ,
    last_check_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== 审计日志：谁什么时候改了什么 =====
CREATE TABLE IF NOT EXISTS config_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor VARCHAR(64) NOT NULL DEFAULT 'admin',
    action VARCHAR(32) NOT NULL,     -- create / update / publish / rollback / delete / import / export
    service VARCHAR(64),
    "group" VARCHAR(64),
    config_name VARCHAR(128),
    version_before INTEGER,
    version_after INTEGER,
    detail JSONB,                   -- 详细变更内容（摘要，不含敏感值明文）
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON config_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON config_audit_logs(action);

-- ===== 敏感值加密存储：单独一张表，与配置文档解耦 =====
CREATE TABLE IF NOT EXISTS config_secrets (
    id BIGSERIAL PRIMARY KEY,
    key_path VARCHAR(256) NOT NULL UNIQUE,  -- 如 ai-service/apiKey / recorder/smbPassword
    ciphertext BYTEA NOT NULL,              -- AES-256-GCM 密文（含 nonce + tag）
    algorithm VARCHAR(32) NOT NULL DEFAULT 'aes-256-gcm',
    key_version INTEGER NOT NULL DEFAULT 1, -- 主密钥版本，用于轮换
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== 初始数据：服务状态占位 =====
INSERT INTO config_service_states (service_name, status)
VALUES
    ('backend', 'unknown'),
    ('srs', 'unknown'),
    ('ai-service', 'unknown'),
    ('recorder', 'unknown')
ON CONFLICT (service_name) DO NOTHING;

-- ===== 触发器：updated_at 自动更新 =====
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at_config_documents ON config_documents;
CREATE TRIGGER set_updated_at_config_documents
BEFORE UPDATE ON config_documents
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_config_service_states ON config_service_states;
CREATE TRIGGER set_updated_at_config_service_states
BEFORE UPDATE ON config_service_states
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_config_secrets ON config_secrets;
CREATE TRIGGER set_updated_at_config_secrets
BEFORE UPDATE ON config_secrets
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
