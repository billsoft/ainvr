import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { SearchJobs, type SearchJob } from '../store/searchJobs.js';
import { searchModelMigrationFingerprint, type SearchModelMigrationPayload, type SearchModelMigrationProgress } from '../services/searchModelMigrationContract.js';
const enabled = process.env.AINVR_SEARCH_TEST_PG === '1';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (letter: string) => letter.repeat(64);
const payload: SearchModelMigrationPayload = { schema_version: 'search-reencode-v1', purpose: 'reencode',
  source: { package_id: 'siglip2-base-full-int8', package_sha256: hash('a'), model_version: `search-v1-${hash('b')}` },
  target: { package_id: 'siglip-so400m-i18n-full-int8', package_sha256: hash('c'), model_version: `search-v1-${hash('d')}` },
  scope: { channel_ids: [id(2), id(1)], from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' },
  config_revision: hash('e'), storage_generation: hash('f'), source_high_watermark: '9007199254740993', batch_size: 32,
  acceptance_criteria_sha256: hash('1') };
async function isolated(run: (store: SearchJobs, pool: Pool) => Promise<void>) {
  const schema = 'search_' + randomUUID().replaceAll('-', '');
  const connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
  const admin = new Pool(connection); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...connection, options: `-c search_path=${schema}`, max: 8 });
  try {
    for (const name of ['001_initial_schema.sql', '017_search.sql', '019_search_shard_publication.sql', '021_search_refresh_gc.sql', '022_search_model_migration.sql'])
      await pool.query(readFileSync(new URL('../store/migrations/' + name, import.meta.url), 'utf8'));
    await run(new SearchJobs(pool), pool);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}
const create = (jobs: SearchJobs, actor = 'operator', key = randomUUID()) => jobs.enqueueMigration(actor, key, payload);
const progress = (job: SearchJob) => job.migration_progress as SearchModelMigrationProgress;
const batch = (job: SearchJob): SearchModelMigrationProgress => ({ ...progress(job), cursor: { ordinal: '2', sample_id: id(8) }, scanned: 2, encoded: 1, unavailable: 1 });
const artifacts = (before: SearchModelMigrationProgress): SearchModelMigrationProgress => ({ ...before, phase: 'awaiting_acceptance',
  source_completed_through: payload.source_high_watermark, target_checkpoint: '9007199254740999',
  coverage_sha256: hash('2'), index_manifest_sha256: hash('3') });
const proof = (job: SearchJob, final: SearchModelMigrationProgress) => ({ schema_version: 'search-reencode-acceptance-v1',
  mode: 'administrator_report_acceptance', job_id: job.id, generation: job.generation,
  payload_fingerprint: final.payload_fingerprint, criteria_sha256: payload.acceptance_criteria_sha256,
  report_sha256: hash('4'), source_completed_through: final.source_completed_through!, target_checkpoint: final.target_checkpoint!,
  coverage_sha256: final.coverage_sha256!, index_manifest_sha256: final.index_manifest_sha256!, accepted_by: job.actor, accepted_at: new Date().toISOString() });

it.skipIf(!enabled)('022 preserves all old job kinds/payloads and is safe to repeat without a new table', async () => isolated(async (jobs, pool) => {
  const old = await Promise.all(['index', 'rebuild', 'verify'].map(kind => jobs.enqueue('old', randomUUID(), kind, { legacy: true })));
  const names = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() ORDER BY table_name`)).rows;
  await pool.query(readFileSync(new URL('../store/migrations/022_search_model_migration.sql', import.meta.url), 'utf8'));
  expect((await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() ORDER BY table_name`)).rows).toEqual(names);
  for (const row of old) {
    expect(await jobs.get(row.id, 'old')).toMatchObject({ payload: { legacy: true }, migration_progress: null, migration_acceptance: null });
    await expect(pool.query('UPDATE search_jobs SET migration_progress=$2 WHERE id=$1', [row.id, '{}'])).rejects.toThrow();
  }
}));
it.skipIf(!enabled)('creation retains human ownership, canonical retry identity and current config/applied model', async () => isolated(async (jobs, pool) => {
  await pool.query(`INSERT INTO config_documents(service,"group",name,config) VALUES('search-service','system','settings',$1)`, [JSON.stringify({ model: payload.source.package_id })]);
  await pool.query(`INSERT INTO config_service_states(service_name,applied_version,desired_version,status) VALUES('search-service',5,5,'applied')`);
  const key = randomUUID(), results = await Promise.all(Array.from({ length: 4 }, () => create(jobs, 'operator', key)));
  expect(new Set(results.map(row => row.id)).size).toBe(1); expect(results[0].actor).toBe('operator');
  expect((await jobs.enqueueMigration('operator', key, { ...payload, scope: { channel_ids: [id(1), id(2)], from: '2026-10-01T08:00:00+08:00', to: '2026-10-02T08:00:00+08:00' } })).id).toBe(results[0].id);
  await expect(jobs.enqueueMigration('operator', key, { ...payload, storage_generation: hash('5') })).rejects.toThrow('idempotency_conflict');
  expect(await jobs.get(results[0].id, 'other')).toBeNull();
  expect((await pool.query(`SELECT config FROM config_documents WHERE service='search-service'`)).rows[0].config).toEqual({ model: payload.source.package_id });
  expect((await pool.query(`SELECT applied_version,desired_version,status FROM config_service_states WHERE service_name='search-service'`)).rows[0]).toEqual({ applied_version: 5, desired_version: 5, status: 'applied' });
  expect((await pool.query(`SELECT actor,action FROM config_audit_logs WHERE action='search-migration-create'`)).rows).toEqual([{ actor: 'operator', action: 'search-migration-create' }]);
}));
it.skipIf(!enabled)('ordinary claim/renew/finish/cancel cannot operate reencoding even with an unscoped principal', async () => isolated(async (jobs) => {
  const migration = await create(jobs), ordinary = await jobs.enqueue('other', randomUUID(), 'rebuild', {});
  expect((await jobs.claim(randomUUID(), 'rebuild'))!.id).toBe(ordinary.id);
  expect(await jobs.claim(randomUUID(), 'rebuild')).toBeNull();
  const worker = randomUUID(), lease = (await jobs.claimMigration(worker))!;
  expect(lease.id).toBe(migration.id); expect(lease.actor).toBe('operator');
  expect(await jobs.renew(lease.id, worker, lease.generation)).toBe(false);
  expect(await jobs.finish(lease.id, worker, lease.generation, { resultRef: 'fake:complete' })).toBe(false);
  expect(await jobs.cancel(lease.id, lease.actor)).toBe(false);
  await expect(jobs.enqueue('operator', randomUUID(), 'rebuild', payload)).rejects.toThrow('migration_specific_operation_required');
}));
it.skipIf(!enabled)('concurrent claimers enforce a global one-live-lease bound across human owners', async () => isolated(async (jobs) => {
  await create(jobs, 'operator-one'); await create(jobs, 'operator-two');
  const claims = await Promise.all(Array.from({ length: 8 }, () => jobs.claimMigration(randomUUID())));
  expect(claims.filter(Boolean)).toHaveLength(1); expect(await jobs.claimMigration(randomUUID())).toBeNull();
}));
it.skipIf(!enabled)('acknowledged batch checkpoints are idempotent and stale cursor/generation cannot overwrite progress', async () => isolated(async (jobs, pool) => {
  await create(jobs); const worker = randomUUID(), first = (await jobs.claimMigration(worker))!, after = batch(first);
  expect(await jobs.checkpointMigration(first.id, worker, first.generation, progress(first), after)).toBe(true);
  expect(await jobs.checkpointMigration(first.id, worker, first.generation, progress(first), after)).toBe(true);
  expect((await jobs.get(first.id, first.actor))!.payload).toEqual(first.payload);
  const stale = { ...after, cursor: { ordinal: '3', sample_id: id(9) }, scanned: 3, encoded: 2 };
  expect(await jobs.checkpointMigration(first.id, worker, first.generation, progress(first), stale)).toBe(false);
  await pool.query(`UPDATE search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [first.id]);
  const nextWorker = randomUUID(), next = (await jobs.claimMigration(nextWorker))!;
  expect(next.generation).toBe(first.generation + 1); expect(progress(next)).toEqual(after);
  expect(await jobs.checkpointMigration(first.id, worker, first.generation, after, stale)).toBe(false);
  expect(await jobs.renewMigration(next.id, nextWorker, next.generation)).toBe(true);
  expect(await jobs.checkpointMigration(next.id, nextWorker, next.generation, after, stale)).toBe(true);
}));
it.skipIf(!enabled)('expired/cancelled leases and worker attempts to mark accepted are refused', async () => isolated(async (jobs, pool) => {
  await create(jobs); const worker = randomUUID(), lease = (await jobs.claimMigration(worker))!, after = batch(lease);
  await expect(jobs.checkpointMigration(lease.id, worker, lease.generation, progress(lease), { ...artifacts(after), phase: 'ready' })).rejects.toThrow('migration_administrator_transition_required');
  expect(await jobs.cancelMigration(lease.id, 'other')).toBe(false);
  expect(await jobs.cancelMigration(lease.id, lease.actor)).toBe(true); expect(await jobs.cancelMigration(lease.id, lease.actor)).toBe(true);
  expect(await jobs.checkpointMigration(lease.id, worker, lease.generation, progress(lease), after)).toBe(false);
  expect((await pool.query(`SELECT count(*)::int AS n FROM config_audit_logs WHERE action='search-migration-cancel'`)).rows[0].n).toBe(1);
  const second = await create(jobs), secondWorker = randomUUID(), secondLease = (await jobs.claimMigration(secondWorker))!;
  await pool.query(`UPDATE search_jobs SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '1 day' WHERE id=$1`, [second.id]);
  expect(await jobs.renewMigration(second.id, secondWorker, secondLease.generation)).toBe(false);
  expect(await jobs.checkpointMigration(second.id, secondWorker, secondLease.generation, progress(secondLease), batch(secondLease))).toBe(false);
}));
it.skipIf(!enabled)('target artifact completion and accepted report bind exact watermark, owner, hashes and generation without activation', async () => isolated(async (jobs, pool) => {
  await create(jobs); const worker = randomUUID(), lease = (await jobs.claimMigration(worker))!, after = batch(lease), final = artifacts(after);
  expect(await jobs.checkpointMigration(lease.id, worker, lease.generation, progress(lease), after)).toBe(true);
  expect(await jobs.checkpointMigration(lease.id, worker, lease.generation, after, final)).toBe(true);
  expect(await jobs.finishMigration(lease.id, worker, lease.generation, { ...final, target_checkpoint: '9007199254740998' })).toBe(false);
  expect(await jobs.finishMigration(lease.id, worker, lease.generation, final)).toBe(true);
  const acceptance = proof(lease, final);
  for (const change of [{ generation: lease.generation + 1 }, { target_checkpoint: '1' }, { source_completed_through: '2' },
    { coverage_sha256: hash('5') }, { criteria_sha256: hash('6') }, { index_manifest_sha256: hash('7') }])
    expect(await jobs.acceptMigration(lease.id, lease.actor, { ...acceptance, ...change })).toBe(false);
  expect(await jobs.acceptMigration(lease.id, 'other', { ...acceptance, accepted_by: 'other' })).toBe(false);
  expect(await jobs.acceptMigration(lease.id, lease.actor, acceptance)).toBe(true);
  expect(await jobs.acceptMigration(lease.id, lease.actor, acceptance)).toBe(true);
  expect(await jobs.acceptMigration(lease.id, lease.actor, { ...acceptance, report_sha256: hash('8') })).toBe(false);
  const saved = (await jobs.get(lease.id, lease.actor))!;
  expect(saved.state).toBe('succeeded'); expect(progress(saved).phase).toBe('ready'); expect(saved.migration_acceptance).toEqual(acceptance);
  expect((await pool.query(`SELECT actor,detail FROM config_audit_logs WHERE action='search-migration-accept'`)).rows).toEqual([{ actor: lease.actor, detail: { job_id: lease.id, proof: acceptance } }]);
  expect((await pool.query(`SELECT count(*)::int AS n FROM config_versions`)).rows[0].n).toBe(0);
}));
it.skipIf(!enabled)('migration control JSON is bounded by DB constraints and carries no input images or credentials', async () => isolated(async (jobs, pool) => {
  const job = await create(jobs);
  for (const column of ['migration_progress', 'migration_acceptance'])
    await expect(pool.query(`UPDATE search_jobs SET ${column}=$2 WHERE id=$1`, [job.id, JSON.stringify({ padding: 'x'.repeat(column === 'migration_progress' ? 8192 : 4096) })])).rejects.toThrow();
  expect(searchModelMigrationFingerprint(job.payload as SearchModelMigrationPayload)).toBe(progress(job).payload_fingerprint);
  await expect(create(jobs, 'operator\n')).rejects.toThrow();
  await expect(jobs.enqueueMigration('operator', randomUUID(), { ...payload, image: 'sensitive' })).rejects.toThrow();
}));
it.skipIf(!enabled)('failure releases the only migration lease without losing durable progress', async () => isolated(async (jobs) => {
  await create(jobs); const worker = randomUUID(), lease = (await jobs.claimMigration(worker))!, after = batch(lease);
  expect(await jobs.checkpointMigration(lease.id, worker, lease.generation, progress(lease), after)).toBe(true);
  expect(await jobs.failMigration(lease.id, worker, lease.generation, 'encoding_failed')).toBe(true);
  expect(await jobs.failMigration(lease.id, worker, lease.generation, 'encoding_failed')).toBe(false);
  expect((await jobs.get(lease.id, lease.actor))!.migration_progress).toEqual(after);
  expect(await jobs.claimMigration(randomUUID())).toBeNull();
}));
