import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SearchIndexShards } from '../store/searchIndexShards.js';
import type { SearchModelMigrationContext } from '../services/searchModelMigrationActivation.js';
import type { SearchMigrationWriteGrant } from '../services/searchModelMigrationContract.js';
import { searchIndexPayloadSchema, type SearchJobs, type SearchJob } from '../store/searchJobs.js';
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const kind = z.enum(['index', 'rebuild']);
const utcDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const model = z.string().regex(/^search-v1-[a-f0-9]{64}$/);
const migrationLease=z.object({job_id:uuid,worker:uuid,generation,actor:z.string().min(1).max(64),payload_fingerprint:hash}).strict();
const base = { revision: hash,migration_lease:migrationLease.optional() };
const lease = { job_id: uuid, worker: uuid, generation };
const publication = z.object({ manifestSha256: hash, checkpoint: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  records: z.number().int().min(0).max(1000000), bytes: z.number().int().min(0).max(1099511627776) }).strict();
const requestSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('enqueue'), request_key: uuid, channel_id: uuid, model_version: model, day: utcDay, kind }).strict(),
  z.object({ ...base, action: z.literal('refresh'), request_key: uuid, channel_id: uuid, model_version: model, day: utcDay, minimum_checkpoint: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ ...base, action: z.literal('catalog'), model_version: model, cursor: uuid.nullable(), limit: z.number().int().min(1).max(16) }).strict(),
  z.object({ ...base, action: z.literal('retired_catalog'), model_version: model, cursor: uuid.nullable(), limit: z.number().int().min(1).max(16) }).strict(),
  z.object({ ...base, action: z.literal('retired'), shard_id: uuid }).strict(),
  z.object({ ...base, action: z.literal('cleanup_confirm'), shard_id: uuid, retired_revision: generation, retired_storage_generation: hash }).strict(),
  z.object({ ...base, ...lease, action: z.literal('discard_build'), shard_id: uuid, build_revision: generation }).strict(),
  z.object({ ...base, action: z.literal('claim'), worker: uuid, kind }).strict(),
  z.object({ ...base, ...lease, action: z.literal('renew') }).strict(),
  z.object({ ...base, ...lease, action: z.literal('begin'), shard_id: uuid }).strict(),
  z.object({ ...base, ...lease, action: z.literal('publish'), shard_id: uuid, build_revision: generation, publication }).strict(),
  z.object({ ...base, ...lease, action: z.literal('fail'), error_code: z.enum(['history_unavailable', 'storage_unavailable', 'index_capacity', 'artifact_invalid']) }).strict(),
  z.object({ ...base, action: z.literal('published'), shard_id: uuid }).strict(),
]);
const payloadSchema = searchIndexPayloadSchema;
export interface SearchIndexContext { revision: string; storageGeneration: string; packageId: string; modelVersion:string;channels: readonly string[]; retentionDays: number; migrationScope?:{from_ms:number;to_ms:number} }
interface Options {
  principal: (request: FastifyRequest) => Promise<boolean>;
  context: () => Promise<SearchIndexContext | null>;
  migrationContext?:()=>Promise<Pick<SearchModelMigrationContext,'revision'|'storage_generation'|'desired_version'|'source'>|null>;
  jobs: Pick<SearchJobs, 'enqueue' | 'refreshIndex' | 'claim' | 'get' | 'renew' | 'finish' | 'cancel'> & Partial<Pick<SearchJobs,'authorizeMigrationArtifacts'>> | null;
  shards: Pick<SearchIndexShards, 'ensure' | 'begin' | 'publish' | 'published' | 'catalog' | 'retired' | 'confirmCleanup' | 'discardBuild' | 'retiredCatalog'> | null;
}
const actor = 'internal-search-index';
function allowedDay(day: string, retention: number) {
  const value = Date.parse(`${day}T00:00:00.000Z`), today = Math.floor(Date.now() / 86400000) * 86400000;
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === day &&
    value <= today && value >= today - retention * 86400000;
}
function allowedContextDay(day:string,context:SearchIndexContext,cleanup=false) {
  const at=Date.parse(`${day}T00:00:00.000Z`);
  return context.migrationScope ? Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===day&&at<context.migrationScope.to_ms&&at+86400000>context.migrationScope.from_ms
    :allowedDay(day,cleanup?1000000:context.retentionDays);
}
function scope(job: SearchJob, context: SearchIndexContext, cleanup = false) {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success || !['index', 'rebuild'].includes(job.kind)) return null;
  const data = parsed.data;
  return data.config_revision === context.revision && data.storage_generation === context.storageGeneration &&
    data.package_id === context.packageId && data.model_version===context.modelVersion && context.channels.includes(data.channel_id) && allowedContextDay(data.day,context,cleanup) ? data : null;
}
function claimResponse(job: SearchJob | null) {
  if (!job) return null;
  const { id, actor, kind, payload, state, generation, attempts, lease_owner, lease_until, expires_at, result_ref, error_code } = job;
  // Explicit projection: internal coalescing columns are not protocol fields.
  return { id, actor, kind, payload, state, generation, attempts, lease_owner, lease_until, expires_at, result_ref, error_code,
    ...(job.refresh_scope ? { minimum_checkpoint: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(Number(job.claimed_checkpoint)) } : {}) };
}
/** The existing search-service identity only. Browsers and AI producers cannot
 * claim work or supply arbitrary paths/URLs; PG remains the sole task authority. */
export async function searchIndexRoutes(app: FastifyInstance, options: Options) {
  app.post('/internal/search/index-jobs', { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!await options.principal(request)) return reply.code(403).send({ error: 'forbidden' });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_index_request' });
    const input = parsed.data, jobs = options.jobs, shards = options.shards;
    try {
      let context = await options.context();
      if (!context || !jobs || !shards) return reply.code(503).send({ error: 'config_pending' });
      if (context.revision !== input.revision) return reply.code(409).send({ error: 'runtime_revision_changed' });
      const authorize=async():Promise<SearchMigrationWriteGrant|null>=>{
        if(!input.migration_lease||!options.migrationContext||!jobs.authorizeMigrationArtifacts)return null;
        const current=await options.migrationContext();if(!current||current.revision!==input.revision)return null;
        const proof=input.migration_lease;
        return jobs.authorizeMigrationArtifacts(proof.job_id,proof.worker,proof.generation,proof.actor,proof.payload_fingerprint,current);
      };
      if(input.migration_lease) {
        const grant=await authorize();
        if(!grant)return reply.code(409).send({error:'index_job_stale'});
        context={...context,packageId:grant.target.package_id,modelVersion:grant.target.model_version,channels:grant.scope.channel_ids,
          migrationScope:{from_ms:grant.scope.from_ms,to_ms:grant.scope.to_ms},
          retentionDays:Math.min(1000000,Math.max(context.retentionDays,Math.ceil((Date.now()-grant.scope.from_ms)/86400000)))};
      }
      // A target publication is not activation. Cancellation between the two
      // PG transactions is observable as stale/unknown; no caller may advance
      // migration progress merely because its derived file was published.
      const checked=async<T>(result:T):Promise<T>=>{if(input.migration_lease&&!await authorize())throw new Error('migration_authority_changed');return result;};
      if('model_version' in input&&input.model_version!==context.modelVersion)return reply.code(403).send({error:'source_not_allowed'});
      if (input.action === 'catalog' || input.action === 'retired_catalog') {
        const page = input.action === 'catalog'
          ? await shards.catalog(input.model_version, context.storageGeneration, context.channels, context.retentionDays, input.cursor, input.limit)
          : await shards.retiredCatalog(input.model_version, context.storageGeneration, context.channels, context.retentionDays, input.cursor, input.limit);
        return { revision: context.revision, storage_generation: context.storageGeneration, items: page.items.filter(item=>context!.channels.includes(item.channel_id)&&item.model_version===context!.modelVersion&&allowedContextDay(item.day,context!)), next_cursor: page.nextCursor };
      }
      if (input.action === 'retired' || input.action === 'cleanup_confirm') {
        if (input.action === 'cleanup_confirm' && input.retired_storage_generation !== context.storageGeneration)
          return reply.code(409).send({ error: 'runtime_revision_changed' });
        const retired = await shards.retired(input.shard_id, context.storageGeneration);
        if (retired && (!context.channels.includes(retired.channel_id) || retired.model_version!==context.modelVersion || !allowedContextDay(retired.day,context,true)))
          return reply.code(403).send({ error: 'source_not_allowed' });
        return input.action === 'retired' ? { retired }
          : await checked({ confirmed: await shards.confirmCleanup(input.shard_id, input.retired_revision, context.storageGeneration) });
      }
      if (input.action === 'enqueue' || input.action === 'refresh') {
        if (!context.channels.includes(input.channel_id)) return reply.code(403).send({ error: 'source_not_allowed' });
        if (!allowedContextDay(input.day, context)) return reply.code(400).send({ error: 'invalid_index_day' });
        const id = await shards.ensure(input.channel_id, input.model_version, input.day, context.storageGeneration);
        const payload = { shard_id: id, channel_id: input.channel_id,
          model_version: input.model_version, day: input.day, storage_generation: context.storageGeneration,
          config_revision: context.revision, package_id: context.packageId };
        const job = input.action === 'refresh' ? await jobs.refreshIndex(input.request_key, payload, input.minimum_checkpoint, context.retentionDays)
          : await jobs.enqueue(actor, input.request_key, input.kind, payload);
        return await checked({ job_id: job.id, shard_id: id, state: job.state,
          ...(input.action === 'refresh' ? { accepted_checkpoint: z.number().int().min(input.minimum_checkpoint).max(Number.MAX_SAFE_INTEGER).parse(Number(job.requested_checkpoint)) } : {}) });
      }
      if (input.action === 'claim') {
        const job = await jobs.claim(input.worker, input.kind, 30000, actor,{model_version:context.modelVersion,package_id:context.packageId,config_revision:context.revision,storage_generation:context.storageGeneration});
        if (job && !scope(job, context)) return reply.code(409).send({error:'index_job_stale'});
        return await checked({ job: claimResponse(job) });
      }
      if (input.action === 'published') {
        const current = await shards.published(input.shard_id, context.storageGeneration);
        if (current && (!context.channels.includes(current.channel_id) || current.model_version!==context.modelVersion || !allowedContextDay(current.day,context)))
          return reply.code(403).send({ error: 'source_not_allowed' });
        return { shard: current };
      }
      const job = await jobs.get(input.job_id, actor, input.action === 'discard_build');
      const payload = job && scope(job, context, input.action === 'discard_build');
      if (input.action === 'discard_build') {
        if (!job || !payload || payload.shard_id !== input.shard_id) return { discarded: false };
        return await checked({ discarded: await shards.discardBuild(input.shard_id, input.build_revision, job.id, input.worker, input.generation, context.storageGeneration) });
      }
      if (!job || !payload || job.generation !== input.generation) return reply.code(409).send({ error: 'index_job_stale' });
      if (input.action === 'renew') return await checked({ renewed: await jobs.renew(job.id, input.worker, input.generation) });
      if (input.action === 'fail') return await checked({ finished: await jobs.finish(job.id, input.worker, input.generation, { errorCode: input.error_code }) });
      if (payload.shard_id !== input.shard_id) return reply.code(409).send({ error: 'index_job_stale' });
      if (input.action === 'begin') {
        const build = await shards.begin(input.shard_id, job.id, input.worker, input.generation, context.storageGeneration);
        return build ? await checked({ lease: build, manifest_key: SearchIndexShards.manifestKey(build) })
          : reply.code(409).send({ error: 'index_job_stale' });
      }
      const build = { id: input.shard_id, revision: input.build_revision, jobId: job.id,
        jobGeneration: input.generation, worker: input.worker, storageGeneration: context.storageGeneration };
      const reference = `shard:${build.id}:${build.revision}`;
      if (job.result_ref === reference) {
        const saved = await shards.published(build.id, context.storageGeneration);
        return saved && Number(saved.published_revision) === build.revision && saved.manifest_sha256 === input.publication.manifestSha256 &&
          Number(saved.checkpoint) === input.publication.checkpoint && saved.record_count === input.publication.records && Number(saved.byte_count) === input.publication.bytes
          ? await checked({ published: true }) : reply.code(409).send({ error: 'index_job_stale' });
      }
      if (!await shards.publish(build, input.publication)) return reply.code(409).send({ error: 'index_job_stale' });
      // A crash here leaves a durable publication and a retryable job. A repeat
      // confirms the same manifest, then finishes the existing lease.
      const finished = await jobs.finish(job.id, input.worker, input.generation, { resultRef: reference, checkpoint: input.publication.checkpoint });
      return finished ? await checked({ published: true }) : reply.code(409).send({ error: 'index_job_stale' });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_index_request' });
      if (error instanceof Error && ['queue_full', 'actor_queue_full', 'search_shard_directory_capacity'].includes(error.message))
        return reply.code(429).send({ error: 'index_capacity' });
      if(error instanceof Error&&error.message==='migration_authority_changed')return reply.code(409).send({error:'index_job_stale'});
      if (error instanceof Error && error.message === 'idempotency_conflict') return reply.code(409).send({ error: 'index_job_conflict' });
      return reply.code(503).send({ error: 'index_unavailable' });
    }
  });
}
