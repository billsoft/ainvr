import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { searchIndexRoutes, type SearchIndexContext } from '../routes/searchIndexRoutes.js';
const revision = 'a'.repeat(64), storage = 'b'.repeat(64), channel = randomUUID(), shard = randomUUID(), jobId = randomUUID(), worker = randomUUID();
const model = 'search-v1-' + 'd'.repeat(64), day = new Date().toISOString().slice(0, 10);
function fixture() {
  let context: SearchIndexContext | null = { revision, storageGeneration: storage, packageId: 'pair', modelVersion:model,channels: [channel], retentionDays: 30 };
  const payload = { shard_id: shard, channel_id: channel, model_version: model, day, storage_generation: storage, config_revision: revision, package_id: 'pair' };
  const job = { id: jobId, actor: 'internal-search-index', kind: 'index', payload, generation: 1, state: 'running', lease_owner: worker, result_ref: null };
  const jobs = {authorizeMigrationArtifacts:vi.fn(), refreshIndex: vi.fn().mockResolvedValue({ ...job, requested_checkpoint: '50' }), enqueue: vi.fn().mockResolvedValue(job), claim: vi.fn().mockResolvedValue(job), get: vi.fn().mockResolvedValue(job),
    renew: vi.fn().mockResolvedValue(true), finish: vi.fn().mockResolvedValue(true), cancel: vi.fn().mockResolvedValue(true) };
  const lease = { id: shard, revision: 2, jobId, jobGeneration: 1, worker, storageGeneration: storage };
  const shards = { catalog: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), retiredCatalog: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    retired: vi.fn().mockResolvedValue(null), confirmCleanup: vi.fn().mockResolvedValue(true), discardBuild: vi.fn().mockResolvedValue(true),
    ensure: vi.fn().mockResolvedValue(shard), begin: vi.fn().mockResolvedValue(lease), publish: vi.fn().mockResolvedValue(true), published: vi.fn().mockResolvedValue(null) };
  const app = Fastify(); app.register(searchIndexRoutes, { principal: async request => request.headers['x-service-token'] === 'search',
    context: async () => context,migrationContext:async()=>({revision,storage_generation:storage,desired_version:1,source:{package_id:'pair',package_sha256:'d'.repeat(64),model_version:model}}), jobs, shards });
  const call = (body: object, token = 'search') => app.inject({ method: 'POST', url: '/internal/search/index-jobs', headers: { 'x-service-token': token }, payload: { revision, ...body } });
  return { app, jobs, shards, lease, job, call, setContext: (value: SearchIndexContext | null) => { context = value; } };
}
it('denies browsers/AI producers before parsing and rejects unacknowledged runtime revisions', async () => {
  const f = fixture(); try {
    expect((await f.call({ action: 'garbage' }, 'ai')).statusCode).toBe(403);
    expect((await f.call({ action: 'claim', worker, kind: 'index', revision: 'c'.repeat(64) })).statusCode).toBe(409);
    expect(f.jobs.claim).not.toHaveBeenCalled();
    f.setContext(null); expect((await f.call({ action: 'claim', worker, kind: 'index' })).statusCode).toBe(503);
  } finally { await f.app.close(); }
});
it('enqueues only an allowed source/day and derives storage/config/package identity on the server', async () => {
  const f = fixture(); try {
    const input = { action: 'enqueue', request_key: randomUUID(), channel_id: channel, model_version: model, day, kind: 'index' };
    expect((await f.call({ ...input, channel_id: randomUUID() })).statusCode).toBe(403);
    expect((await f.call({ ...input, day: '2000-01-01' })).statusCode).toBe(400);
    expect((await f.call({ ...input, storage_generation: 'fake' })).statusCode).toBe(400);
    expect((await f.call(input)).statusCode).toBe(200);
    expect(f.jobs.enqueue).toHaveBeenCalledWith('internal-search-index', input.request_key, 'index', f.job.payload);
  } finally { await f.app.close(); }
});
it('claims only its own actor and cancels stale-config work without creating an alternative queue', async () => {
  const f = fixture(); try {
    expect((await f.call({ action: 'claim', worker, kind: 'index' })).json().job.id).toBe(jobId);
    expect(f.jobs.claim).toHaveBeenCalledWith(worker, 'index', 30000, 'internal-search-index',{model_version:model,package_id:'pair',config_revision:revision,storage_generation:storage});
    f.job.payload.storage_generation = 'e'.repeat(64);
    expect((await f.call({ action: 'claim', worker, kind: 'index' })).statusCode).toBe(409);
    expect(f.jobs.cancel).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});
it('rejects wrong job generation/shard and lets only the catalog issue manifest paths', async () => {
  const f = fixture(); try {
    const input = { action: 'begin', job_id: jobId, worker, generation: 1, shard_id: shard };
    expect((await f.call({ ...input, generation: 2 })).statusCode).toBe(409);
    expect((await f.call({ ...input, shard_id: randomUUID() })).statusCode).toBe(409);
    expect((await f.call(input)).json().manifest_key).toBe(`${shard}/2.manifest.json`);
    expect(f.shards.begin).toHaveBeenCalledWith(shard, jobId, worker, 1, storage);
  } finally { await f.app.close(); }
});
it('finishes a job only after publication and supports identical successful replay', async () => {
  const f = fixture(); try {
    const publication = { manifestSha256: 'e'.repeat(64), checkpoint: 1, records: 2, bytes: 300 };
    const input = { action: 'publish', job_id: jobId, worker, generation: 1, shard_id: shard, build_revision: 2, publication };
    f.shards.publish.mockResolvedValueOnce(false);
    expect((await f.call(input)).statusCode).toBe(409); expect(f.jobs.finish).not.toHaveBeenCalled();
    expect((await f.call(input)).json()).toEqual({ published: true });
    f.jobs.get.mockResolvedValue({ ...f.job, state: 'succeeded', result_ref: `shard:${shard}:2` });
    f.shards.published.mockResolvedValue({ published_revision: '2', manifest_sha256: publication.manifestSha256,
      checkpoint: '1', record_count: 2, byte_count: '300' });
    expect((await f.call(input)).json()).toEqual({ published: true });
    expect((await f.call({ ...input, publication: { ...publication, bytes: 301 } })).statusCode).toBe(409);
  } finally { await f.app.close(); }
});
it('does not leak PG/vendor errors or allow published metadata outside the current source scope', async () => {
  const f = fixture(); try {
    f.shards.published.mockResolvedValueOnce({ channel_id: randomUUID(), day });
    expect((await f.call({ action: 'published', shard_id: shard })).statusCode).toBe(403);
    f.jobs.claim.mockRejectedValueOnce(new Error('postgresql://password@private'));
    const response = await f.call({ action: 'claim', worker, kind: 'index' });
    expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ error: 'index_unavailable' });
  } finally { await f.app.close(); }
});

it('target index context comes only from a current migration lease and never selects source jobs',async()=>{
 const f=fixture(),target='search-v1-'+'e'.repeat(64),proof={job_id:randomUUID(),worker:randomUUID(),generation:2,actor:'human',payload_fingerprint:'f'.repeat(64)};
 const grant={...proof,source:{package_id:'pair',model_version:model,package_sha256:'d'.repeat(64)},target:{package_id:'next',model_version:target,package_sha256:'e'.repeat(64)},
 scope:{channel_ids:[channel],from_ms:Date.parse(day),to_ms:Date.parse(day)+86400000},source_high_watermark:'100',lease_until_ms:Date.now()+20000,job_expires_ms:Date.now()+86400000};
 try{
  expect((await f.call({action:'enqueue',request_key:randomUUID(),channel_id:channel,model_version:target,day,kind:'index'})).statusCode).toBe(403);
  f.jobs.authorizeMigrationArtifacts.mockResolvedValue(grant);
  const key=randomUUID();expect((await f.call({action:'enqueue',request_key:key,channel_id:channel,model_version:target,day,kind:'index',migration_lease:proof})).statusCode).toBe(200);
  expect(f.jobs.enqueue).toHaveBeenLastCalledWith('internal-search-index',key,'index',expect.objectContaining({package_id:'next',model_version:target}));
  f.job.payload.model_version=target;f.job.payload.package_id='next';
  expect((await f.call({action:'claim',worker,kind:'index',migration_lease:proof})).statusCode).toBe(200);
  expect(f.jobs.claim).toHaveBeenLastCalledWith(worker,'index',30000,'internal-search-index',{model_version:target,package_id:'next',config_revision:revision,storage_generation:storage});
  f.jobs.authorizeMigrationArtifacts.mockResolvedValueOnce(null);
  expect((await f.call({action:'claim',worker,kind:'index',migration_lease:proof})).statusCode).toBe(409);
  expect(f.jobs.cancel).not.toHaveBeenCalled();
 }finally{await f.app.close();}
});
it('target authority expiry after publication is stale/unknown rather than a false successful migration',async()=>{
 const f=fixture(),proof={job_id:randomUUID(),worker:randomUUID(),generation:1,actor:'human',payload_fingerprint:'f'.repeat(64)},
 grant={...proof,source:{package_id:'pair',package_sha256:'d'.repeat(64),model_version:model},target:{package_id:'pair',package_sha256:'d'.repeat(64),model_version:model},scope:{channel_ids:[channel],from_ms:Date.parse(day),to_ms:Date.parse(day)+86400000},source_high_watermark:'100',lease_until_ms:Date.now()+20000,job_expires_ms:Date.now()+86400000};
 try{
 f.jobs.authorizeMigrationArtifacts.mockResolvedValueOnce(grant).mockResolvedValueOnce(null);
 const result=await f.call({action:'publish',job_id:jobId,worker,generation:1,shard_id:shard,build_revision:2,migration_lease:proof,publication:{manifestSha256:'a'.repeat(64),checkpoint:10,records:1,bytes:1}});
 expect(result.statusCode).toBe(409);expect(result.json()).toEqual({error:'index_job_stale'});expect(f.shards.publish).toHaveBeenCalledOnce();
 }finally{await f.app.close();}
});
it('a migration proof cannot request a different target model, channel, day or caller supplied secret',async()=>{
 const f=fixture(),proof={job_id:randomUUID(),worker:randomUUID(),generation:1,actor:'human',payload_fingerprint:'f'.repeat(64)},target='search-v1-'+'e'.repeat(64);
 f.jobs.authorizeMigrationArtifacts.mockResolvedValue({...proof,source:{package_id:'pair',package_sha256:'d'.repeat(64),model_version:model},target:{package_id:'next',package_sha256:'e'.repeat(64),model_version:target},scope:{channel_ids:[channel],from_ms:Date.parse(day),to_ms:Date.parse(day)+86400000},source_high_watermark:'100',lease_until_ms:Date.now()+20000,job_expires_ms:Date.now()+86400000});
 try{const base={action:'enqueue',request_key:randomUUID(),channel_id:channel,model_version:target,day,kind:'index',migration_lease:proof};
 expect((await f.call({...base,model_version:model})).statusCode).toBe(403);expect((await f.call({...base,channel_id:randomUUID()})).statusCode).toBe(403);
 expect((await f.call({...base,day:'2000-01-01'})).statusCode).toBe(400);expect((await f.call({...base,migration_lease:{...proof,key:'secret'}})).statusCode).toBe(400);
 expect(f.shards.ensure).not.toHaveBeenCalled();}finally{await f.app.close();}
});
