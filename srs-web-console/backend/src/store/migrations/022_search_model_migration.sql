-- Model migration reuses the existing PG task authority. The immutable payload
-- remains the creation/idempotency contract; only small control progress and
-- an explicit administrator report acceptance are additional task state.
ALTER TABLE search_jobs ADD COLUMN IF NOT EXISTS migration_progress JSONB;
ALTER TABLE search_jobs ADD COLUMN IF NOT EXISTS migration_acceptance JSONB;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='search_jobs'::regclass AND conname='search_migration_progress_bounded') THEN
    ALTER TABLE search_jobs ADD CONSTRAINT search_migration_progress_bounded CHECK (
      migration_progress IS NULL OR (kind='rebuild' AND COALESCE(payload->>'purpose'='reencode',false)
        AND jsonb_typeof(migration_progress)='object' AND octet_length(migration_progress::text)<=8192));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='search_jobs'::regclass AND conname='search_migration_acceptance_bounded') THEN
    ALTER TABLE search_jobs ADD CONSTRAINT search_migration_acceptance_bounded CHECK (
      migration_acceptance IS NULL OR (migration_progress IS NOT NULL
        AND jsonb_typeof(migration_acceptance)='object' AND octet_length(migration_acceptance::text)<=4096));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS search_jobs_migration_claim ON search_jobs(created_at,id)
  WHERE kind='rebuild' AND payload->>'purpose'='reencode' AND state IN ('pending','running');
