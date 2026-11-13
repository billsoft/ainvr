import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { FacesRuntime } from '../services/facesRuntime.js';
import { FacesService } from '../services/facesService.js';
import { FacesStore } from '../store/facesStore.js';
import { facesRoutes } from '../routes/facesRoutes.js';
import { facesHistoryQuerySchema, facesPageSchema, type FacesLibrary } from '../services/facesContract.js';

const actor = 'console-administrator', oldPin = 'a'.repeat(64), pin = 'b'.repeat(64);
const channel = randomUUID(), libraryId = randomUUID(), memberId = randomUUID(), templateId = randomUUID(), recordId = randomUUID();
const jpeg = Buffer.from([255, 216, 255, 217]), digest = createHash('sha256').update(jpeg).digest('hex');
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 3600000).toISOString();
const scope = { channel_ids: [channel], from: new Date(Date.now() - 86400000).toISOString(), to: new Date().toISOString() };
function record(space = oldPin, id = recordId) { return { id, channel_id: channel, processor_id: 'p', session_id: 's', track_id: 't', captured_at: past(), expires_at: future(), model: 'mbf', space_id: space, quality: { state: 'qualified', reason: null }, photo_ref: id, match: { state: 'unavailable', reason: null }, recording_channel_id: channel }; }
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, value]: any) => {
    if (key === '$or') return value.some((item: any) => matches(row, item));
    const actual = key.split('.').reduce((obj: any, part: string) => obj?.[part], row);
    if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([op, target]: any) => op === '$in' ? target.includes(actual) : op === '$gt' ? actual > target : op === '$gte' ? actual >= target : op === '$lt' ? actual < target : op === '$ne' ? actual !== target : false);
    return actual === value;
  });
}
function memory() {
  const spaces: any[] = [{ _id: 'mbf', space_id: oldPin }], rows: any[] = [];
  const find = (values: any[]) => ({ sort(order: any) { values.sort((a, b) => { for (const [key, dir] of Object.entries(order)) { const get = (row: any) => key.split('.').reduce((obj, part) => obj?.[part], row); if (get(a) !== get(b)) return (get(a) > get(b) ? 1 : -1) * Number(dir); } return 0; }); return this; }, limit(n: number) { values = values.slice(0, n); return this; }, toArray: async () => values });
  const aggregate = vi.fn((pipeline: any[]) => { const filtered = rows.filter(row => matches(row, pipeline[0].$match)); return find([...new Map(filtered.map(row => [`${row.model}:${row.space_id}`, { _id: { model: row.model, space_id: row.space_id } }])).values()]); });
  const db = { collection(name: string) { const values = name === 'faces_spaces' ? spaces : rows; return {
    find: (filter: any) => find(values.filter(row => matches(row, filter))),
    findOne: async (filter: any) => values.find(row => matches(row, filter)) ?? null,
    updateOne: vi.fn(async (filter: any, update: any) => { const row = values.find(row => matches(row, filter)); if (row) Object.assign(row, update.$set); else values.push({ ...filter, ...update.$set, ...update.$setOnInsert }); return { matchedCount: row ? 1 : 0 }; }),
    aggregate,
  }; } };
  return { spaces, rows, db, aggregate, mongo: { db: async () => db } as any };
}
function historical() {
  const template = { template_id: templateId, photo_ref: templateId, actor, library_id: libraryId, member_id: memberId, request_id: templateId, model: 'mbf' as const, space_id: oldPin, quality: { state: 'qualified' as const, reason: null }, jpeg_sha256: digest, expires_at: future() };
  const library: FacesLibrary = { id: libraryId, version: 1, updated_at: past(), document: { name: 'Original library', model: 'mbf', channel_ids: [channel], valid_until: past(), retention_days: 7, match_requested: true, match_threshold: 0.9, access: 'console-management', members: [{ id: memberId, name: 'Original member', note: '', template_id: templateId }] }, templates: { [memberId]: template } };
  const candidate = { event_id: 'c'.repeat(64), kind: 'face_watchlist_candidate', library_id: libraryId, library_version: 1, member_id: memberId, record_id: recordId, channel_id: channel, recording_channel_id: channel, model: 'mbf', space_id: oldPin, occurred_at: past() };
  const store = { getVersion: vi.fn(async () => ({ ...library, retain_until: future() })), get: vi.fn(async () => { throw Error('must not read current library'); }) };
  const runtime = { referenceCandidate: vi.fn(async () => candidate), image: vi.fn(async () => jpeg) };
  const channels = vi.fn(async () => [{ id: channel }]);
  return { template, library, candidate, store, runtime, channels, service: new FacesService(store as any, runtime as any, channels as any) };
}

describe('history across same-name HBM replacements (mock storage only)', () => {
  it('archives legacy registry rows and recovers a previously overwritten space from retained captures', async () => {
    const m = memory(); m.rows.push({ model: 'mbf', space_id: 'c'.repeat(64), state: 'ready', expires_at: new Date(future()) });
    const runtime = new FacesRuntime(m.mongo, {} as any, { status: async () => ({ can_extract: true, embedding_model: 'face-embed-mbf', model_space_hash: pin }) } as any);
    const status = await runtime.status();
    expect(status.spaces.map(item => item.space_id).sort()).toEqual([oldPin, pin, 'c'.repeat(64)].sort());
    expect(status.spaces.filter(item => (item as any).active).map(item => item.space_id)).toEqual([pin]);
    expect(status.spaces.find(item => item.model === 'mbf')?.space_id).toBe(pin);
    expect(m.spaces.find(item => item._id === 'mbf')?.space_id).toBe(oldPin);
    expect((await runtime.status()).spaces).toEqual(status.spaces);
  });
  it('browses every retained space, optional explicit selection; pagination stays fixed and rejects changed scope', async () => {
    const m = memory(), first = record(), second = record(pin, randomUUID());
    m.rows.push(...[first, second].map(data => ({ _id: data.id, kind: 'capture', state: 'ready', model: data.model, space_id: data.space_id, expires_at: new Date(data.expires_at), data })));
    const runtime = new FacesRuntime(m.mongo, {} as any, {} as any);
    const page = await runtime.history({ actor, model: 'mbf', scope, limit: 1 });
    expect(page.space_id).toBeNull(); expect(page.next_cursor).toBeTruthy(); expect(facesPageSchema.safeParse(page).success).toBe(true);
    const next = await runtime.history({ actor, model: 'mbf', scope, limit: 1, cursor: page.next_cursor });
    expect(new Set([...page.items, ...next.items].map(item => item.id)).size).toBe(2);
    await expect(runtime.history({ actor, model: 'mbf', scope, limit: 1, space_id: pin, cursor: page.next_cursor })).rejects.toMatchObject({ code: 'invalid_cursor' });
    expect((await runtime.history({ actor, model: 'mbf', scope, limit: 20, space_id: oldPin })).items.map(item => item.id)).toEqual([first.id]);
    expect(facesHistoryQuerySchema.safeParse({ model: 'mbf', scope, space_id: oldPin }).success).toBe(true);
  });
  it('service validates explicit spaces but default browse never depends on active extractor', async () => {
    const runtime = { status: vi.fn(async () => ({ ready: false, spaces: [{ model: 'mbf', space_id: oldPin, active: false }] })), history: vi.fn(async (input: any) => ({ scope, model: 'mbf', space_id: input.space_id ?? null, items: [record()], coverage: 'unknown', next_cursor: null })) };
    const service = new FacesService(null, runtime as any, async () => [{ id: channel }] as any);
    expect((await service.history({ scope }, actor)).items).toHaveLength(1);
    await expect(service.history({ scope, space_id: pin }, actor)).rejects.toMatchObject({ code: 'faces_space_missing' });
  });
  it('search chooses only the active same-model space', async () => {
    const runtime = { status: async () => ({ ready: true, spaces: [{ model: 'mbf', space_id: oldPin, active: false }, { model: 'mbf', space_id: pin, active: true }] }), search: vi.fn(async (input: any) => ({ query_id: input.request_id, scope, model: 'mbf', space_id: pin, items: [], quality: { state: 'qualified', reason: null }, coverage: 'unknown', next_cursor: null })) };
    const service = new FacesService(null, runtime as any, async () => [{ id: channel }] as any);
    await service.search({ request_id: randomUUID(), scope, jpeg_base64: jpeg.toString('base64') }, actor);
    expect(runtime.search.mock.calls[0][0].space_id).toBe(pin);
  });
  it('retains both batches after a second same-model HBM replacement and extractor outage', async () => {
    const m = memory(); let current: string | null = pin;
    const runtime = new FacesRuntime(m.mongo, {} as any, { status: async () => current ? { can_extract: true, embedding_model: 'face-embed-mbf', model_space_hash: current } : Promise.reject(Error('offline')) } as any);
    await runtime.status(); current = 'd'.repeat(64); await runtime.status(); current = null;
    const status = await runtime.status();
    expect(status.ready).toBe(false); expect(status.spaces.map(item => item.space_id).sort()).toEqual([oldPin, pin, 'd'.repeat(64)]);
    expect(status.spaces.every(item => !item.active)).toBe(true);
  });
  it('coalesces concurrent recovery and registers later HBM replacements without rescanning records', async () => {
    const m = memory(); let current = pin;
    const extractor = { status: async () => ({ can_extract: true, embedding_model: 'face-embed-mbf', model_space_hash: current }) } as any;
    const runtime = new FacesRuntime(m.mongo, {} as any, extractor);
    await Promise.all([runtime.status(), runtime.status(), runtime.status()]);
    expect(m.aggregate).toHaveBeenCalledTimes(1);
    current = 'd'.repeat(64);
    expect((await runtime.status()).spaces.find(item => item.active)?.space_id).toBe(current);
    await runtime.status(); expect(m.aggregate).toHaveBeenCalledTimes(1);
    await new FacesRuntime(m.mongo, {} as any, extractor).status();
    expect(m.aggregate).toHaveBeenCalledTimes(2); // new instance recovers once again
  });
  it('failed recovery does not poison later status calls, including concurrent retry', async () => {
    const m = memory(); m.aggregate.mockImplementationOnce(() => { throw Error('transient recovery failure'); });
    const runtime = new FacesRuntime(m.mongo, {} as any, { status: async () => ({ can_extract: true, embedding_model: 'face-embed-mbf', model_space_hash: pin }) } as any);
    await expect(runtime.status()).rejects.toThrow('transient recovery failure');
    const responses = await Promise.all([runtime.status(), runtime.status()]);
    expect(responses.every(value => value.spaces.some(space => space.space_id === oldPin))).toBe(true);
    expect(m.aggregate).toHaveBeenCalledTimes(2);
    await runtime.status(); expect(m.aggregate).toHaveBeenCalledTimes(2);
  });
});

describe('new enrollment retention is independent of business validity', () => {
  it('stores a new photo for retention_days while refusing registration once valid_until ends', async () => {
    const h = historical(), now = Date.now();
    h.library.document.valid_until = new Date(now + 30000).toISOString();
    const enroll = vi.fn(async (input: any) => ({ ...h.template, request_id: input.request_id, template_id: input.request_id, photo_ref: input.request_id, space_id: pin, expires_at: input.expires_at }));
    const runtime = { ...h.runtime, enroll, status: async () => ({ ready: true, spaces: [{ model: 'mbf', space_id: pin, active: true }] }) };
    const store = { ...h.store, get: async () => h.library };
    const service = new FacesService(store as any, runtime as any, h.channels as any, () => now);
    const input = { request_id: randomUUID(), expected_version: 1, model: 'mbf', jpeg_base64: jpeg.toString('base64') };
    const receipt = await service.enroll(libraryId, memberId, input, actor);
    expect(receipt.expires_at).toBe(new Date(now + 7 * 86400000).toISOString());
    expect(enroll.mock.calls[0][0].expires_at).toBe(receipt.expires_at);
    h.library.document.valid_until = new Date(now).toISOString();
    await expect(service.enroll(libraryId, memberId, { ...input, request_id: randomUUID() }, actor)).rejects.toMatchObject({ code: 'faces_library_expired' });
    expect(enroll).toHaveBeenCalledTimes(1);
  });
  it('ordinary saves keep a legacy template expiry instead of extending it to the new retention policy', async () => {
    const h = historical(), original = h.template.expires_at;
    const save = vi.fn(async (_id, input, templates) => ({ ...h.library, document: input.document, templates }));
    const service = new FacesService({ ...h.store, get: async () => h.library, save } as any, h.runtime as any, h.channels as any);
    await service.save(libraryId, { expected_version: 1, document: { ...h.library.document, retention_days: 90 } }, actor, randomUUID());
    expect(save.mock.calls[0][2][memberId].expires_at).toBe(original);
  });
});

describe('versioned reference evidence (mock storage only)', () => {
  it('uses PG version and candidate, permits ended business validity within photo retention', async () => {
    const h = historical();
    const metadata = await (h.service as any).memberReference(libraryId, 1, memberId, recordId, actor);
    expect(metadata).toMatchObject({ library_name: 'Original library', member_name: 'Original member', library_version: 1, template_id: templateId, record_id: recordId });
    expect(await (h.service as any).historicalMemberImage(libraryId, 1, memberId, recordId, actor)).toEqual(jpeg);
    expect(h.store.get).not.toHaveBeenCalled();
    expect(h.runtime.image).toHaveBeenCalledWith({ actor, template_id: templateId, photo_ref: templateId });
  });
  it('denies forged versions, channels, hashes, non-management identities, and expired templates', async () => {
    const h = historical(), invoke = () => (h.service as any).historicalMemberImage(libraryId, 1, memberId, recordId, actor);
    h.candidate.library_version = 2; await expect(invoke()).rejects.toMatchObject({ code: 'faces_reference_mismatch' });
    h.candidate.library_version = 1; h.channels.mockResolvedValueOnce([]); await expect(invoke()).rejects.toMatchObject({ code: 'faces_scope_denied' });
    h.runtime.image.mockResolvedValueOnce(Buffer.from('wrong')); await expect(invoke()).rejects.toMatchObject({ code: 'faces_photo_integrity' });
    await expect((h.service as any).historicalMemberImage(libraryId, 1, memberId, recordId, 'console-local')).rejects.toMatchObject({ code: 'faces_management_required' });
    h.template.expires_at = past(); await expect(invoke()).rejects.toMatchObject({ code: 'evidence_expired' });
  });
  it('runtime reference only returns retained persisted candidate facts', async () => {
    const m = memory(), h = historical();
    m.rows.push({ _id: recordId, kind: 'capture', state: 'ready', expires_at: new Date(future()), data: record(), watchlist_candidates: [h.candidate], watchlist_done: true });
    const runtime = new FacesRuntime(m.mongo, {} as any, {} as any);
    const input = { actor, record_id: recordId, library_id: libraryId, library_version: 1, member_id: memberId, channel_ids: [channel] };
    expect(await (runtime as any).referenceCandidate(input)).toMatchObject(h.candidate);
    await expect((runtime as any).referenceCandidate({ ...input, library_version: 2 })).rejects.toMatchObject({ code: 'faces_reference_mismatch' });
    await expect((runtime as any).referenceCandidate({ ...input, channel_ids: [] })).rejects.toMatchObject({ code: 'evidence_expired' });
    h.candidate.space_id = pin;
    await expect((runtime as any).referenceCandidate(input)).rejects.toMatchObject({ code: 'faces_reference_mismatch' });
    h.candidate.space_id = oldPin;
    m.rows[0].expires_at = new Date(past()); await expect((runtime as any).referenceCandidate(input)).rejects.toMatchObject({ code: 'evidence_expired' });
  });
  it('PG version read is parameterized, read-only and observes version retention', async () => {
    const h = historical(), query = vi.fn(async () => ({ rows: [{ library_id: libraryId, version: 1, document: h.library.document, templates: h.library.templates, created_at: new Date(past()), retain_until: new Date(future()) }] }));
    const store = new FacesStore({ query } as any);
    expect(await (store as any).getVersion(libraryId, 1)).toMatchObject({ id: libraryId, version: 1 });
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('FROM faces_library_versions'), [libraryId, 1]]);
    query.mockResolvedValueOnce({ rows: [{ library_id: libraryId, version: 1, document: h.library.document, templates: {}, created_at: new Date(past()), retain_until: new Date(past()) }] });
    await expect((store as any).getVersion(libraryId, 1)).rejects.toMatchObject({ code: 'evidence_expired' });
    query.mockResolvedValueOnce({ rows: [] });
    await expect((store as any).getVersion(libraryId, 2)).rejects.toMatchObject({ code: 'evidence_expired' });
  });
  it('never extends photo retention and preserves the current member photo validity semantics', async () => {
    const h = historical();
    h.store.get.mockImplementation(async () => h.library);
    await expect(h.service.memberImage(libraryId, memberId, actor)).rejects.toMatchObject({ code: 'evidence_expired' });
    h.runtime.image.mockImplementationOnce(async () => { h.template.expires_at = past(); return jpeg; });
    await expect(h.service.historicalMemberImage(libraryId, 1, memberId, recordId, actor)).rejects.toMatchObject({ code: 'evidence_expired' });
  });
  it('runtime also fences a photo that expires during SSD reading', async () => {
    const m = memory(), expiry = new Date(future());
    m.rows.push({ _id: templateId, kind: 'template', state: 'ready', data: { actor }, expires_at: expiry, photo: { ref: templateId } });
    const runtime = new FacesRuntime(m.mongo, { read: async () => { expiry.setTime(Date.now() - 1); return jpeg; } } as any, {} as any);
    await expect(runtime.image({ actor, template_id: templateId, photo_ref: templateId })).rejects.toMatchObject({ code: 'evidence_expired' });
  });
  it('HTTP route requires record linkage and management session, preserves no-store and JPEG', async () => {
    const h = historical(); let who = actor;
    const app = Fastify(); await app.register(facesRoutes, { service: h.service, principal: async () => who });
    const base = `/faces/libraries/${libraryId}/versions/1/members/${memberId}`;
    try {
      expect((await app.inject(`${base}/photo`)).statusCode).toBe(422);
      expect((await app.inject(`${base.replace('/versions/1/', '/versions/0/')}/photo?record_id=${recordId}`)).statusCode).toBe(422);
      const response = await app.inject(`${base}/photo?record_id=${recordId}`);
      expect(response.statusCode).toBe(200); expect(response.rawPayload).toEqual(jpeg); expect(response.headers['cache-control']).toContain('no-store');
      expect((await app.inject(`${base}/reference?record_id=${recordId}`)).json()).toMatchObject({ template_id: templateId });
      who = 'console-local'; expect((await app.inject(`${base}/photo?record_id=${recordId}`)).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
