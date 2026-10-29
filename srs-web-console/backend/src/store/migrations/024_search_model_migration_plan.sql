-- Parent plans and child batches share the existing durable task authority.
ALTER TABLE search_jobs DROP CONSTRAINT IF EXISTS search_migration_progress_bounded;
ALTER TABLE search_jobs ADD CONSTRAINT search_migration_progress_bounded CHECK (
  migration_progress IS NULL OR (kind='rebuild' AND COALESCE(payload->>'purpose' IN ('reencode','reencode_plan'),false)
    AND jsonb_typeof(migration_progress)='object' AND octet_length(migration_progress::text)<=8192));
DROP INDEX IF EXISTS search_jobs_migration_child_identity;
CREATE UNIQUE INDEX search_jobs_migration_child_identity
  ON search_jobs((payload->>'plan_id'),(payload->>'plan_round'),(COALESCE(payload->>'plan_switch_generation','0')),(payload->>'partition_index'))
  WHERE kind='rebuild' AND payload->>'purpose'='reencode' AND payload->>'plan_id' IS NOT NULL;
CREATE INDEX IF NOT EXISTS search_jobs_migration_parent_claim ON search_jobs(created_at,id)
  WHERE kind='rebuild' AND payload->>'purpose'='reencode_plan' AND state IN ('pending','running');
