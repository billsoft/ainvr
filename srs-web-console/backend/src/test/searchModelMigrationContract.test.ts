import { describe, expect, it } from 'vitest';
import { assertSearchMigrationActivation, searchModelMigrationAcceptanceSchema, searchModelMigrationFingerprint,
  searchModelMigrationLeaseSchema, searchModelMigrationPayloadSchema, searchModelMigrationProgressSchema,
  searchMigrationOrdinalSchema, validateSearchMigrationCheckpoint,
  type SearchModelMigrationPayload, type SearchModelMigrationProgress } from '../services/searchModelMigrationContract.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const h = (n: number) => n.toString(16).repeat(64);
const payload: SearchModelMigrationPayload = {
  schema_version: 'search-reencode-v1', purpose: 'reencode',
  source: { package_id: 'siglip2-base-full-int8', package_sha256: h(1), model_version: `search-v1-${h(2)}` },
  target: { package_id: 'siglip-so400m-i18n-full-int8', package_sha256: h(3), model_version: `search-v1-${h(4)}` },
  scope: { channel_ids: [id(2), id(1)], from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' },
  config_revision: h(5), storage_generation: h(6), source_high_watermark: '9007199254740993',
  batch_size: 32, acceptance_criteria_sha256: h(7),
};
const fp = searchModelMigrationFingerprint(payload);
const progress = (patch: Partial<SearchModelMigrationProgress> = {}): SearchModelMigrationProgress => ({
  schema_version: 'search-reencode-progress-v1', payload_fingerprint: fp, phase: 'encoding', cursor: null,
  scanned: 0, encoded: 0, unavailable: 0, coverage_sha256: null, index_manifest_sha256: null, ...patch,
  source_completed_through: patch.source_completed_through ?? null, target_checkpoint: patch.target_checkpoint ?? null,
});
const ready = progress({ phase: 'ready', cursor: { ordinal: payload.source_high_watermark, sample_id: id(8) },
  scanned: 5, encoded: 5, coverage_sha256: h(8), index_manifest_sha256: h(9),
  source_completed_through: payload.source_high_watermark, target_checkpoint: '9007199254740999' });
const acceptance = { schema_version: 'search-reencode-acceptance-v1', mode: 'administrator_report_acceptance',
  job_id: id(9), generation: 3, payload_fingerprint: fp, criteria_sha256: h(7), report_sha256: h(10),
  coverage_sha256: h(8), index_manifest_sha256: h(9), source_completed_through: payload.source_high_watermark,
  target_checkpoint: ready.target_checkpoint!, accepted_by: 'admin', accepted_at: '2026-10-02T02:00:00Z' } as const;
const activation = { job_id: id(9), generation: 3, state: 'succeeded', payload, progress: ready, acceptance,
  current: { config_revision: payload.config_revision, storage_generation: payload.storage_generation, source: payload.source } };

describe('frozen model migration contract', () => {
  it('is an explicit new-space JPEG reencode, not a same-space SSD rebuild', () => {
    expect(searchModelMigrationPayloadSchema.parse(payload)).toEqual(payload);
    expect(searchModelMigrationPayloadSchema.safeParse({ ...payload, purpose: 'rebuild' }).success).toBe(false);
    expect(searchModelMigrationPayloadSchema.safeParse({ ...payload, target: payload.source }).success).toBe(false);
    expect(searchModelMigrationPayloadSchema.safeParse({ ...payload, target: { ...payload.target, model_version: payload.source.model_version } }).success).toBe(false);
  });
  it('bounds source scope, batch and ordinal without bigint rounding', () => {
    expect(searchMigrationOrdinalSchema.parse('9007199254740993')).toBe('9007199254740993');
    expect(searchMigrationOrdinalSchema.parse('9223372036854775807')).toBe('9223372036854775807');
    for (const bad of ['9223372036854775808', '01', '-1', '1.0', '1e5', 1]) expect(searchMigrationOrdinalSchema.safeParse(bad).success).toBe(false);
    for (const batch_size of [0, 33, 1.5]) expect(searchModelMigrationPayloadSchema.safeParse({ ...payload, batch_size }).success).toBe(false);
    expect(searchModelMigrationPayloadSchema.safeParse({ ...payload, scope: { ...payload.scope, channel_ids: [id(1), id(1)] } }).success).toBe(false);
    expect(searchModelMigrationPayloadSchema.safeParse({ ...payload, scope: { ...payload.scope, to: '2026-12-01T00:00:00Z' } }).success).toBe(false);
  });
  it('canonicalizes only equivalent scope ordering/time zones, preserving every frozen identity', () => {
    expect(searchModelMigrationFingerprint({ ...payload, scope: { channel_ids: [id(1), id(2)], from: '2026-10-01T08:00:00+08:00', to: '2026-10-02T08:00:00+08:00' } })).toBe(fp);
    for (const patch of [{ target: { ...payload.target, package_sha256: h(11) } }, { source: { ...payload.source, model_version: `search-v1-${h(12)}` } },
      { config_revision: h(13) }, { storage_generation: h(14) }, { source_high_watermark: '9007199254740994' },
      { acceptance_criteria_sha256: h(15) }, { batch_size: 16 }])
      expect(searchModelMigrationFingerprint({ ...payload, ...patch })).not.toBe(fp);
  });
  it('refuses paths, URLs, credentials and arbitrary progress fields at the schema boundary', () => {
    for (const patch of [{ url: 'http://camera/' }, { token: 'secret' }, { image: 'base64' }, { vector: [1] }, { path: '/mnt/x' }]) {
      expect(searchModelMigrationPayloadSchema.safeParse({ ...payload, ...patch }).success).toBe(false);
      expect(searchModelMigrationProgressSchema.safeParse({ ...ready, ...patch }).success).toBe(false);
    }
    expect(searchModelMigrationPayloadSchema.safeParse({ ...payload, target: { ...payload.target, package_id: '../model' } }).success).toBe(false);
  });
  it('binds grants to exact immutable payload and lease generation', () => {
    const lease = { job_id: id(9), worker: id(10), generation: 3, expires_at: '2026-10-02T03:00:00Z', payload, payload_fingerprint: fp };
    expect(searchModelMigrationLeaseSchema.parse(lease)).toEqual(lease);
    expect(searchModelMigrationLeaseSchema.safeParse({ ...lease, payload: { ...payload, storage_generation: h(10) } }).success).toBe(false);
    expect(searchModelMigrationLeaseSchema.safeParse({ ...lease, generation: 0 }).success).toBe(false);
  });
  it('accepts only acknowledged bounded monotonic checkpoints with an advancing cursor', () => {
    const next = progress({ cursor: { ordinal: '9007199254740992', sample_id: id(5) }, scanned: 32, encoded: 31, unavailable: 1 });
    expect(validateSearchMigrationCheckpoint(payload, progress(), next)).toEqual(next);
    expect(validateSearchMigrationCheckpoint(payload, next, next)).toEqual(next);
    for (const patch of [{ scanned: 33, encoded: 32 }, { scanned: 1, encoded: 2 }, { scanned: 2, encoded: 1, unavailable: 2 },
      { cursor: { ordinal: '9007199254740994', sample_id: id(5) } }, { payload_fingerprint: h(1) }, { cursor: null }])
      expect(() => validateSearchMigrationCheckpoint(payload, progress(), { ...next, ...patch })).toThrow();
    expect(() => validateSearchMigrationCheckpoint(payload, next, { ...next, scanned: 33, encoded: 32 })).toThrow('migration_cursor_not_advanced');
    expect(() => validateSearchMigrationCheckpoint(payload, next, { ...next, cursor: { ordinal: '9007199254740991', sample_id: id(6) } })).toThrow('migration_cursor_not_monotonic');
  });
  it('requires real artifact hashes before completion and never silently changes accepted artifacts', () => {
    expect(searchModelMigrationProgressSchema.safeParse({ ...ready, index_manifest_sha256: null }).success).toBe(false);
    expect(searchModelMigrationProgressSchema.safeParse({ ...ready, scanned: 6 }).success).toBe(false);
    expect(() => validateSearchMigrationCheckpoint(payload, ready, { ...ready, coverage_sha256: h(10) })).toThrow('migration_accepted_artifacts_changed');
    expect(() => validateSearchMigrationCheckpoint(payload, ready, { ...ready, phase: 'encoding' })).toThrow('migration_progress_not_monotonic');
  });
  it('acceptance is a scoped administrator record, never a bare validated boolean', () => {
    expect(searchModelMigrationAcceptanceSchema.parse(acceptance)).toEqual(acceptance);
    expect(searchModelMigrationAcceptanceSchema.safeParse({ ...acceptance, validated: true }).success).toBe(false);
    expect(searchModelMigrationAcceptanceSchema.safeParse({ ...acceptance, accepted_by: 'admin\nother' }).success).toBe(false);
  });
  it('permits switch only after authoritative job success, frozen report acceptance and exact CAS context', () => {
    expect(() => assertSearchMigrationActivation(activation)).not.toThrow();
    for (const patch of [{ state: 'running' }, { generation: 4 }, { job_id: id(10) },
      { acceptance: { ...acceptance, report_sha256: 'bad' } }, { acceptance: { ...acceptance, criteria_sha256: h(11) } },
      { acceptance: { ...acceptance, index_manifest_sha256: h(12) } }, { progress: { ...ready, phase: 'awaiting_acceptance' as const } }])
      expect(() => assertSearchMigrationActivation({ ...activation, ...patch })).toThrow();
    for (const current of [{ ...activation.current, config_revision: h(10) }, { ...activation.current, storage_generation: h(11) },
      { ...activation.current, source: { ...payload.source, package_sha256: h(12) } }])
      expect(() => assertSearchMigrationActivation({ ...activation, current })).toThrow('migration_source_changed');
  });
});
