import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
const uuid = z.string().uuid();
const model = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export interface SearchShardLease { id: string; revision: number; jobId: string; jobGeneration: number; worker: string; storageGeneration: string }
export interface SearchShardPublication { manifestSha256: string; checkpoint: number; records: number; bytes: number }
/** PG is the directory/checkpoint authority. A worker must atomically publish and
 * verify the SSD file before calling publish(). Files remain rebuildable from Mongo.
 * SearchJobs owns the only lease; this directory never creates a second timer. */
export class SearchIndexShards {
  constructor(private readonly pool: Pool) {}
  async ensure(channelId: string, modelVersion: string, utcDay: string, storageGeneration?: string): Promise<string> {
    uuid.parse(channelId); model.parse(modelVersion); day.parse(utcDay);
    if (storageGeneration !== undefined) hash.parse(storageGeneration);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ainvr-search-shard-directory',0))");
      const old = await client.query('SELECT id FROM search_index_shards WHERE channel_id=$1 AND model_version=$2 AND day=$3 AND directory_storage_generation IS NOT DISTINCT FROM $4', [channelId, modelVersion, utcDay, storageGeneration ?? null]);
      if (old.rows[0]) { await client.query('COMMIT'); return old.rows[0].id as string; }
      if (storageGeneration !== undefined) {
        const legacy = await client.query(`UPDATE search_index_shards SET directory_storage_generation=$4
          WHERE channel_id=$1 AND model_version=$2 AND day=$3 AND directory_storage_generation IS NULL
          AND state='pending' AND storage_generation IS NULL AND published_revision IS NULL AND build_job_id IS NULL RETURNING id`, [channelId, modelVersion, utcDay, storageGeneration]);
        if (legacy.rows[0]) { await client.query('COMMIT'); return legacy.rows[0].id as string; }
      }
      const size = await client.query('SELECT count(*)::int AS n FROM search_index_shards');
      if (size.rows[0].n >= 65536) throw new Error('search_shard_directory_capacity');
      const id = randomUUID();
      await client.query(`INSERT INTO search_index_shards(id,channel_id,model_version,day,state,directory_storage_generation) VALUES($1,$2,$3,$4,'pending',$5)`, [id, channelId, modelVersion, utcDay, storageGeneration ?? null]);
      await client.query('COMMIT'); return id;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async begin(id: string, jobId: string, worker: string, generation: number, storageGeneration: string): Promise<SearchShardLease | null> {
    uuid.parse(id); uuid.parse(jobId); uuid.parse(worker); z.number().int().positive().parse(generation); hash.parse(storageGeneration);
    // Lock the job as well as the directory: cancellation and publication cannot
    // race a successful check under MVCC. Expiry is checked in every mutation.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const job = await client.query(`SELECT id,claimed_checkpoint FROM search_jobs WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND kind IN ('index','rebuild')
        AND state='running' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() AND payload->>'shard_id'=$4 FOR UPDATE`, [jobId, worker, generation, id]);
      if (!job.rowCount) { await client.query('COMMIT'); return null; }
      const row = await client.query(`SELECT *,revision::text AS revision_text FROM search_index_shards WHERE id=$1 FOR UPDATE`, [id]);
      const current = row.rows[0];
      if (!current || current.state === 'deleting') { await client.query('COMMIT'); return null; }
      if (current.directory_storage_generation && current.directory_storage_generation !== storageGeneration) { await client.query('COMMIT'); return null; }
      if (!current.directory_storage_generation) await client.query('UPDATE search_index_shards SET directory_storage_generation=$2 WHERE id=$1', [id, storageGeneration]);
      // A retry of the same claimed job has the same publication identity.
      if (['building', 'ready'].includes(current.state as string) && current.build_job_id === jobId && current.build_job_generation === generation && current.storage_generation === storageGeneration) {
        await client.query('COMMIT'); return { id, revision: Number(current.revision_text), jobId, jobGeneration: generation, worker, storageGeneration };
      }
      if (current.retired_revision !== null) { await client.query('COMMIT'); return null; }
      if (current.state === 'building' && current.build_job_id && current.build_job_id !== jobId) {
        const live = await client.query(`SELECT id FROM search_jobs WHERE id=$1 AND generation=$2 AND state='running'
          AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()`, [current.build_job_id, current.build_job_generation]);
        if (live.rowCount) { await client.query('COMMIT'); return null; }
      }
      if (current.build_job_id && current.published_revision !== current.revision) {
        // Do not overwrite the identity of a crashed/expired writer's complete
        // local manifest. Publication authority explicitly retires it first.
        const live = await client.query(`SELECT id FROM search_jobs WHERE id=$1 AND generation=$2 AND state='running'
          AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()`, [current.build_job_id, current.build_job_generation]);
        if (live.rowCount) { await client.query('COMMIT'); return null; }
        await client.query(`UPDATE search_index_shards SET retired_revision=revision,retired_storage_generation=storage_generation,
          retired_manifest_key=id::text||'/'||revision::text||'.manifest.json',retired_job_id=build_job_id,retired_job_generation=build_job_generation,retired_worker=build_worker,
          build_job_id=NULL,build_job_generation=NULL,build_worker=NULL,state=CASE WHEN published_revision IS NULL THEN 'pending' ELSE 'ready' END WHERE id=$1`, [id]);
        await client.query('COMMIT'); return null;
      }
      const revision = Number(current.revision_text) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('search_shard_revision_exhausted');
      const updated = await client.query(`UPDATE search_index_shards SET state='building',revision=$2,build_job_id=$3,build_job_generation=$4,
        storage_generation=$5,build_worker=$6,updated_at=now() WHERE id=$1 AND EXISTS
        (SELECT 1 FROM search_jobs WHERE id=$3 AND lease_owner=$6 AND generation=$4 AND state='running'
          AND lease_until>clock_timestamp() AND expires_at>clock_timestamp())`, [id, revision, jobId, generation, storageGeneration, worker]);
      await client.query('COMMIT'); return updated.rowCount === 1 ? { id, revision, jobId, jobGeneration: generation, worker, storageGeneration } : null;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  static manifestKey(lease: SearchShardLease): string {
    uuid.parse(lease.id); z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(lease.revision);
    return `${lease.id}/${lease.revision}.manifest.json`;
  }
  async publish(lease: SearchShardLease, publication: SearchShardPublication): Promise<boolean> {
    uuid.parse(lease.id); uuid.parse(lease.jobId); uuid.parse(lease.worker); hash.parse(lease.storageGeneration);
    z.number().int().positive().parse(lease.jobGeneration); const key = SearchIndexShards.manifestKey(lease);
    hash.parse(publication.manifestSha256); integer.parse(publication.checkpoint);
    z.number().int().min(0).max(1000000).parse(publication.records); z.number().int().min(0).max(1099511627776).parse(publication.bytes);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const job = await client.query(`SELECT id,claimed_checkpoint FROM search_jobs WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND kind IN ('index','rebuild')
        AND state='running' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() AND payload->>'shard_id'=$4 FOR UPDATE`, [lease.jobId, lease.worker, lease.jobGeneration, lease.id]);
      if (!job.rowCount) { await client.query('COMMIT'); return false; }
      const current = (await client.query('SELECT * FROM search_index_shards WHERE id=$1 FOR UPDATE', [lease.id])).rows[0];
      if (!current || current.directory_storage_generation !== lease.storageGeneration ||
          Number(current.revision) !== lease.revision || current.build_job_id !== lease.jobId || current.build_job_generation !== lease.jobGeneration ||
          current.storage_generation !== lease.storageGeneration || !['building', 'ready'].includes(current.state) ||
          (job.rows[0].claimed_checkpoint !== null && publication.checkpoint < Number(job.rows[0].claimed_checkpoint)) ||
          (current.state === 'ready' && (current.manifest_key !== key || current.manifest_sha256 !== publication.manifestSha256 ||
            Number(current.checkpoint) !== publication.checkpoint || current.record_count !== publication.records || Number(current.byte_count) !== publication.bytes))) {
        await client.query('COMMIT'); return false;
      }
      if (current.published_revision !== null && Number(current.published_revision) !== lease.revision) {
        if (current.retired_revision !== null) { await client.query('COMMIT'); return false; }
        await client.query(`UPDATE search_index_shards SET retired_revision=published_revision,
          retired_storage_generation=published_storage_generation,retired_manifest_key=manifest_key,
          retired_job_id=NULL,retired_job_generation=NULL,retired_worker=NULL WHERE id=$1`, [lease.id]);
      }
      const result = await client.query(`UPDATE search_index_shards SET state='ready',published_revision=$2,published_storage_generation=$10,manifest_key=$3,
        manifest_sha256=$4,checkpoint=$5,record_count=$6,byte_count=$7,updated_at=now()
        WHERE id=$1 AND revision=$2 AND build_job_id=$8 AND build_job_generation=$9 AND storage_generation=$10
        AND EXISTS (SELECT 1 FROM search_jobs WHERE id=$8 AND lease_owner=$11 AND generation=$9 AND state='running'
          AND lease_until>clock_timestamp() AND expires_at>clock_timestamp())
        AND state IN ('building','ready') AND (state='building' OR
          (manifest_key=$3 AND manifest_sha256=$4 AND checkpoint=$5 AND record_count=$6 AND byte_count=$7))`,
        [lease.id, lease.revision, key, publication.manifestSha256, publication.checkpoint, publication.records, publication.bytes,
          lease.jobId, lease.jobGeneration, lease.storageGeneration, lease.worker]);
      if (result.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async published(id: string, storageGeneration: string) {
    uuid.parse(id); hash.parse(storageGeneration);
    const row = await this.pool.query(`SELECT id,channel_id,model_version,day::text AS day,published_revision,manifest_key,manifest_sha256,
      checkpoint,record_count,byte_count,(state<>'ready') AS partial FROM search_index_shards
      WHERE id=$1 AND directory_storage_generation=$2 AND storage_generation=$2 AND published_storage_generation=$2 AND state<>'deleting' AND published_revision IS NOT NULL AND manifest_sha256 IS NOT NULL`, [id, storageGeneration]);
    return row.rows[0] ?? null;
  }
  async catalog(modelVersion: string, storageGeneration: string, channels: readonly string[], retentionDays: number, cursor: string | null, limit: number) {
    model.parse(modelVersion); hash.parse(storageGeneration); channels.forEach(value => uuid.parse(value));
    z.number().int().min(1).max(365).parse(retentionDays); z.number().int().min(1).max(16).parse(limit); if (cursor !== null) uuid.parse(cursor);
    const result = await this.pool.query(`SELECT id,channel_id,model_version,day::text AS day,published_revision,manifest_key,manifest_sha256,
      checkpoint,record_count,byte_count,(state<>'ready') AS partial FROM search_index_shards
      WHERE directory_storage_generation=$1 AND storage_generation=$1 AND published_storage_generation=$1 AND model_version=$2 AND channel_id=ANY($3::uuid[])
        AND day BETWEEN (clock_timestamp() AT TIME ZONE 'UTC')::date-$4::int AND (clock_timestamp() AT TIME ZONE 'UTC')::date
        AND state<>'deleting' AND published_revision IS NOT NULL AND manifest_sha256 IS NOT NULL AND ($5::uuid IS NULL OR id>$5)
      ORDER BY id LIMIT $6`, [storageGeneration, modelVersion, channels, retentionDays, cursor, limit + 1]);
    const items = result.rows.slice(0, limit); return { items, nextCursor: result.rows.length > limit ? items.at(-1)!.id as string : null };
  }
  async retired(id: string, storageGeneration: string) {
    uuid.parse(id); hash.parse(storageGeneration);
    const row = (await this.pool.query(`SELECT id,channel_id,model_version,day::text AS day,retired_revision AS revision,
      retired_storage_generation AS storage_generation,retired_manifest_key AS manifest_key FROM search_index_shards
      WHERE id=$1 AND retired_storage_generation=$2 AND retired_revision IS NOT NULL`, [id, storageGeneration])).rows[0];
    if (!row) return null;
    return { ...row, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(Number(row.revision)) };
  }
  async confirmCleanup(id: string, revision: number, storageGeneration: string): Promise<boolean> {
    uuid.parse(id); z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(revision); hash.parse(storageGeneration);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // Preserve the universal job -> directory lock order when cleanup may
      // re-arm an explicitly revoked refresh. The unlocked read grants nothing.
      const before = (await c.query('SELECT retired_job_id FROM search_index_shards WHERE id=$1', [id])).rows[0];
      if (before?.retired_job_id) await c.query('SELECT id FROM search_jobs WHERE id=$1 FOR UPDATE', [before.retired_job_id]);
      const row = (await c.query('SELECT * FROM search_index_shards WHERE id=$1 FOR UPDATE', [id])).rows[0];
      // Confirmation is not deletion authorization. An already-pruned empty
      // directory needs no work; no path or file is granted by this response.
      if (!row || (Number(row.last_cleaned_revision) === revision && row.last_cleaned_storage_generation === storageGeneration)) { await c.query('COMMIT'); return true; }
      if (row.retired_job_id !== before?.retired_job_id) { await c.query('COMMIT'); return false; }
      if (Number(row.retired_revision) !== revision || row.retired_storage_generation !== storageGeneration) { await c.query('COMMIT'); return false; }
      // A lost Publish can be atomically revoked, but its static partition still
      // needs rebuilding even when no new sample raises the watermark. Resume
      // only our exact discard proof, after physical cleanup, with attempts
      // preserved. Manual cancellation and exhausted work never auto-restart.
      if (row.retired_job_id && row.retired_worker) await c.query(`UPDATE search_jobs SET
        state=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,
        error_code=CASE WHEN attempts<3 THEN NULL ELSE 'attempts_exhausted' END
        WHERE id=$1 AND refresh_scope IS NOT NULL AND state='cancelled' AND error_code='build_discarded'
          AND generation=$2+1 AND requested_checkpoint>completed_checkpoint AND expires_at>clock_timestamp()`,
        [row.retired_job_id, row.retired_job_generation]);
      await c.query(`UPDATE search_index_shards SET retired_revision=NULL,retired_storage_generation=NULL,retired_manifest_key=NULL,
        last_cleaned_job_id=retired_job_id,last_cleaned_job_generation=retired_job_generation,last_cleaned_worker=retired_worker,
        retired_job_id=NULL,retired_job_generation=NULL,retired_worker=NULL,last_cleaned_revision=$2,last_cleaned_storage_generation=$3 WHERE id=$1`, [id, revision, storageGeneration]);
      await c.query('COMMIT'); return true;
    } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  }
  async discardBuild(id: string, revision: number, jobId: string, worker: string, generation: number, storageGeneration: string): Promise<boolean> {
    uuid.parse(id); uuid.parse(jobId); uuid.parse(worker); hash.parse(storageGeneration);
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(revision); z.number().int().positive().parse(generation);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const job = (await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND actor='internal-search-index' FOR UPDATE`, [jobId])).rows[0];
      const row = (await c.query('SELECT * FROM search_index_shards WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!job || !row || job.payload?.shard_id !== id || Number(row.published_revision) === revision ||
          job.generation < generation || (job.state === 'running' && (job.generation !== generation || job.lease_owner !== worker))) { await c.query('COMMIT'); return false; }
      if (Number(row.last_cleaned_revision) === revision && row.last_cleaned_storage_generation === storageGeneration &&
          row.last_cleaned_job_id === jobId && row.last_cleaned_job_generation === generation && row.last_cleaned_worker === worker) {
        await c.query('COMMIT'); return true;
      }
      if (Number(row.retired_revision) === revision && row.retired_storage_generation === storageGeneration &&
          row.retired_job_id === jobId && row.retired_job_generation === generation && row.retired_worker === worker) { await c.query('COMMIT'); return true; }
      if (row.retired_revision !== null || Number(row.revision) !== revision || row.build_job_id !== jobId || row.build_job_generation !== generation ||
          row.storage_generation !== storageGeneration || row.build_worker !== worker) { await c.query('COMMIT'); return false; }
      await c.query(`UPDATE search_jobs SET state='cancelled',generation=generation+1,lease_owner=NULL,lease_until=NULL,error_code='build_discarded'
        WHERE id=$1 AND generation=$2 AND state IN ('pending','running')`, [jobId, generation]);
      await c.query(`UPDATE search_index_shards SET retired_revision=revision,retired_storage_generation=storage_generation,
        retired_manifest_key=id::text||'/'||revision::text||'.manifest.json',retired_job_id=build_job_id,retired_job_generation=build_job_generation,retired_worker=build_worker,
        build_job_id=NULL,build_job_generation=NULL,build_worker=NULL,state=CASE WHEN published_revision IS NULL THEN 'pending' ELSE 'ready' END WHERE id=$1`, [id]);
      await c.query('COMMIT'); return true;
    } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  }
  async retiredCatalog(modelVersion: string, storageGeneration: string, channels: readonly string[], retentionDays: number, cursor: string | null, limit: number) {
    model.parse(modelVersion); hash.parse(storageGeneration); channels.forEach(value => uuid.parse(value));
    z.number().int().min(1).max(365).parse(retentionDays); z.number().int().min(1).max(16).parse(limit); if (cursor !== null) uuid.parse(cursor);
    // An expired/crashed build can own complete local files even without a
    // publication. Retire its proof before the job or directory is pruned.
    await this.pool.query(`WITH old AS (SELECT s.id FROM search_index_shards s
      WHERE s.model_version=$1 AND s.storage_generation=$2 AND s.channel_id=ANY($3::uuid[]) AND s.retired_revision IS NULL
        AND s.build_job_id IS NOT NULL AND s.revision IS DISTINCT FROM s.published_revision
        AND NOT EXISTS(SELECT 1 FROM search_jobs j WHERE j.id=s.build_job_id AND j.generation=s.build_job_generation AND j.state='running'
          AND j.lease_until>clock_timestamp() AND j.expires_at>clock_timestamp()) ORDER BY s.id FOR UPDATE SKIP LOCKED LIMIT 16)
      UPDATE search_index_shards s SET retired_revision=s.revision,retired_storage_generation=s.storage_generation,
        retired_manifest_key=s.id::text||'/'||s.revision::text||'.manifest.json',retired_job_id=s.build_job_id,retired_job_generation=s.build_job_generation,retired_worker=s.build_worker,
        build_job_id=NULL,build_job_generation=NULL,build_worker=NULL,state=CASE WHEN s.published_revision IS NULL THEN 'pending' ELSE 'ready' END
      FROM old WHERE s.id=old.id`, [modelVersion, storageGeneration, channels]);
    // Expired whole UTC days only; keep the oldest still-live partial day.
    await this.pool.query(`WITH old AS (SELECT s.id FROM search_index_shards s
      WHERE s.model_version=$1 AND s.published_storage_generation=$2 AND s.channel_id=ANY($3::uuid[]) AND s.retired_revision IS NULL
        AND s.published_revision IS NOT NULL AND s.day<(clock_timestamp() AT TIME ZONE 'UTC')::date-$4::int
        AND s.manifest_key=s.id::text||'/'||s.published_revision::text||'.manifest.json'
        AND NOT EXISTS(SELECT 1 FROM search_jobs j WHERE j.id=s.build_job_id AND j.generation=s.build_job_generation AND j.state='running'
          AND j.lease_until>clock_timestamp() AND j.expires_at>clock_timestamp()) ORDER BY s.id FOR UPDATE SKIP LOCKED LIMIT 16)
      UPDATE search_index_shards s SET retired_revision=s.published_revision,retired_storage_generation=s.published_storage_generation,
        retired_manifest_key=s.manifest_key,retired_job_id=s.build_job_id,retired_job_generation=s.build_job_generation,retired_worker=s.build_worker,
        published_revision=NULL,published_storage_generation=NULL,manifest_key=NULL,manifest_sha256=NULL,checkpoint=0,record_count=0,byte_count=0,
        build_job_id=NULL,build_job_generation=NULL,build_worker=NULL,state='pending' FROM old WHERE s.id=old.id`, [modelVersion, storageGeneration, channels, retentionDays]);
    await this.pool.query(`DELETE FROM search_index_shards WHERE id IN (SELECT s.id FROM search_index_shards s
      WHERE s.directory_storage_generation=$2 AND s.model_version=$3 AND s.channel_id=ANY($4::uuid[])
        AND s.published_revision IS NULL AND s.retired_revision IS NULL AND s.build_job_id IS NULL
        AND s.day<(clock_timestamp() AT TIME ZONE 'UTC')::date-$1::int
        AND NOT EXISTS(SELECT 1 FROM search_jobs j WHERE j.payload->>'shard_id'=s.id::text AND j.state IN ('pending','running') AND j.expires_at>clock_timestamp())
      ORDER BY s.day,s.id LIMIT 16)`, [retentionDays, storageGeneration, modelVersion, channels]);
    const rows = await this.pool.query(`SELECT id,channel_id,model_version,day::text AS day,retired_revision AS revision,
      retired_storage_generation AS storage_generation,retired_manifest_key AS manifest_key FROM search_index_shards
      WHERE model_version=$1 AND retired_storage_generation=$2 AND channel_id=ANY($3::uuid[]) AND retired_revision IS NOT NULL
        AND day<=(clock_timestamp() AT TIME ZONE 'UTC')::date AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`, [modelVersion, storageGeneration, channels, cursor, limit + 1]);
    const items = rows.rows.slice(0, limit).map(row => ({ ...row, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(Number(row.revision)) }));
    return { items, nextCursor: rows.rows.length > limit ? items.at(-1)!.id as string : null };
  }
}
