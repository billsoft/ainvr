-- Persist the last actually loaded/Ready search space. Disabled/model-pending
-- reports never erase it. Authority to move it remains an accepted migration
-- in the existing search_jobs table, not a file-system model name.
ALTER TABLE search_runtime_state ADD COLUMN IF NOT EXISTS active_model JSONB;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='search_runtime_state'::regclass AND conname='search_active_model_pin_bounded') THEN
    ALTER TABLE search_runtime_state ADD CONSTRAINT search_active_model_pin_bounded CHECK (
      active_model IS NULL OR (jsonb_typeof(active_model)='object' AND octet_length(active_model::text)<=1024
        AND active_model ?& ARRAY['package_id','package_sha256','model_version']
        AND active_model-'package_id'-'package_sha256'-'model_version'='{}'::jsonb
        AND jsonb_typeof(active_model->'package_id')='string'
        AND jsonb_typeof(active_model->'package_sha256')='string'
        AND jsonb_typeof(active_model->'model_version')='string'
        AND active_model->>'package_id' ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'
        AND active_model->>'model_version' ~ '^search-v1-[a-f0-9]{64}$'
        AND active_model->>'package_sha256'=substring(active_model->>'model_version' FROM 11)));
  END IF;
END $$;
