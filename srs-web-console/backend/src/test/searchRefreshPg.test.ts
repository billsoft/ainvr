import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { SearchJobs, indexRefreshRequestKey } from '../store/searchJobs.js';
import { SearchIndexShards } from '../store/searchIndexShards.js';
import { searchIndexRoutes } from '../routes/searchIndexRoutes.js';
const enabled = process.env.AINVR_SEARCH_TEST_PG === '1';
const storage = 'a'.repeat(64), revision = 'b'.repeat(64), model = 'search-v1-' + 'c'.repeat(64);
const today = () => new Date().toISOString().slice(0, 10);
const ago = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
async function isolated(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const schema = 'search_' + randomUUID().replaceAll('-', '');
  const connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
  const admin = new Pool(connection); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...connection, options: `-c search_path=${schema}`, max: 40 });
  try {
    for (const name of ['017_search.sql', '019_search_shard_publication.sql', '021_search_refresh_gc.sql'])
      await pool.query(readFileSync(new URL('../store/migrations/' + name, import.meta.url), 'utf8'));
    await run(await fixture(pool));
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}
it.skipIf(!enabled)('021 preserves a legacy mixed-mount publication and abandoned build as two exact authorities', async () => {
  const schema = 'search_' + randomUUID().replaceAll('-', ''), connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
  const admin = new Pool(connection); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
  try {
    for (const name of ['017_search.sql', '019_search_shard_publication.sql']) await pool.query(readFileSync(new URL('../store/migrations/' + name, import.meta.url), 'utf8'));
    const oldShards = new SearchIndexShards(pool), id = randomUUID(), job = randomUUID(), worker = randomUUID(), other = 'e'.repeat(64);
    await pool.query(`INSERT INTO search_jobs(id,actor,request_key,fingerprint,kind,payload,state,generation,attempts,lease_owner,lease_until,expires_at)
      VALUES($1,'internal-search-index',$2,$3,'index',$4,'running',1,1,$5,clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 day')`,
      [job, randomUUID(), 'f'.repeat(64), JSON.stringify({ shard_id: id }), worker]);
    await pool.query(`INSERT INTO search_index_shards(id,channel_id,model_version,day,state,revision,storage_generation,build_job_id,build_job_generation,
      published_revision,published_storage_generation,manifest_key,manifest_sha256,checkpoint,record_count,byte_count)
      VALUES($1,$2,$3,$4,'building',3,$5,$6,1,2,$7,$8,$9,100,1,100)`,
      [id,randomUUID(),model,today(),other,job,storage,`${id}/2.manifest.json`,'d'.repeat(64)]);
    await pool.query(readFileSync(new URL('../store/migrations/021_search_refresh_gc.sql', import.meta.url), 'utf8'));
    const published = await oldShards.published(id, storage); expect(published!.published_revision).toBe('2');
    const orphan = await oldShards.retired(id, other); expect(orphan!.revision).toBe(3); expect(orphan!.manifest_key).toBe(`${id}/3.manifest.json`);
    expect((await pool.query('SELECT state,lease_owner FROM search_jobs WHERE id=$1',[job])).rows[0]).toEqual({state:'cancelled',lease_owner:null});
    expect(await oldShards.ensure(published!.channel_id,model,today(),other)).not.toBe(id);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
async function fixture(pool: Pool) {
  const jobs = new SearchJobs(pool), shards = new SearchIndexShards(pool), channel = randomUUID();
  async function payload(source = channel, day = today(), sg = storage) {
    return { shard_id: await shards.ensure(source, model, day, sg), channel_id: source, model_version: model, day,
      storage_generation: sg, config_revision: revision, package_id: 'siglip2-base-full-int8' };
  }
  const refresh = async (p: Awaited<ReturnType<typeof payload>>, cp: number) => jobs.refreshIndex(indexRefreshRequestKey(p, cp), p, cp, 30);
  async function claim() { const worker = randomUUID(); const job = await jobs.claim(worker, 'index', 30000, 'internal-search-index'); return { worker, job: job! }; }
  async function publish(p: Awaited<ReturnType<typeof payload>>, cp: number) {
    const c = await claim(); expect(c.job).not.toBeNull();
    const lease = (await shards.begin(p.shard_id, c.job.id, c.worker, c.job.generation, p.storage_generation))!;
    expect(lease).not.toBeNull();
    expect(await shards.publish(lease, { manifestSha256: 'd'.repeat(64), checkpoint: cp, records: 1, bytes: 100 })).toBe(true);
    return { ...c, lease };
  }
  return { pool, jobs, shards, channel, payload, refresh, claim, publish };
}
it.skipIf(!enabled)('refresh coalesces demand while a live lease keeps its frozen watermark and generation', async () => isolated(async f => {
  const p = await f.payload(), first = await f.refresh(p, 10);
  expect((await f.refresh(p, 10)).id).toBe(first.id);
  const c = await f.claim(); expect(Number(c.job.claimed_checkpoint)).toBe(10);
  const raised = await f.refresh(p, 20); expect(raised.id).toBe(first.id); expect(raised.generation).toBe(c.job.generation);
  expect(raised.state).toBe('running'); expect(raised.lease_owner).toBe(c.worker);
  const lease = (await f.shards.begin(p.shard_id, first.id, c.worker, c.job.generation, storage))!;
  expect(await f.shards.publish(lease, { manifestSha256: 'd'.repeat(64), checkpoint: 9, records: 0, bytes: 0 })).toBe(false);
  expect(await f.shards.publish(lease, { manifestSha256: 'd'.repeat(64), checkpoint: 10, records: 0, bytes: 0 })).toBe(true);
  expect(await f.jobs.finish(first.id, c.worker, c.job.generation, { resultRef: `shard:${p.shard_id}:${lease.revision}`, checkpoint: 10 })).toBe(true);
  const next = await f.jobs.get(first.id, 'internal-search-index'); expect(next!.state).toBe('pending'); expect(next!.attempts).toBe(0);
  const completed = await f.publish(p, 20);
  expect(await f.jobs.finish(first.id, completed.worker, completed.job.generation, { resultRef: `shard:${p.shard_id}:${completed.lease.revision}`, checkpoint: 20 })).toBe(true);
  expect((await f.refresh(p, 20)).state).toBe('succeeded'); expect(await f.jobs.claim(randomUUID(), 'index', 30000, 'internal-search-index')).toBeNull();
}));
it.skipIf(!enabled)('durable publication survives a lost finish ACK without duplicate execution', async () => isolated(async f => {
  const p = await f.payload(); await f.refresh(p, 100); const c = await f.publish(p, 100);
  await f.pool.query("UPDATE search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [c.job.id]);
  expect(await f.jobs.claim(randomUUID(), 'index', 30000, 'internal-search-index')).toBeNull();
  const reconciled = await f.jobs.get(c.job.id, 'internal-search-index'); expect(reconciled!.state).toBe('succeeded');
  expect(Number(reconciled!.completed_checkpoint)).toBe(100);
}));
it.skipIf(!enabled)('each claimed refresh generation clears prior result/error while retaining completed coverage', async () => isolated(async f => {
  const p=await f.payload();await f.refresh(p,2);const first=await f.publish(p,2);
  await f.jobs.finish(first.job.id,first.worker,first.job.generation,{resultRef:`shard:${p.shard_id}:${first.lease.revision}`,checkpoint:2});
  await f.refresh(p,3);const next=await f.claim();
  expect(next.job.result_ref).toBeNull();expect(next.job.error_code).toBeNull();expect(Number(next.job.completed_checkpoint)).toBe(2);
  await f.jobs.finish(next.job.id,next.worker,next.job.generation,{errorCode:'history_unavailable'});
  const retry=await f.claim();expect(retry.job.error_code).toBeNull();expect(retry.job.result_ref).toBeNull();
  expect(Number(retry.job.completed_checkpoint)).toBe(2);expect(retry.job.generation).toBe(next.job.generation+1);
}));
it.skipIf(!enabled)('100 camera refresh partitions do not consume user queue quotas and running leases are atomically capped', async () => isolated(async f => {
  for (let i = 0; i < 100; i++) await f.refresh(await f.payload(randomUUID()), i + 1);
  expect(Number((await f.pool.query('SELECT count(*) AS n FROM search_jobs')).rows[0].n)).toBe(100);
  for (let i = 0; i < 32; i++) await f.jobs.enqueue('operator', randomUUID(), 'verify', {});
  await expect(f.jobs.enqueue('operator', randomUUID(), 'verify', {})).rejects.toThrow('actor_queue_full');
  const claims = await Promise.all(Array.from({ length: 40 }, () => f.jobs.claim(randomUUID(), 'index', 30000, 'internal-search-index')));
  expect(claims.filter(Boolean)).toHaveLength(32);
  expect(Number((await f.pool.query("SELECT count(*) AS n FROM search_jobs WHERE state='running'")).rows[0].n)).toBe(32);
  expect(await f.jobs.claim(randomUUID(), 'index')).toBeNull();
}));
it.skipIf(!enabled)('failed refresh attempts are bounded; only a newer watermark re-arms terminal work', async () => isolated(async f => {
  const p = await f.payload(), first = await f.refresh(p, 10);
  for (let i = 0; i < 3; i++) { const c = await f.claim(); expect(await f.jobs.finish(c.job.id, c.worker, c.job.generation, { errorCode: 'history_unavailable' })).toBe(true); }
  expect((await f.refresh(p, 10)).state).toBe('failed'); expect(await f.jobs.claim(randomUUID(), 'index', 30000, 'internal-search-index')).toBeNull();
  const next = await f.refresh(p, 11); expect(next.id).toBe(first.id); expect(next.state).toBe('pending'); expect(next.attempts).toBe(0);
  expect(next.expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
}));
it.skipIf(!enabled)('old and new storage generations own distinct directories and retired slots never migrate across mounts', async () => isolated(async f => {
  const p = await f.payload(); await f.refresh(p, 1); const first = await f.publish(p, 1);
  await f.jobs.finish(first.job.id, first.worker, first.job.generation, { resultRef: 'shard:one', checkpoint: 1 });
  await f.refresh(p, 2); const next = await f.publish(p, 2);
  expect((await f.shards.retired(p.shard_id, storage))!.revision).toBe(first.lease.revision);
  await f.jobs.finish(next.job.id, next.worker, next.job.generation, { resultRef: 'shard:two', checkpoint: 2 });
  const newMount = await f.payload(f.channel, today(), 'e'.repeat(64)); expect(newMount.shard_id).not.toBe(p.shard_id);
  expect(await f.shards.published(p.shard_id, 'e'.repeat(64))).toBeNull();
  expect(await f.shards.confirmCleanup(p.shard_id, first.lease.revision + 1, storage)).toBe(false);
  expect(await f.shards.confirmCleanup(p.shard_id, first.lease.revision, storage)).toBe(true);
  expect(await f.shards.confirmCleanup(p.shard_id, first.lease.revision, storage)).toBe(true);
  expect((await f.shards.published(p.shard_id, storage))!.published_revision).toBe(String(next.lease.revision));
}));
it.skipIf(!enabled)('a crashed complete build is retired before a replacement generation may overwrite its identity', async () => isolated(async f => {
  const p = await f.payload(); await f.refresh(p, 1); const a = await f.claim();
  const lease = (await f.shards.begin(p.shard_id, a.job.id, a.worker, a.job.generation, storage))!;
  await f.pool.query("UPDATE search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [a.job.id]);
  const b = await f.claim(); expect(b.job.generation).toBe(a.job.generation + 1);
  expect(await f.shards.begin(p.shard_id, b.job.id, b.worker, b.job.generation, storage)).toBeNull();
  expect((await f.shards.retired(p.shard_id, storage))!.manifest_key).toBe(`${p.shard_id}/${lease.revision}.manifest.json`);
  expect(await f.shards.publish(lease, { manifestSha256: 'd'.repeat(64), checkpoint: 1, records: 0, bytes: 0 })).toBe(false);
  expect(await f.shards.confirmCleanup(p.shard_id, lease.revision, storage)).toBe(true);
  expect((await f.shards.begin(p.shard_id, b.job.id, b.worker, b.job.generation, storage))!.revision).toBeGreaterThan(lease.revision);
}));
it.skipIf(!enabled)('discard after explicit failure authorizes only the exact unpublished build, never a successful publication', async () => isolated(async f => {
  const p = await f.payload(); await f.refresh(p, 1); const c = await f.claim();
  const lease = (await f.shards.begin(p.shard_id, c.job.id, c.worker, c.job.generation, storage))!;
  await f.jobs.finish(c.job.id, c.worker, c.job.generation, { errorCode: 'index_capacity' });
  expect(await f.shards.discardBuild(p.shard_id, lease.revision, c.job.id, randomUUID(), c.job.generation, storage)).toBe(false);
  expect(await f.shards.discardBuild(p.shard_id, lease.revision, c.job.id, c.worker, c.job.generation + 1, storage)).toBe(false);
  expect(await f.shards.discardBuild(p.shard_id, lease.revision, c.job.id, c.worker, c.job.generation, storage)).toBe(true);
  expect(await f.shards.discardBuild(p.shard_id, lease.revision, c.job.id, c.worker, c.job.generation, storage)).toBe(true);
  expect(await f.shards.confirmCleanup(p.shard_id, lease.revision, storage)).toBe(true);
  expect(await f.shards.discardBuild(p.shard_id, lease.revision, c.job.id, c.worker, c.job.generation, storage)).toBe(true);
  await f.refresh(p, 2); const done = await f.publish(p, 2);
  expect(await f.shards.discardBuild(p.shard_id, done.lease.revision, done.job.id, done.worker, done.job.generation, storage)).toBe(false);
}));
it.skipIf(!enabled)('an unknown publish may be revoked after lease expiry, but publication and revocation cannot both win', async () => isolated(async f => {
  for (let i = 0; i < 4; i++) {
    const p = await f.payload(randomUUID()); await f.refresh(p, 1); const c = await f.claim();
    const lease = (await f.shards.begin(p.shard_id, c.job.id, c.worker, c.job.generation, storage))!;
    if (i === 0) {
      await f.pool.query("UPDATE search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [c.job.id]);
      expect(await f.shards.discardBuild(p.shard_id, lease.revision, c.job.id, c.worker, c.job.generation, storage)).toBe(true);
      expect(await f.shards.publish(lease, { manifestSha256: 'd'.repeat(64), checkpoint: 1, records: 0, bytes: 0 })).toBe(false);
    } else {
      const result = await Promise.all([
        f.shards.publish(lease, { manifestSha256: 'd'.repeat(64), checkpoint: 1, records: 0, bytes: 0 }),
        f.shards.discardBuild(p.shard_id, lease.revision, c.job.id, c.worker, c.job.generation, storage),
      ]);
      expect(result.filter(Boolean)).toHaveLength(1);
    }
    await f.jobs.cancel(c.job.id, 'internal-search-index');
  }
}));
it.skipIf(!enabled)('exact unknown-publication cleanup re-arms a static partition without a new watermark, bounded by the original attempt budget', async () => isolated(async f => {
  const p = await f.payload(), original = await f.refresh(p, 10);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const c = await f.claim(); expect(c.job.id).toBe(original.id); expect(c.job.attempts).toBe(attempt);
    const lease = (await f.shards.begin(p.shard_id, c.job.id, c.worker, c.job.generation, storage))!;
    expect(await f.shards.discardBuild(p.shard_id, lease.revision, c.job.id, c.worker, c.job.generation, storage)).toBe(true);
    expect((await f.refresh(p, 10)).state).toBe('cancelled');
    expect(await f.jobs.claim(randomUUID(), 'index', 30000, 'internal-search-index')).toBeNull();
    expect(await f.shards.confirmCleanup(p.shard_id, lease.revision, storage)).toBe(true);
    expect(await f.shards.confirmCleanup(p.shard_id, lease.revision, storage)).toBe(true);
    const after = (await f.jobs.get(original.id, 'internal-search-index'))!;
    expect(after.generation).toBe(c.job.generation + 1); expect(after.attempts).toBe(attempt);
    expect(after.state).toBe(attempt < 3 ? 'pending' : 'failed');
  }
  expect((await f.refresh(p, 10)).state).toBe('failed'); expect(await f.jobs.claim(randomUUID(), 'index', 30000, 'internal-search-index')).toBeNull();
  expect((await f.refresh(p, 11)).state).toBe('pending');
}));
it.skipIf(!enabled)('static work rebuilt after one unknown revocation reaches publication, while manual cancellation never re-arms', async () => isolated(async f => {
  const p = await f.payload(), first = await f.refresh(p, 42), c = await f.claim();
  const lease = (await f.shards.begin(p.shard_id, c.job.id, c.worker, c.job.generation, storage))!;
  expect(await f.shards.discardBuild(p.shard_id, lease.revision, c.job.id, c.worker, c.job.generation, storage)).toBe(true);
  await f.shards.confirmCleanup(p.shard_id, lease.revision, storage);
  const retry = await f.publish(p, 42); expect(retry.job.id).toBe(first.id);
  await f.jobs.finish(retry.job.id, retry.worker, retry.job.generation, { resultRef: 'shard:complete', checkpoint: 42 });
  expect((await f.refresh(p, 42)).state).toBe('succeeded');
  const q = await f.payload(randomUUID()); await f.refresh(q, 1); const manual = await f.claim();
  const build = (await f.shards.begin(q.shard_id, manual.job.id, manual.worker, manual.job.generation, storage))!;
  await f.jobs.cancel(manual.job.id, 'internal-search-index');
  expect(await f.shards.discardBuild(q.shard_id, build.revision, manual.job.id, manual.worker, manual.job.generation, storage)).toBe(true);
  await f.shards.confirmCleanup(q.shard_id, build.revision, storage);
  expect((await f.refresh(q, 1)).state).toBe('cancelled');
  expect(await f.jobs.claim(randomUUID(), 'index', 30000, 'internal-search-index')).toBeNull();
}));
it.skipIf(!enabled)('expired unfinished builds retain their job proof until bounded retired cleanup completes', async () => isolated(async f => {
  const p = await f.payload(); await f.refresh(p, 1); const c = await f.claim();
  const lease = (await f.shards.begin(p.shard_id, c.job.id, c.worker, c.job.generation, storage))!;
  await f.pool.query("UPDATE search_jobs SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day',lease_until=clock_timestamp()-interval '1 day' WHERE id=$1", [c.job.id]);
  await f.jobs.enqueue('operator', randomUUID(), 'verify', {});
  expect(await f.jobs.get(c.job.id, 'internal-search-index', true)).not.toBeNull();
  const retired = await f.shards.retiredCatalog(model, storage, [f.channel], 30, null, 16);
  expect(retired.items[0]!.revision).toBe(lease.revision);
  expect(await f.shards.confirmCleanup(p.shard_id, lease.revision, storage)).toBe(true);
  await f.jobs.enqueue('operator', randomUUID(), 'verify', {});
  expect(await f.jobs.get(c.job.id, 'internal-search-index', true)).toBeNull();
}));
it.skipIf(!enabled)('a single retired slot blocks another publication generation without losing the last readable publication', async () => isolated(async f => {
  const p = await f.payload(); await f.refresh(p, 1); const a = await f.publish(p, 1);
  await f.jobs.finish(a.job.id, a.worker, a.job.generation, { resultRef: 'shard:one', checkpoint: 1 });
  await f.refresh(p, 2); const b = await f.publish(p, 2);
  await f.jobs.finish(b.job.id, b.worker, b.job.generation, { resultRef: 'shard:two', checkpoint: 2 });
  await f.refresh(p, 3); const c = await f.claim();
  expect(await f.shards.begin(p.shard_id, c.job.id, c.worker, c.job.generation, storage)).toBeNull();
  expect(Number((await f.shards.published(p.shard_id, storage))!.published_revision)).toBe(b.lease.revision);
  expect(await f.shards.confirmCleanup(p.shard_id, a.lease.revision, storage)).toBe(true);
  expect((await f.shards.begin(p.shard_id, c.job.id, c.worker, c.job.generation, storage))!.revision).toBeGreaterThan(b.lease.revision);
}));
it.skipIf(!enabled)('bounded catalogs include the rolling oldest partial day and GC retires only expired whole days', async () => isolated(async f => {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) { const p = await f.payload(f.channel, ago(i === 0 ? 30 : i === 1 ? 31 : 0)); ids.push(p.shard_id);
    await f.refresh(p, 1); const c = await f.publish(p, 1); await f.jobs.finish(c.job.id, c.worker, c.job.generation, { resultRef: 'shard:ok', checkpoint: 1 }); }
  const a = await f.shards.catalog(model, storage, [f.channel], 30, null, 1); expect(a.items).toHaveLength(1); expect(a.nextCursor).toBe(a.items[0].id);
  const b = await f.shards.catalog(model, storage, [f.channel], 30, a.nextCursor, 1); expect(b.items).toHaveLength(1); expect(b.nextCursor).toBeNull();
  expect(new Set([...a.items, ...b.items].map(x => x.id))).toEqual(new Set([ids[0], ids[2]]));
  const retired = await f.shards.retiredCatalog(model, storage, [f.channel], 30, null, 16);
  expect(retired.items.map(x => x.id)).toEqual([ids[1]]); expect(typeof retired.items[0].revision).toBe('number');
  expect(await f.shards.published(ids[0]!, storage)).not.toBeNull();
  expect(await f.shards.confirmCleanup(ids[1]!, retired.items[0].revision, storage)).toBe(true);
  await f.shards.retiredCatalog(model, storage, [f.channel], 30, null, 16);
  expect(await f.shards.confirmCleanup(ids[1]!, retired.items[0].revision, storage)).toBe(true);
}));
it.skipIf(!enabled)('real HTTP refresh/catalog/GC preserve strict shape, numeric watermarks and scoped authorization', async () => isolated(async f => {
  const app = Fastify(); await app.register(searchIndexRoutes, { principal: async r => r.headers['x-service-token'] === 'fixture-search',
    context: async () => ({ revision, storageGeneration: storage, packageId: 'siglip2-base-full-int8',modelVersion:model, channels: [f.channel], retentionDays: 30 }), jobs: f.jobs, shards: f.shards });
  const call = (body: object) => app.inject({ method: 'POST', url: '/internal/search/index-jobs', headers: { 'x-service-token': 'fixture-search' }, payload: { revision, ...body } });
  try {
    const p = await f.payload(f.channel, ago(30));
    const input = { action: 'refresh', request_key: indexRefreshRequestKey(p, 50), channel_id: f.channel, model_version: model, day: p.day, minimum_checkpoint: 50 };
    const result = await call(input); expect(result.statusCode).toBe(200); expect(result.json().accepted_checkpoint).toBe(50);
    expect(Object.keys(result.json()).sort()).toEqual(['accepted_checkpoint', 'job_id', 'shard_id', 'state']);
    expect((await call({ ...input, day: ago(31) })).statusCode).toBe(400);
    const worker = randomUUID(), claimed = (await call({ action: 'claim', worker, kind: 'index' })).json().job;
    expect(claimed.minimum_checkpoint).toBe(50); expect(claimed.refresh_scope).toBeUndefined(); expect(claimed.requested_checkpoint).toBeUndefined();
    const begun = (await call({ action: 'begin', worker, generation: claimed.generation, job_id: claimed.id, shard_id: p.shard_id })).json();
    const pub = { action: 'publish', worker, generation: claimed.generation, job_id: claimed.id, shard_id: p.shard_id, build_revision: begun.lease.revision,
      publication: { manifestSha256: 'd'.repeat(64), checkpoint: 50, records: 0, bytes: 0 } };
    expect((await call(pub)).json()).toEqual({ published: true }); expect((await call(pub)).json()).toEqual({ published: true });
    const page = await call({ action: 'catalog', model_version: model, cursor: null, limit: 16 });
    expect(page.json().items).toHaveLength(1); expect(page.json().storage_generation).toBe(storage);
    expect((await call({ action: 'catalog', model_version: model, cursor: '../../other', limit: 16 })).statusCode).toBe(400);
    expect((await call({ action: 'discard_build', worker, generation: claimed.generation, job_id: claimed.id, shard_id: p.shard_id, build_revision: begun.lease.revision })).json()).toEqual({ discarded: false });
  } finally { await app.close(); }
}));
