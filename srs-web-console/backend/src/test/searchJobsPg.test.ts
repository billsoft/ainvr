import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { SearchJobs } from '../store/searchJobs.js';
const enabled = process.env.AINVR_SEARCH_TEST_PG === '1';
async function isolated(test: (store: SearchJobs, pool: Pool) => Promise<void>) {
  const schema = 'search_' + randomUUID().replaceAll('-', '');
  const connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
  const admin = new Pool(connection);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
  try {
    for (const name of ['017_search.sql', '019_search_shard_publication.sql', '021_search_refresh_gc.sql'])
      await pool.query(readFileSync(new URL('../store/migrations/' + name, import.meta.url), 'utf8'));
    await test(new SearchJobs(pool), pool);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}
it.skipIf(!enabled)('concurrent retries have one identity and conflicting retries fail', async () => isolated(async store => {
  const key = randomUUID();
  const jobs = await Promise.all(Array.from({ length: 5 }, () => store.enqueue('a', key, 'index', { source: 'one' })));
  expect(new Set(jobs.map(j => j.id)).size).toBe(1);
  await expect(store.enqueue('a', key, 'index', { source: 'two' })).rejects.toThrow('idempotency_conflict');
}));
it.skipIf(!enabled)('leases are exclusive and cancelled work cannot finish', async () => isolated(async store => {
  const job = await store.enqueue('a', randomUUID(), 'index', {});
  const workers = [randomUUID(), randomUUID()];
  const leases = await Promise.all(workers.map(w => store.claim(w, 'index')));
  expect(leases.filter(Boolean)).toHaveLength(1);
  const lease = leases.find(Boolean)!;
  expect(await store.cancel(job.id, 'other')).toBe(false);
  expect(await store.cancel(job.id, 'a')).toBe(true);
  expect(await store.finish(job.id, lease.lease_owner!, lease.generation, { resultRef: 'record:one' })).toBe(false);
  expect(await store.get(job.id, 'other')).toBeNull();
}));
it.skipIf(!enabled)('expired ownership cannot overwrite a new lease and attempts are bounded', async () => isolated(async (store, pool) => {
  const job = await store.enqueue('a', randomUUID(), 'rebuild', {}), first = await store.claim(randomUUID(), 'rebuild');
  await pool.query("UPDATE search_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
  const second = await store.claim(randomUUID(), 'rebuild');
  expect(second!.generation).toBe(first!.generation + 1);
  expect(await store.finish(job.id, first!.lease_owner!, first!.generation, { resultRef: 'old' })).toBe(false);
  await pool.query("UPDATE search_jobs SET lease_until=now()-interval '1 second',attempts=3 WHERE id=$1", [job.id]);
  expect(await store.claim(randomUUID(), 'rebuild')).toBeNull();
  expect((await store.get(job.id, 'a'))!.state).toBe('failed');
}));
it.skipIf(!enabled)('admission has a hard per-principal bound and expired rows are cleaned', async () => isolated(async (store, pool) => {
  for (let i = 0; i < 32; i++) await store.enqueue('a', randomUUID(), 'verify', {});
  await expect(store.enqueue('a', randomUUID(), 'verify', {})).rejects.toThrow('actor_queue_full');
  await pool.query("UPDATE search_jobs SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day'");
  await store.enqueue('a', randomUUID(), 'verify', {});
  expect(Number((await pool.query('SELECT count(*) AS n FROM search_jobs')).rows[0].n)).toBe(1);
}));

it.skipIf(!enabled)('a scoped claimant cannot take another principal indexing job', async () => isolated(async store => {
  const other = await store.enqueue('operator', randomUUID(), 'index', {});
  const own = await store.enqueue('internal-search-index', randomUUID(), 'index', {});
  const worker = randomUUID();
  expect((await store.claim(worker, 'index', 30000, 'internal-search-index'))!.id).toBe(own.id);
  expect(await store.claim(worker, 'index', 30000, 'internal-search-index')).toBeNull();
  expect((await store.get(other.id, 'operator'))!.state).toBe('pending');
}));

it.skipIf(!enabled)('verification claims rotate among actors without changing FIFO within each actor',async()=>isolated(async store=>{
  const a1=await store.enqueue('a',randomUUID(),'verify',{}),a2=await store.enqueue('a',randomUUID(),'verify',{});
  const b=await store.enqueue('b',randomUUID(),'verify',{}),c=await store.enqueue('c',randomUUID(),'verify',{});
  const recent:string[]=[];
  for(const expected of [a1,b,c,a2]){
    const job=await store.claim(randomUUID(),'verify',30000,undefined,undefined,recent);expect(job!.id).toBe(expected.id);
    recent.splice(0,recent.length,job!.actor,...recent.filter(actor=>actor!==job!.actor));
    expect(await store.finish(job!.id,job!.lease_owner!,job!.generation,{resultRef:'done'})).toBe(true);
  }
}));
it.skipIf(!enabled)('legacy verification recovery is generation fenced, actor scoped and rejects other failure outcomes',async()=>isolated(async(store,pool)=>{
  const job=await store.enqueue('a',randomUUID(),'verify',{}),lease=(await store.claim(randomUUID(),'verify'))!;
  await store.finish(job.id,lease.lease_owner!,lease.generation,{errorCode:'profile_changed'});
  expect(await store.retryUnsubmittedVerification(job.id,'other',lease.generation)).toBeNull();
  expect(await store.retryUnsubmittedVerification(job.id,'a',lease.generation-1)).toBeNull();
  const restored=await store.retryUnsubmittedVerification(job.id,'a',lease.generation);
  expect(restored).toMatchObject({id:job.id,state:'pending',attempts:0,generation:lease.generation+1});
  expect(await store.retryUnsubmittedVerification(job.id,'a',lease.generation)).toBeNull();
  const next=(await store.claim(randomUUID(),'verify'))!;
  expect(await store.finish(job.id,lease.lease_owner!,lease.generation,{resultRef:'old'})).toBe(false);
  await store.finish(job.id,next.lease_owner!,next.generation,{errorCode:'inference_failed'});
  expect(await store.retryUnsubmittedVerification(job.id,'a',next.generation)).toBeNull();
  expect((await pool.query('SELECT count(*)::int AS n FROM search_jobs')).rows[0].n).toBe(1);
}));
