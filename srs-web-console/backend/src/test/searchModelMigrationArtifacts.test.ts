import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { SearchModelMigrationArtifacts, searchMigrationArtifactReportSchema } from '../services/searchModelMigrationArtifacts.js';
import { searchModelMigrationFingerprint } from '../services/searchModelMigrationContract.js';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const h = (n: number) => n.toString(16).repeat(64);
const payload = { schema_version: 'search-reencode-v1', purpose: 'reencode',
  source: { package_id: 'source', package_sha256: h(1), model_version: `search-v1-${h(2)}` },
  target: { package_id: 'target', package_sha256: h(3), model_version: `search-v1-${h(4)}` },
  scope: { channel_ids: [id(1)], from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' },
  config_revision: h(5), storage_generation: h(6), source_high_watermark: '100', batch_size: 32,
  acceptance_criteria_sha256: h(7) } as const;
const input = { ...payload, scope: { ...payload.scope, channel_ids: [...payload.scope.channel_ids] } };
const fp = searchModelMigrationFingerprint(input);
const report = { schema_version: 'search-reencode-artifacts-v1', payload_fingerprint: fp, source: input.source, target: input.target, scope: input.scope,
  source_completed_through: '100', target_checkpoint: '200', scanned: 2, encoded: 2, unavailable: 0, coverage_sha256: h(8),
  partitions: [{ channel_id: id(1), day: '2026-10-01', checkpoint: '200', records: 2 }] };
const row = { id: id(9), channel_id: id(1), model_version: payload.target.model_version, day: '2026-10-01', revision: '3',
  published_storage_generation: payload.storage_generation, manifest_sha256: h(9), checkpoint: '201', record_count: 3, bytes: '256', state: 'ready' };
const indexHash = createHash('sha256').update(JSON.stringify(['ainvr-search-migration-index-v1',fp,'200',
  [[row.id,row.channel_id,row.model_version,row.day,row.revision,payload.storage_generation,row.manifest_sha256,row.checkpoint,row.record_count,row.bytes]]])).digest('hex');
const job = { id: id(10), actor: 'operator', kind: 'rebuild' as const, payload: input, state: 'succeeded' as const, generation: 1, attempts: 1,
  lease_owner: null, lease_until: null, expires_at: new Date(Date.now()+60000), migration_progress: {
    schema_version: 'search-reencode-progress-v1', payload_fingerprint: fp, phase: 'awaiting_acceptance',
    cursor: { ordinal: '100', sample_id: id(2) }, scanned: 2, encoded: 2, unavailable: 0,
    source_completed_through: '100', target_checkpoint: '200', coverage_sha256: h(8), index_manifest_sha256: indexHash } };
function fixture(response: unknown = report, rows: unknown[] = [row]) {
  const query = vi.fn().mockResolvedValue({ rows });
  const native = vi.fn().mockResolvedValue(response && typeof response==='object' ? {...response,next_cursor:null}:response);
  return { resolver: new SearchModelMigrationArtifacts({ query } as unknown as Pool, native), query, native };
}
describe('actual migration shard/report authority', () => {
  it('requires matching Native provenance report and real PG published target partitions', async () => {
    const f = fixture(); expect(await f.resolver.resolve(job)).toEqual({ report, index_manifest_sha256: indexHash });
    expect(f.native).toHaveBeenCalledWith(job,null,32);
    expect(f.query.mock.calls[0]![1]).toEqual([payload.target.model_version,[id(1)],payload.storage_generation,payload.scope.from,payload.scope.to]);
  });
  it('fails closed when Native report is unavailable or forged rather than substituting PG counts', async () => {
    for (const response of [null, {}, { ...report, source_completed_through: '99' }, { ...report, coverage_sha256: h(1) },
      { ...report, target: { ...report.target, package_sha256: h(5) } }, { ...report, target_checkpoint: '199' }])
      await expect(fixture(response).resolver.resolve(job)).rejects.toThrow(/migration_/);
  });
  it('refuses unbuilt, under-watermark, missing or mutated manifests', async () => {
    for (const rows of [[], [{ ...row, state: 'building' }], [{ ...row, checkpoint: '199' }],
      [{ ...row, manifest_sha256: null }], [{ ...row, record_count: 1 }], [{ ...row, manifest_sha256: h(1) }]])
      await expect(fixture(report,rows).resolver.resolve(job)).rejects.toThrow(/migration_/);
  });
  it('does not confuse same-day extra target rows with the scoped Native record count', async () => {
    expect((await fixture().resolver.resolve(job)).index_manifest_sha256).toBe(indexHash);
  });
  it('locks the same target authority when called inside config publication', async () => {
    const f=fixture(); await f.resolver.resolve(job,{query:f.query},searchMigrationArtifactReportSchema.parse(report),true);
    expect(f.query.mock.calls[0]![0]).toContain('FOR SHARE'); expect(f.native).not.toHaveBeenCalled();
  });
  it('rejects corrupt partition identity/counts and does not throw on malformed dates', () => {
    for (const patch of [{ partitions: [report.partitions[0],report.partitions[0]] }, { encoded:3 },
      { partitions:[{...report.partitions[0],day:'2026-99-99'}] }, { partitions:[{...report.partitions[0],channel_id:id(99)}] },
      { partitions:[{...report.partitions[0],checkpoint:'201'}] }, { partitions:[{...report.partitions[0],day:'2026-10-02'}] }])
      expect(searchMigrationArtifactReportSchema.safeParse({...report,...patch}).success).toBe(false);
  });
  it('rejects changing page headers, repeated cursors and oversized pages without an unbounded collector',async()=>{
    const f=fixture();
    f.native.mockResolvedValueOnce({...report,partitions:[],next_cursor:`${id(1)}/2026-10-01`})
      .mockResolvedValueOnce({...report,target_checkpoint:'201',next_cursor:null});
    await expect(f.resolver.resolve(job)).rejects.toThrow('migration_artifacts_pending');
    expect(f.native).toHaveBeenCalledTimes(2);
    const repeat=fixture();repeat.native.mockResolvedValue({...report,partitions:[],next_cursor:`${id(1)}/2026-10-01`});
    await expect(repeat.resolver.resolve(job)).rejects.toThrow('migration_artifacts_pending');expect(repeat.native).toHaveBeenCalledTimes(2);
    const huge=fixture();huge.native.mockResolvedValue({...report,next_cursor:null,padding:'x'.repeat(32769)});
    await expect(huge.resolver.resolve(job)).rejects.toThrow('migration_artifacts_pending');expect(huge.native).toHaveBeenCalledTimes(1);
  });
});

it('prepares real Native coverage and published shard digest before those hashes exist in PG progress',async()=>{
 const f=fixture(),building={...job,state:'running' as const,migration_progress:{...job.migration_progress,phase:'building_index',scanned:9,encoded:9,source_completed_through:'100',target_checkpoint:null,coverage_sha256:null,index_manifest_sha256:null}};
 expect(await f.resolver.prepare(building)).toEqual({report,index_manifest_sha256:indexHash});
 expect(building.migration_progress.coverage_sha256).toBeNull();expect(f.query.mock.calls.every(call=>String(call[0]).trim().startsWith('SELECT'))).toBe(true);
 await expect(f.resolver.resolve(building)).rejects.toThrow('migration_report_changed');
 await expect(fixture(report,[{...row,state:'building'}]).resolver.prepare(building)).rejects.toThrow('migration_artifacts_pending');
 await expect(fixture().resolver.prepare({...building,migration_progress:{...building.migration_progress,target_checkpoint:'201'}})).rejects.toThrow('migration_report_changed');
});
