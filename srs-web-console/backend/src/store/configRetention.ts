/** Configuration history is operational rollback data, not unlimited telemetry.
 * Preserve current/desired service revisions even outside the normal window.
 * Business configuration documents, secrets and alarm history are untouched.
 */
export const CONFIG_HISTORY_RETENTION_SQL = `
DELETE FROM config_audit_logs
WHERE id < COALESCE((SELECT id FROM config_audit_logs ORDER BY id DESC OFFSET 9999 LIMIT 1), 0);
DELETE FROM config_versions v
WHERE v.id < COALESCE((SELECT id FROM config_versions ORDER BY id DESC OFFSET 999 LIMIT 1), 0)
  AND NOT EXISTS (SELECT 1 FROM config_service_states s
    WHERE s.applied_version = v.version OR s.desired_version = v.version);
`;
