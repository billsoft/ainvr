import Fastify from 'fastify';
import { searchIndexRoutes } from '../routes/searchIndexRoutes.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { SearchJobs } from '../store/searchJobs.js';
import { SearchIndexShards } from '../store/searchIndexShards.js';
const enabled = process.env.AINVR_SEARCH_TEST_PG === '1';
const storage = 'a'.repeat(64), publication = { manifestSha256: 'b'.repeat(64), checkpoint: 42, records: 12, bytes: 4000 };
async function isolated(test: (shards: SearchIndexShards, jobs: SearchJobs, pool: Pool) => Promise<void>) {
  const schema = 'search_' + randomUUID().replaceAll('-', '');
  const connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
  const admin = new Pool(connection); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
  try {
    for (const name of ['017_search.sql', '019_search_shard_publication.sql', '021_search_refresh_gc.sql'])
      await pool.query(readFileSync(new URL('../store/migrations/' + name, import.meta.url), 'utf8'));
    await test(new SearchIndexShards(pool), new SearchJobs(pool), pool);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}
async function build(shards: SearchIndexShards, jobs: SearchJobs, id: string, generation = storage) {
  const job = await jobs.enqueue('operator', randomUUID(), 'index', { shard_id: id });
  const worker = randomUUID(), claim = await jobs.claim(worker, 'index');
  expect(claim?.id).toBe(job.id);
  return (await shards.begin(id, job.id, worker, claim!.generation, generation))!;
}
it.skipIf(!enabled)('concurrent directory preparation is idempotent and validates dates/identities', async () => isolated(async shards => {
  const channel = randomUUID();
  const ids = await Promise.all(Array.from({ length: 5 }, () => shards.ensure(channel, 'pair-v1', '2026-10-28')));
  expect(new Set(ids).size).toBe(1);
  await expect(shards.ensure(channel, 'pair-v1', '2026-02-30')).rejects.toThrow();
  await expect(shards.ensure(channel, '../model', '2026-10-28')).rejects.toThrow();
}));
it.skipIf(!enabled)('only a live matching job publishes; replay preserves identical generation', async () => isolated(async (shards, jobs) => {
  const id = await shards.ensure(randomUUID(), 'pair-v1', '2026-10-28');
  const lease = await build(shards, jobs, id);
  expect(await shards.begin(id, lease.jobId, lease.worker, lease.jobGeneration, storage)).toEqual(lease);
  expect(await shards.publish(lease, publication)).toBe(true);
  expect(await shards.begin(id, lease.jobId, lease.worker, lease.jobGeneration, storage)).toEqual(lease);
  expect(await shards.publish(lease, publication)).toBe(true);
  expect(await shards.publish(lease, { ...publication, records: 13 })).toBe(false);
  expect((await shards.published(id, storage)).manifest_key).toBe(SearchIndexShards.manifestKey(lease));
  expect(await shards.published(id, 'c'.repeat(64))).toBeNull();
}));
it.skipIf(!enabled)('cancelled and expired jobs cannot publish and another active builder cannot steal', async () => isolated(async (shards, jobs, pool) => {
  const id = await shards.ensure(randomUUID(), 'pair-v1', '2026-10-28'), first = await build(shards, jobs, id);
  const secondJob = await jobs.enqueue('other', randomUUID(), 'index', { shard_id: id });
  const worker = randomUUID(), second = await jobs.claim(worker, 'index'); expect(second?.id).toBe(secondJob.id);
  expect(await shards.begin(id, second!.id, worker, second!.generation, storage)).toBeNull();
  await jobs.cancel(first.jobId, 'operator'); expect(await shards.publish(first, publication)).toBe(false);
  expect(await shards.begin(id, second!.id, worker, second!.generation, storage)).toBeNull();
  expect((await shards.retired(id, storage))!.revision).toBe(first.revision);
  expect(await shards.confirmCleanup(id, first.revision, storage)).toBe(true);
  const next = await shards.begin(id, second!.id, worker, second!.generation, storage); expect(next!.revision).toBeGreaterThan(first.revision);
  await pool.query("UPDATE search_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [second!.id]);
  expect(await shards.publish(next!, publication)).toBe(false);
}));
it.skipIf(!enabled)('new mount generation cannot adopt an old manifest; same-mount rebuild preserves a partial view', async () => isolated(async (shards, jobs) => {
  const channel = randomUUID(), id = await shards.ensure(channel, 'pair-v1', '2026-10-28', storage), first = await build(shards, jobs, id);
  expect(await shards.publish(first, publication)).toBe(true);
  await jobs.finish(first.jobId, first.worker, first.jobGeneration, { resultRef: 'shard:ready' });
  const next = await build(shards, jobs, id); expect((await shards.published(id, storage)).partial).toBe(true);
  await jobs.cancel(next.jobId, 'operator');
  const movedId = await shards.ensure(channel, 'pair-v1', '2026-10-28', 'c'.repeat(64)); expect(movedId).not.toBe(id);
  const moved = await build(shards, jobs, movedId, 'c'.repeat(64));
  expect(await shards.published(id, 'c'.repeat(64))).toBeNull();
  expect(await shards.publish(next, publication)).toBe(false);
  expect(await shards.publish(moved, publication)).toBe(true);
}));
it.skipIf(!enabled)('job for another shard and unsafe manifest identities are rejected', async () => isolated(async (shards, jobs) => {
  const a = await shards.ensure(randomUUID(), 'pair-v1', '2026-10-28');
  const b = await shards.ensure(randomUUID(), 'pair-v1', '2026-10-28');
  const lease = await build(shards, jobs, a);
  expect(await shards.begin(b, lease.jobId, lease.worker, lease.jobGeneration, storage)).toBeNull();
  expect(await shards.publish({ ...lease, id: b }, publication)).toBe(false);
  expect(() => SearchIndexShards.manifestKey({ ...lease, id: '../etc' })).toThrow();
}));

it.skipIf(!enabled)('HTTP and real PG complete a scoped publication, retry and mount-change cycle', async () => isolated(async (shards, jobs) => {
  // The manifest is a protocol fixture, not an actual SSD-file verification.
  const channel = randomUUID(), worker = randomUUID(), revision = 'd'.repeat(64);
  const day = new Date().toISOString().slice(0, 10), model = 'search-v1-' + 'e'.repeat(64);
  let generation = storage;
  const app = Fastify();
  await app.register(searchIndexRoutes, { principal: async request => request.headers['x-service-token'] === 'search',
    context: async () => ({ revision, storageGeneration: generation, packageId: 'pair', modelVersion:model,channels: [channel], retentionDays: 30 }), jobs, shards });
  const call = (body: object) => app.inject({ method: 'POST', url: '/internal/search/index-jobs', headers: { 'x-service-token': 'search' }, payload: { revision, ...body } });
  try {
    const queued = await call({ action: 'enqueue', channel_id: channel, model_version: model, day, kind: 'index', request_key: randomUUID() });
    expect(queued.statusCode).toBe(200); const { job_id, shard_id } = queued.json();
    const claimed = (await call({ action: 'claim', worker, kind: 'index' })).json().job;
    expect(claimed.id).toBe(job_id);
    const begun = await call({ action: 'begin', job_id, shard_id, worker, generation: claimed.generation });
    expect(begun.statusCode).toBe(200);
    const input = { action: 'publish', job_id, shard_id, worker, generation: claimed.generation, build_revision: begun.json().lease.revision, publication };
    expect((await call(input)).json()).toEqual({ published: true });
    expect((await call(input)).json()).toEqual({ published: true });
    expect((await jobs.get(job_id, 'internal-search-index'))!.state).toBe('succeeded');
    const saved = (await call({ action: 'published', shard_id })).json().shard;
    expect(saved.channel_id).toBe(channel); expect(saved.day).toBe(day);
    generation = 'f'.repeat(64);
    expect((await call({ action: 'published', shard_id })).json()).toEqual({ shard: null });
    expect((await call(input)).statusCode).toBe(409);
  } finally { await app.close(); }
}));
