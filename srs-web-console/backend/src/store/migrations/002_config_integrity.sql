-- 002_config_integrity.sql — 数据完整性加固（P1 评审修复 2026-09-15）
-- 1. config_service_states.desired_version 加外键引用 config_versions(version)
--    防止状态表挂着不存在的版本号（客户端拉取 404 永久退避）
-- 2. 补 config_audit_logs 的 service + config_name 复合索引（审计查询常用）
-- 3. 补 config_snapshots(service, "group", name) 查询索引（按服务跨版本查询）

-- ===== 1. service_states.desired_version 外键 =====
-- 先清理可能存在的脏数据（指向已删除版本的 desired_version 置空）
UPDATE config_service_states
   SET desired_version = NULL
 WHERE desired_version IS NOT NULL
   AND desired_version NOT IN (SELECT version FROM config_versions);

ALTER TABLE config_service_states
  ADD CONSTRAINT fk_service_states_desired_version
  FOREIGN KEY (desired_version)
  REFERENCES config_versions(version)
  ON DELETE SET NULL;

-- applied_version 也加 FK（同样防脏数据）
UPDATE config_service_states
   SET applied_version = NULL
 WHERE applied_version IS NOT NULL
   AND applied_version NOT IN (SELECT version FROM config_versions);

ALTER TABLE config_service_states
  ADD CONSTRAINT fk_service_states_applied_version
  FOREIGN KEY (applied_version)
  REFERENCES config_versions(version)
  ON DELETE SET NULL;

-- ===== 2. 审计日志查询索引 =====
CREATE INDEX IF NOT EXISTS idx_audit_logs_service_config
  ON config_audit_logs(service, config_name, created_at DESC);

-- ===== 3. 快照按服务查询索引 =====
CREATE INDEX IF NOT EXISTS idx_snapshots_service_doc
  ON config_snapshots(service, "group", name);
