-- Bounded control metadata only; reuse SearchJobs and the existing directory.
ALTER TABLE search_jobs
  ADD COLUMN refresh_scope TEXT CHECK (refresh_scope IS NULL OR refresh_scope ~ '^[a-f0-9]{64}$'),
  ADD COLUMN requested_checkpoint BIGINT,
  ADD COLUMN completed_checkpoint BIGINT,
  ADD COLUMN claimed_checkpoint BIGINT CHECK (claimed_checkpoint IS NULL OR claimed_checkpoint BETWEEN 0 AND 9007199254740991),
  ADD CHECK ((refresh_scope IS NULL AND requested_checkpoint IS NULL AND completed_checkpoint IS NULL) OR
    (refresh_scope IS NOT NULL AND actor='internal-search-index' AND kind='index' AND requested_checkpoint IS NOT NULL AND completed_checkpoint IS NOT NULL AND
     requested_checkpoint BETWEEN 0 AND 9007199254740991 AND completed_checkpoint BETWEEN 0 AND 9007199254740991));
CREATE UNIQUE INDEX search_jobs_refresh_scope ON search_jobs(actor,refresh_scope) WHERE refresh_scope IS NOT NULL;
CREATE INDEX search_jobs_refresh_claim ON search_jobs(actor,kind,created_at,id) WHERE refresh_scope IS NOT NULL AND state IN ('pending','running');

ALTER TABLE search_index_shards
  ADD COLUMN directory_storage_generation TEXT CHECK (directory_storage_generation IS NULL OR directory_storage_generation ~ '^[a-f0-9]{64}$'),
  ADD COLUMN build_worker UUID,
  ADD COLUMN retired_revision BIGINT,
  ADD COLUMN retired_storage_generation TEXT,
  ADD COLUMN retired_manifest_key TEXT,
  ADD COLUMN retired_job_id UUID,
  ADD COLUMN retired_job_generation INTEGER,
  ADD COLUMN retired_worker UUID,
  ADD COLUMN last_cleaned_revision BIGINT,
  ADD COLUMN last_cleaned_storage_generation TEXT,
  ADD COLUMN last_cleaned_job_id UUID,
  ADD COLUMN last_cleaned_job_generation INTEGER,
  ADD COLUMN last_cleaned_worker UUID,
  ADD CHECK ((retired_revision IS NULL AND retired_storage_generation IS NULL AND retired_manifest_key IS NULL AND retired_job_id IS NULL AND retired_job_generation IS NULL AND retired_worker IS NULL) OR
    (retired_revision IS NOT NULL AND retired_revision BETWEEN 1 AND 9007199254740991 AND retired_storage_generation IS NOT NULL AND retired_manifest_key IS NOT NULL AND retired_storage_generation ~ '^[a-f0-9]{64}$' AND
     retired_manifest_key=id::text||'/'||retired_revision::text||'.manifest.json' AND
     (retired_job_generation IS NULL OR retired_job_generation>0))),
  ADD CHECK ((last_cleaned_revision IS NULL AND last_cleaned_storage_generation IS NULL) OR
    (last_cleaned_revision IS NOT NULL AND last_cleaned_revision BETWEEN 1 AND 9007199254740991 AND last_cleaned_storage_generation IS NOT NULL AND last_cleaned_storage_generation ~ '^[a-f0-9]{64}$'));
UPDATE search_index_shards s SET build_worker=j.lease_owner FROM search_jobs j
  WHERE s.build_job_id=j.id AND s.build_job_generation=j.generation AND j.state='running';
-- Legacy directories could hold a publication from one mount and an abandoned
-- build from another. Preserve both exact identities; never adopt the new mount
-- or forget the unpublished file when assigning the stable directory scope.
UPDATE search_jobs j SET state='cancelled',generation=j.generation+1,lease_owner=NULL,lease_until=NULL
  FROM search_index_shards s WHERE s.build_job_id=j.id AND s.build_job_generation=j.generation
    AND s.published_storage_generation IS NOT NULL AND s.storage_generation IS DISTINCT FROM s.published_storage_generation
    AND j.state IN ('pending','running');
UPDATE search_index_shards SET retired_revision=revision,retired_storage_generation=storage_generation,
  retired_manifest_key=id::text||'/'||revision::text||'.manifest.json',retired_job_id=build_job_id,retired_job_generation=build_job_generation,retired_worker=build_worker,
  build_job_id=NULL,build_job_generation=NULL,build_worker=NULL,storage_generation=published_storage_generation,state='ready'
  WHERE published_storage_generation IS NOT NULL AND storage_generation IS NOT NULL AND storage_generation IS DISTINCT FROM published_storage_generation;
UPDATE search_index_shards SET directory_storage_generation=COALESCE(published_storage_generation,storage_generation);
ALTER TABLE search_index_shards DROP CONSTRAINT search_index_shards_channel_id_model_version_day_key;
CREATE UNIQUE INDEX search_shard_storage_scope ON search_index_shards(channel_id,model_version,day,COALESCE(directory_storage_generation,''));
CREATE INDEX search_shards_retired ON search_index_shards(directory_storage_generation,id) WHERE retired_revision IS NOT NULL;
