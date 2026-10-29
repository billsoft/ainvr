-- Rebuildable index publication only; no image or per-frame vector enters PG.
ALTER TABLE search_index_shards
  ADD COLUMN storage_generation TEXT,
  ADD COLUMN build_job_id UUID,
  ADD COLUMN build_job_generation INTEGER,
  ADD COLUMN published_revision BIGINT,
  ADD COLUMN published_storage_generation TEXT,
  ADD COLUMN manifest_sha256 TEXT,
  ADD COLUMN checkpoint BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN record_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN byte_count BIGINT NOT NULL DEFAULT 0,
  ADD CHECK (storage_generation IS NULL OR storage_generation ~ '^[a-f0-9]{64}$'),
  ADD CHECK (published_storage_generation IS NULL OR published_storage_generation ~ '^[a-f0-9]{64}$'),
  ADD CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CHECK (build_job_generation IS NULL OR build_job_generation > 0),
  ADD CHECK (published_revision IS NULL OR published_revision > 0),
  ADD CHECK (checkpoint >= 0 AND record_count BETWEEN 0 AND 1000000 AND byte_count BETWEEN 0 AND 1099511627776);
CREATE INDEX search_shards_retention ON search_index_shards(day);
