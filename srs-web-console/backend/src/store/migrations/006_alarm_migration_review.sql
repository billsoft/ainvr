-- Migration 005 converted angle filters to unrestricted edges and did not retain
-- enough information to prove equivalent behavior. Do not silently execute those
-- migrated definitions. Keep the original monitor and trigger versions intact.
-- Only untouched migration-owned rows are changed: never overwrite later edits.
WITH affected AS (
  SELECT t.trigger_id, t.version, t.document
  FROM alarm_triggers t
  JOIN alarm_trigger_versions v
    ON v.trigger_id=t.trigger_id AND v.version=t.version
  WHERE v.actor='migration-005'
    AND t.document->>'state'='enabled'
), updated AS (
  UPDATE alarm_triggers t
  SET version=t.version+1,
      document=jsonb_set(
        jsonb_set(t.document,'{state}','"paused"'::jsonb),
        '{migration_review}',
        '{"required":true,"reason":"旧配置转换时方向、目标或区域语义未能确认等价，请重新核对并保存后启用。","from":"migration-005"}'::jsonb
      ),
      updated_at=now()
  FROM affected a
  WHERE t.trigger_id=a.trigger_id AND t.version=a.version
  RETURNING t.trigger_id,t.version,t.document
), recorded AS (
  INSERT INTO alarm_trigger_versions(trigger_id,version,document,actor)
  SELECT trigger_id,version,document,'migration-006-review' FROM updated
  RETURNING trigger_id
)
UPDATE alarm_configuration_revision
SET revision=revision+1
WHERE singleton=TRUE AND EXISTS(SELECT 1 FROM recorded);
