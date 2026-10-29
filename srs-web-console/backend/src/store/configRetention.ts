/** Bounded operational history. A pending model switch additionally retains its
 * original full snapshot until its existing seven-day task expiry. The lazy
 * PL/pgSQL branch keeps basic config-only and pre-022 schemas compatible. */
export const CONFIG_HISTORY_RETENTION_SQL = `
DELETE FROM config_audit_logs
WHERE id < COALESCE((SELECT id FROM config_audit_logs ORDER BY id DESC OFFSET 9999 LIMIT 1), 0);
DO $config_retention$ BEGIN
  IF to_regclass('search_jobs') IS NULL THEN
    DELETE FROM config_versions v
    WHERE v.id < COALESCE((SELECT id FROM config_versions ORDER BY id DESC OFFSET 999 LIMIT 1), 0)
      AND NOT EXISTS (SELECT 1 FROM config_service_states s
        WHERE s.applied_version = v.version OR s.desired_version = v.version);
  ELSE
    DELETE FROM config_versions v
    WHERE v.id < COALESCE((SELECT id FROM config_versions ORDER BY id DESC OFFSET 999 LIMIT 1), 0)
      AND NOT EXISTS (SELECT 1 FROM config_service_states s
        WHERE s.applied_version = v.version OR s.desired_version = v.version)
      AND NOT EXISTS (SELECT 1 FROM search_jobs j
        WHERE j.payload->>'purpose'='reencode_plan' AND j.expires_at>clock_timestamp()
          AND to_jsonb(j)->'migration_progress'->>'source_config_version'=v.version::text);
  END IF;
END $config_retention$;
`;
