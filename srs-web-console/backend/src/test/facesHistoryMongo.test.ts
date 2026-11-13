import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Collection, MongoClient, type Document, type Filter, type FindOptions } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { FacesMongo, FACES_HISTORY_INDEX, type FacesMongoRow } from '../store/facesMongo.js';
import { FacesRuntime } from '../services/facesRuntime.js';
import { FacesService } from '../services/facesService.js';
import type { FacesModel, FacesRecord } from '../services/facesContract.js';

const uri = process.env.AINVR_FACES_TEST_MONGO_URI;
if (uri) {
  const target = new URL(uri);
  if (target.hostname !== '127.0.0.1' || target.port !== '27932')
    throw Error('Face history tests require explicitly isolated 127.0.0.1:27932 Mongo');
}
const actor = 'console-administrator';
const oldPin = 'a'.repeat(64), recoveredPin = 'b'.repeat(64), activePin = 'c'.repeat(64), nextPin = 'd'.repeat(64), r50Pin = 'e'.repeat(64);

describe.skipIf(!uri)('Faces history with real isolated Mongo storage (no hardware or business services)', () => {
  let admin: MongoClient, mongo: FacesMongo, runtime: FacesRuntime, service: FacesService, dbName: string;
  let channel: string, otherChannel: string, base: number, active: string | null;
  let extract: Mock<() => Promise<never>>;
  beforeEach(async () => {
    dbName = `faces_history_test_${randomUUID().replaceAll('-', '')}`;
    channel = randomUUID(); otherChannel = randomUUID(); base = Date.now(); active = activePin;
    admin = new MongoClient(uri!, { maxPoolSize: 1, serverSelectionTimeoutMS: 3000 });
    await admin.connect();
    mongo = new FacesMongo(async () => ({ uri: uri!, database: dbName }));
    extract = vi.fn(async () => { throw Error('History must not invoke extraction'); });
    runtime = new FacesRuntime(mongo, {
      publish: async () => { throw Error('History must not publish photos'); },
      read: async () => { throw Error('History must not read photos'); },
      remove: async () => { throw Error('History must not delete photos'); },
    }, {
      status: async () => {
        if (!active) throw Error('Extractor offline');
        return { schema: 'ainvr.face-runtime.v1', ready: false, can_extract: true, embedding_model: 'face-embed-mbf', model_space_hash: active, detector_sha256: 'f'.repeat(64), reason: 'lazy_not_loaded', accuracy_verified: false };
      },
      extract,
    });
    service = new FacesService(null, runtime, async () => [{ id: channel }, { id: otherChannel }] as any);
  });
  afterEach(async () => {
    await runtime?.close();
    if (admin) {
      if (!/^faces_history_test_[a-f0-9]{32}$/.test(dbName)) throw Error('Unsafe test namespace');
      try { await admin.db(dbName).dropDatabase(); } finally { await admin.close(); }
    }
  });
  function capture(space: string, offset: number, options: { id?: string; channel?: string; model?: FacesModel; expired?: boolean; state?: FacesMongoRow['state'] } = {}): FacesMongoRow {
    const id = options.id ?? randomUUID(), model = options.model ?? 'mbf';
    const data: FacesRecord = {
      id, channel_id: options.channel ?? channel, processor_id: 'history-fixture', session_id: 'fixture-session', track_id: id,
      captured_at: new Date(base + offset).toISOString(), expires_at: new Date(base + (options.expired ? -1 : 86400000)).toISOString(),
      model, space_id: space, quality: { state: 'qualified', reason: 'synthetic_geometry_only' }, photo_ref: id,
      match: { state: 'unavailable', reason: 'fixture_without_identity_match' }, recording_channel_id: null,
    };
    return { _id: id, kind: 'capture', fingerprint: 'f'.repeat(64), model, space_id: space, state: options.state ?? 'ready', expires_at: new Date(data.expires_at), data };
  }
  const scope = (channelId: string, now: number) => ({ channel_ids: [channelId], from: new Date(now - 3600000).toISOString(), to: new Date(now).toISOString() });

  it('migrates model-keyed registry additively and recovers overwritten retained pins from real records', async () => {
    const db = await mongo.db(), spaces = db.collection<Document & { _id: string }>('faces_spaces'), records = db.collection<FacesMongoRow>('faces_records');
    const legacy = [{ _id: 'mbf', space_id: oldPin, note: 'preserve legacy row' }, { _id: 'r50', space_id: r50Pin }];
    await spaces.insertMany(legacy);
    await records.insertMany([
      capture(recoveredPin, -1000), capture(recoveredPin, -2000),
      capture('1'.repeat(64), -3000, { expired: true }),
      capture('2'.repeat(64), -4000, { state: 'pending' }),
    ]);
    const before = await records.find({}).sort({ _id: 1 }).toArray();
    const status = await runtime.status();
    expect(status.spaces.map(item => `${item.model}:${item.space_id}`).sort()).toEqual([
      `mbf:${oldPin}`, `mbf:${recoveredPin}`, `mbf:${activePin}`, `r50:${r50Pin}`,
    ].sort());
    expect(status.spaces.filter(item => item.active).map(item => item.space_id)).toEqual([activePin]);
    expect(await spaces.find({ _id: { $in: ['mbf', 'r50'] } }).sort({ _id: 1 }).toArray()).toEqual(legacy);
    for (const space of status.spaces) expect(await spaces.findOne({ _id: `${space.model}:${space.space_id}` })).toMatchObject({ model: space.model, space_id: space.space_id });
    expect(await spaces.countDocuments()).toBe(6);
    expect(await runtime.status()).toEqual(status);
    expect(await spaces.countDocuments()).toBe(6);
    active = nextPin;
    expect((await runtime.status()).spaces.filter(item => item.active).map(item => item.space_id)).toEqual([nextPin]);
    active = null;
    const offline = await runtime.status();
    expect(offline.ready).toBe(false); expect(offline.spaces).toHaveLength(5);
    expect(offline.spaces.every(item => !item.active)).toBe(true);
    expect(await records.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect(extract).not.toHaveBeenCalled();
  });

  it('paginates tied timestamps across spaces exactly once, excludes other scopes and survives HBM replacement', async () => {
    const records = (await mongo.db()).collection<FacesMongoRow>('faces_records');
    const included = [capture(oldPin, -1000), capture(recoveredPin, -1000), capture(activePin, -1000), capture(oldPin, -2000), capture(activePin, -3000)];
    await records.insertMany([...included,
      capture(oldPin, -1000, { channel: otherChannel }), capture(oldPin, -1000, { expired: true }),
      capture(r50Pin, -1000, { model: 'r50' }), capture(oldPin, -1000, { state: 'pending' }),
      capture(oldPin, -7200000), capture(oldPin, 0),
    ]);
    const input = { model: 'mbf', scope: scope(channel, base), limit: 2 };
    const first = await service.history(input, actor);
    expect(first.space_id).toBeNull(); expect(first.next_cursor).not.toBeNull();
    active = nextPin; await runtime.status();
    const second = await service.history({ ...input, cursor: first.next_cursor }, actor);
    active = null;
    const third = await service.history({ ...input, cursor: second.next_cursor }, actor);
    expect(second.next_cursor).not.toBeNull(); expect(third.next_cursor).toBeNull();
    const result = [...first.items, ...second.items, ...third.items];
    const expected = included.map(row => row.data as FacesRecord).sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at) || a.id.localeCompare(b.id));
    expect(result).toEqual(expected); expect(new Set(result.map(item => item.id)).size).toBe(included.length);
    expect(new Set(result.map(item => item.space_id))).toEqual(new Set([oldPin, recoveredPin, activePin]));
    const explicit = await service.history({ ...input, space_id: oldPin, limit: 1 }, actor);
    expect(explicit.space_id).toBe(oldPin); expect(explicit.next_cursor).not.toBeNull();
    const explicitNext = await service.history({ ...input, space_id: oldPin, limit: 1, cursor: explicit.next_cursor }, actor);
    expect([...explicit.items, ...explicitNext.items]).toEqual(expected.filter(item => item.space_id === oldPin));
    expect(explicitNext.next_cursor).toBeNull();
    await expect(service.history({ ...input, space_id: '9'.repeat(64) }, actor)).rejects.toMatchObject({ code: 'faces_space_missing' });
    expect(extract).not.toHaveBeenCalled();
  });

  it('real Mongo cursors reject changed channel/time/model/space and malformed payloads', async () => {
    const records = (await mongo.db()).collection<FacesMongoRow>('faces_records');
    await records.insertMany([capture(oldPin, -1000), capture(activePin, -2000), capture(oldPin, -3000)]);
    const input = { actor, model: 'mbf', scope: scope(channel, base), limit: 1 };
    const all = await runtime.history(input), selected = await runtime.history({ ...input, space_id: oldPin });
    expect(all.next_cursor).not.toBeNull(); expect(selected.next_cursor).not.toBeNull();
    const changed = [
      { ...input, scope: { ...input.scope, channel_ids: [otherChannel] } },
      { ...input, scope: { ...input.scope, from: new Date(base - 1800000).toISOString() } },
      { ...input, scope: { ...input.scope, to: new Date(base - 1).toISOString() } },
      { ...input, model: 'r50' }, { ...input, space_id: oldPin },
    ];
    for (const request of changed) await expect(runtime.history({ ...request, cursor: all.next_cursor })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(runtime.history({ ...input, cursor: selected.next_cursor })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(runtime.history({ ...input, space_id: activePin, cursor: selected.next_cursor })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(runtime.history({ ...input, cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'invalid_cursor' });
    expect((await runtime.history({ ...input, cursor: all.next_cursor })).items).toHaveLength(1);
    expect(extract).not.toHaveBeenCalled();
  });
  it('explains the actual cross-space history query without COLLSCAN or blocking SORT and with bounded scans', async () => {
    const records = (await mongo.db()).collection<FacesMongoRow>('faces_records');
    const included = Array.from({ length: 8 }, (_, index) => capture(index % 2 ? oldPin : activePin, -1000 - Math.floor(index / 2) * 1000, { channel: index % 2 ? otherChannel : channel }));
    const noise = Array.from({ length: 256 }, (_, index) => capture(oldPin, index < 128 ? -7200000 : -1000, index < 128 ? {} : index < 192 ? { model: 'r50' } : { channel: randomUUID() }));
    await records.insertMany([...included, ...noise]);
    const indexes = await records.listIndexes().toArray();
    expect(indexes.find(index => index.name === FACES_HISTORY_INDEX)?.key).toEqual({ kind: 1, model: 1, state: 1, 'data.channel_id': 1, 'data.captured_at': -1, _id: 1 });
    const check = async (channelIds: string[], cursor?: string) => {
      // Capture the runtime's real filter/options, then explain that exact driver
      // query. The spy delegates to Mongo; it does not replace storage behavior.
      const find = vi.spyOn(Collection.prototype, 'find');
      let query: [Filter<FacesMongoRow>, FindOptions];
      let page: Awaited<ReturnType<FacesRuntime['history']>>;
      try {
        page = await runtime.history({ actor, model: 'mbf', scope: { ...scope(channel, base), channel_ids: channelIds }, limit: 2, ...(cursor ? { cursor } : {}) });
        query = find.mock.calls.at(-1) as unknown as [Filter<FacesMongoRow>, FindOptions];
      } finally { find.mockRestore(); }
      expect(query![1].hint).toBe(FACES_HISTORY_INDEX);
      const plan = await records.find(query![0], query![1]).sort({ 'data.captured_at': -1, _id: 1 }).limit(3).explain('executionStats');
      const stages: string[] = [];
      const visit = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const node = value as Record<string, unknown>;
        if (typeof node.stage === 'string') stages.push(node.stage);
        Object.values(node).forEach(visit);
      };
      visit(plan.queryPlanner.winningPlan);
      expect(stages).not.toContain('COLLSCAN'); expect(stages).not.toContain('SORT');
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(FACES_HISTORY_INDEX);
      expect(plan.executionStats.nReturned).toBe(3);
      expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(12);
      expect(plan.executionStats.totalKeysExamined).toBeLessThanOrEqual(24);
      return page!;
    };
    await check([channel]);
    const first = await check([channel, otherChannel]);
    expect(first.next_cursor).not.toBeNull();
    await check([channel, otherChannel], first.next_cursor!);
  });
});
