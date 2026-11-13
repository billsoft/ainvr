import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { randomUUID, createHash } from 'node:crypto';
import { FacesMongo } from '../store/facesMongo.js';
import { FacesRuntime } from '../services/facesRuntime.js';
import type { FacesLibrary } from '../services/facesContract.js';

const uri = process.env.AINVR_FACES_TEST_MONGO_URI;
if (uri) { const target = new URL(uri); if (target.hostname !== '127.0.0.1' || target.port !== '27932') throw Error('Face tests require explicitly isolated 127.0.0.1:27932 Mongo'); }
const pin = 'a'.repeat(64), detector = 'b'.repeat(64), actor = 'console-administrator';
const channel = randomUUID(), processor = 'processor-test', libraryId = randomUUID(), memberId = randomUUID();
const jpeg = Buffer.from([255, 216, 1, 2, 3, 4, 255, 217]), jpegBase64 = jpeg.toString('base64'), digest = createHash('sha256').update(jpeg).digest('hex');
const vector = [1, ...Array(511).fill(0)];
describe.skipIf(!uri)('Faces Node business with isolated Mongo (no hardware)', () => {
  let mongo: FacesMongo, runtime: FacesRuntime, admin: MongoClient, dbName: string, libraries: FacesLibrary[];
  let extract: ReturnType<typeof vi.fn>;
  const images = new Map<string, Buffer>();
  beforeEach(async () => {
    dbName = `faces_test_${randomUUID().replaceAll('-', '')}`;
    admin = new MongoClient(uri!); await admin.connect(); images.clear(); libraries = [];
    mongo = new FacesMongo(async () => ({ uri: uri!, database: dbName }));
    extract = vi.fn(async (_bytes, input) => ({ schema: 'ainvr.face-extraction.v1' as const, status: 'extracted' as const, request_id: input.request_id,
      model_space_hash: input.model_space_hash, detector_sha256: input.detector_sha256, jpeg_sha256: input.jpeg_sha256,
      quality: { accepted: true, reason: 'test_geometry_only', scope: 'geometry_only' as const, blur_assessed: false as const, occlusion_assessed: false as const, liveness_assessed: false as const, accuracy_verified: false as const },
      accuracy_verified: false as const, visibility: 'internal_only' as const, embedding: vector, dimensions: 512 as const, normalization: 'l2' as const }));
    runtime = new FacesRuntime(mongo, { publish: async (ref, bytes) => { images.set(ref, bytes); return { ref, generation: 'test-only', sha256: digest, bytes: bytes.length } }, read: async photo => images.get(photo.ref)!, remove: async photo => { images.delete(photo.ref) } },
      { status: async () => ({ schema: 'ainvr.face-runtime.v1', ready: false, can_extract: true, embedding_model: 'face-embed-mbf', model_space_hash: pin, detector_sha256: detector, reason: 'lazy_not_loaded', accuracy_verified: false }), extract }, async () => libraries);
  });
  afterEach(async () => { await runtime?.close(); if (admin) { if (!/^faces_test_[a-f0-9]{32}$/.test(dbName)) throw Error('Unsafe test namespace'); await admin.db(dbName).dropDatabase(); await admin.close(); } });
  const enrollment = (requestId: string) => ({ request_id: requestId, actor, library_id: libraryId, member_id: memberId, model: 'mbf', space_id: pin, jpeg_base64: jpegBase64, jpeg_sha256: digest, retention_days: 7, expires_at: new Date(Date.now() + 86400000).toISOString(), deadline_ms: Date.now() + 30000 });
  const capture = (at = new Date().toISOString()) => ({ request_id: randomUUID(), model: 'mbf', jpeg_base64: jpegBase64, channel_id: channel, processor_id: processor, session_id: 'session', track_id: 'track', frame_id: randomUUID(), source_pts_ns: '1234', source_frame_index: '1', captured_at: at, recording_channel_id: channel });
  it('enroll/capture/search use real Mongo references, stable retries, no JPEG/vector in public response', async () => {
    const request = enrollment(randomUUID()), template = await runtime.enroll(request);
    expect(await runtime.enroll({ ...request, deadline_ms: Date.now() + 30000 })).toEqual(template);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(template)).not.toMatch(/embedding|vector|jpeg_base64/);
    const source = capture(), first = await runtime.capture(source, 7), again = await runtime.capture({ ...source, request_id: randomUUID() }, 7);
    expect(again.record.id).toBe(first.record.id);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(first.record.match.state).toBe('unavailable');
    const scope = { channel_ids: [channel], from: new Date(Date.now() - 3600000).toISOString(), to: new Date(Date.now() + 60000).toISOString() };
    const history = await runtime.history({ actor, scope, model: 'mbf', space_id: pin, limit: 20 });
    expect(history.items).toHaveLength(1); expect(history.coverage).toBe('unknown');
    const search = await runtime.search({ request_id: randomUUID(), actor, model: 'mbf', space_id: pin, jpeg_base64: jpegBase64, jpeg_sha256: digest, deadline_ms: Date.now() + 30000, scope, limit: 20 });
    expect(search.items[0]?.similarity).toBeCloseTo(1); expect(JSON.stringify(search)).not.toMatch(/embedding|vector|jpeg_base64/);
    const stored = await admin.db(dbName).collection('faces_records').findOne({ _id: first.record.id as any });
    expect(stored?.vector).toBeDefined(); expect(stored).not.toHaveProperty('jpeg');
    expect(images.size).toBe(2);
  });
  it('model spaces do not mix, expiry hides records and search scope is bounded', async () => {
    const result = await runtime.capture(capture(), 7), scope = { channel_ids: [channel], from: new Date(Date.now() - 3600000).toISOString(), to: new Date(Date.now() + 60000).toISOString() };
    expect((await runtime.history({ actor, scope, model: 'r50', space_id: 'c'.repeat(64), limit: 20 })).items).toEqual([]);
    await admin.db(dbName).collection('faces_records').updateOne({ _id: result.record.id as any }, { $set: { expires_at: new Date(0) } });
    await expect(runtime.record({ actor, id: result.record.id, channel_ids: [channel] })).rejects.toMatchObject({ statusCode: 410 });
    expect((await runtime.history({ actor, scope, model: 'mbf', space_id: pin, limit: 20 })).items).toEqual([]);
    await runtime.maintainStorage(); // Same path as the idle timer, no new capture.
    expect(images.has(result.record.id)).toBe(false);
    const expired = await admin.db(dbName).collection('faces_records').findOne({ _id: result.record.id as any });
    expect(expired?.state).toBe('expired'); expect(expired?.vector).toBeUndefined();
  });
  it('configured watchlist produces stable candidate facts, never identity certainty or repeated-frame facts', async () => {
    const template = await runtime.enroll(enrollment(randomUUID()));
    libraries = [{ id: libraryId, version: 1, updated_at: new Date(Date.now() - 10000).toISOString(), document: { name: 'Test library', model: 'mbf', channel_ids: [channel], valid_until: new Date(Date.now() + 86400000).toISOString(), retention_days: 7, access: 'console-management', match_requested: true, match_threshold: 0.9, members: [{ id: memberId, name: 'Test member', note: '', template_id: template.template_id }] }, templates: { [memberId]: template } }];
    const first = await runtime.capture(capture(), 7), second = await runtime.capture(capture(), 7);
    expect(first.watchlist_candidates).toHaveLength(1);
    expect(first.watchlist_candidates[0]?.event_id).toBe(second.watchlist_candidates[0]?.event_id);
    expect(first.watchlist_candidates[0]).toMatchObject({ library_version: 1, accuracy_verified: false, kind: 'face_watchlist_candidate' });
    expect(first.record.match.state).toBe('candidate');
    expect(first.watchlist_candidates[0]).toMatchObject({ event_kind: 'face_watchlist', review_required: true, recording_channel_id: channel });
    const outbox = await runtime.watchlistOutbox(); expect(outbox.items).toHaveLength(2);
    expect((await runtime.watchlistOutbox()).items).toEqual(outbox.items); // failed delivery did not erase facts
    for (const candidate of outbox.items) {
      const ack = { record_id: candidate.record_id, event_id: candidate.event_id };
      await runtime.acknowledgeWatchlist(ack); await runtime.acknowledgeWatchlist(ack);
    }
    expect((await runtime.watchlistOutbox()).items).toEqual([]);
    libraries[0]!.document.match_requested = false;
    const without = await runtime.capture(capture(), 7);
    expect(without.watchlist_candidates).toEqual([]); expect(without.record.match.state).toBe('unavailable');
  });
  it('rejected automatic crop persists quality history without a vector or stranger alarm', async () => {
    extract.mockResolvedValueOnce({ status: 'multiple_faces' });
    const saved = await runtime.capture(capture(), 7);
    expect(saved.record.quality.state).toBe('rejected'); expect(saved.watchlist_candidates).toEqual([]);
    expect(saved.record.match.state).toBe('unavailable');
    const row = await admin.db(dbName).collection('faces_records').findOne({ _id: saved.record.id as any });
    expect(row?.state).toBe('ready'); expect(row?.vector).toBeUndefined(); expect(images.has(saved.record.id)).toBe(true);
  });
  it('cancel fences a query before extraction, unsupported quality never persists a ready template', async () => {
    const requestId = randomUUID(); await runtime.cancel({ request_id: requestId, actor });
    const scope = { channel_ids: [channel], from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString() };
    await expect(runtime.search({ request_id: requestId, actor, model: 'mbf', space_id: pin, jpeg_base64: jpegBase64, jpeg_sha256: digest, deadline_ms: Date.now() + 30000, scope, limit: 20 })).rejects.toMatchObject({ code: 'cancelled' });
    expect(extract).not.toHaveBeenCalled();
    extract.mockResolvedValueOnce({ status: 'multiple_faces' });
    await expect(runtime.enroll(enrollment(randomUUID()))).rejects.toMatchObject({ code: 'quality_rejected' });
    expect(await admin.db(dbName).collection('faces_records').countDocuments({ state: 'ready' })).toBe(0);
  });
});
