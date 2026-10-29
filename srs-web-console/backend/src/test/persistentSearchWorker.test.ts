import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PersistentSearchWorker, type PersistentSearchOptions } from '../services/persistentSearchWorker.js';
import { SearchNativeError, type NativeCoverageRange, type NativeSample, type NativeSearchSession } from '../services/searchNativeClient.js';
import type { SearchQuery, SearchScope, SearchStatus } from '../services/searchContract.js';

function id(n: number) { return `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`; }
const channel = id(1), inputChannel = id(2), recordingChannel = id(3), requestId = id(4);
const at = Date.now() - 1000;
const scope: SearchScope = { channel_ids: [channel], from: new Date(at).toISOString(), to: new Date(at + 100).toISOString() };
const query: SearchQuery = { query: '穿红衣服的人', scope, verify: true, request_id: requestId };
const version = 'a'.repeat(64);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
function sample(n: number): NativeSample & { similarity: number; feedback: boolean | null } {
  return { id: id(100 + n), channel_id: channel, processor_id: 'processor', stream_session_id: 'session', track_id: `track-${n}`,
    model_version: 'pair-v1', captured_ms: at + n, expires_ms: at + 60000, kind: 'object', similarity: 1 - n / 100, feedback: null,
    evidence: { schema_version: '1.0', source_input_id: inputChannel, output_channel_id: channel, recording_channel_id: recordingChannel,
      stream_session_id: 'session', source_pts_ns: `${n * 1000000}`, source_frame_index: `${n}`, frame_id: id(200 + n), frame_width: 1920, frame_height: 1080, role: 'match' } };
}
const initial = [sample(1), sample(2), sample(3)];
function coverage(scene: boolean, from = at, to = at + 100, state: NativeCoverageRange['state'] = 'sampled'): NativeCoverageRange {
  return { channel, from, to, scene, state };
}
/** Unit-only persistent-port oracle. Mongo/HTTP durability is independently
 * exercised by the native integration tests, not claimed by this fixture. */
function fixture(options: Partial<PersistentSearchOptions> = {}) {
  const sessions = new Map<string, NativeSearchSession>(); const cancelled = new Set<string>(); const deleted = new Set<string>();
  const key = (actor: string, id: string) => `${actor}/${id}`;
  const native: PersistentSearchOptions['native'] = {
    status: vi.fn(async () => ({ ready: true, reason: null, model_version: 'pair-v1' })),
    match: vi.fn(async () => ({ model_version: 'pair-v1', partial: false, items: initial })),
    coverage: vi.fn(async () => [coverage(false), coverage(true)]),
    image: vi.fn(async () => Buffer.from([255, 216, 255, 217])),
    searchImage: vi.fn(async () => Buffer.from([255, 216, 255, 217])),
    beginSearch: vi.fn(async (input, actor, model, expires) => {
      const k = key(actor, input.request_id);
      if (cancelled.has(k)) throw new SearchNativeError('cancelled');
      const old = sessions.get(k);
      if (old) return old.version;
      sessions.set(k, { search_id: input.request_id, version, query: input.query, model_version: model,
        verify: input.verify, scope: structuredClone(input.scope), expires_ms: expires, published: false, coverage: 'unknown', items: [], next_offset: null });
      return version;
    }),
    publishSearch: vi.fn(async (id, actor, revision, state, candidates) => {
      const k = key(actor, id); if (cancelled.has(k)) throw new SearchNativeError('cancelled');
      const old = sessions.get(k)!; if (old.version !== revision) throw new SearchNativeError('conflict');
      if (old.published) return false;
      old.items = candidates.map(c => ({ ...initial.find(i => i.id === c.sample_id)!, similarity: c.similarity }));
      old.coverage = state; old.published = true; return true;
    }),
    readSearch: vi.fn(async (id, actor, offset = 0, limit = 20) => {
      const k = key(actor, id), session = sessions.get(k); if (!session || cancelled.has(k)) return null;
      const end = Math.min(session.items.length, offset + limit);
      return { ...structuredClone(session), items: session.items.slice(offset, end).filter(i => !deleted.has(i.id)),
        next_offset: end < session.items.length ? end : null };
    }),
    searchFeedback: vi.fn(async (id, actor, sampleId, relevant) => {
      const item = sessions.get(key(actor, id))?.items.find(i => i.id === sampleId);
      if (!item || cancelled.has(key(actor, id))) throw new SearchNativeError('not_found'); item.feedback = relevant;
    }),
    cancelSearch: vi.fn(async (id, actor) => { cancelled.add(key(actor, id)); }),
  };
  const channels = vi.fn(async () => [{ id: channel, name: '后门AI输出' }, { id: inputChannel, name: '后门输入' }, { id: recordingChannel, name: '后门录像' }]);
  const worker = new PersistentSearchWorker({ native, channels, ...options });
  return { worker, native, channels, sessions, cancelled, deleted, key };
}
afterEach(() => vi.useRealTimers());
describe('persistent search business adapter', () => {
  it('wakes background verification only after shortlist publication and never waits for model work', async () => {
    const published = vi.fn(() => undefined), f = fixture({ verificationPublished: published });
    await f.worker.query(query, 'operator'); expect(published).toHaveBeenCalledTimes(1);
    expect(f.sessions.get(f.key('operator', requestId))!.published).toBe(true);
    published.mockImplementationOnce(() => { throw Error('optional wake failure'); });
    await expect(f.worker.query(query, 'operator')).resolves.toMatchObject({ search_id: requestId });
  });
  it('keeps cancellation authoritative when optional remote cancellation fails and projects only actual uncalibrated state', async () => {
    const cancel = vi.fn(async () => { throw Error('LLM disconnected'); }), f = fixture({ verificationCancel: cancel });
    await f.worker.query(query, 'operator');
    f.sessions.get(f.key('operator', requestId))!.items[0]!.verification = { state: 'match', profile_fp: 'c'.repeat(64), request_id: 'original-request', cached: true, reason: 'visible_evidence' };
    const page = await f.worker.page(requestId, undefined, 'operator');
    expect(page!.items[0]!.verification).toEqual({ state: 'match', validated: false, cached: true, reason: 'visible_evidence' });
    expect(page!.items[1]!.verification).toEqual({ state: 'candidate' });
    await f.worker.cancel(requestId, 'operator'); expect(cancel).toHaveBeenCalledWith(requestId, 'operator'); expect(f.cancelled.has(f.key('operator', requestId))).toBe(true);
  });
  it('reports unavailable task metadata only for the first five slots and keeps later pages as candidates', async () => {
    const f = fixture({ verificationAvailability: () => ({ available: false, reason: 'task_unavailable' }) });
    await f.worker.query(query, 'operator'); const session = f.sessions.get(f.key('operator', requestId))!;
    session.items = Array.from({ length: 30 }, (_, n) => sample(n + 1));
    const first = (await f.worker.page(requestId, undefined, 'operator'))!;
    expect(first.items.slice(0, 5).every(item => item.verification.state === 'unavailable' && item.verification.reason === 'task_unavailable')).toBe(true);
    expect(first.items.slice(5).every(item => item.verification.state === 'candidate')).toBe(true);
    expect((await f.worker.page(requestId, 'v1.20', 'operator'))!.items.every(item => item.verification.state === 'candidate')).toBe(true);
  });
  it('a cached reference never bypasses revoked channel access for results or images', async () => {
    const f = fixture(); await f.worker.query(query, 'operator');
    f.sessions.get(f.key('operator', requestId))!.items[0]!.verification = { state: 'match', profile_fp: 'c'.repeat(64), request_id: 'original-cache-request', cached: true, reason: 'visible_evidence' };
    f.channels.mockResolvedValue([]);
    await expect(f.worker.page(requestId, undefined, 'operator')).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.worker.image(requestId, id(101), id(201), 'operator')).rejects.toMatchObject({ statusCode: 403 });
    expect(f.native.searchImage).not.toHaveBeenCalled();
  });
  it('maps the authoritative sample provenance and time without guessing an input recording channel', async () => {
    const f = fixture(); const page = await f.worker.query(query, 'operator');
    expect(page.search_id).toBe(requestId); expect(page.model_version).toBe('pair-v1'); expect(page.coverage).toBe('sampled');
    expect(page.items[0]).toMatchObject({ channel_id: channel, channel_name: '后门AI输出', source_input_id: inputChannel,
      processor_id: 'processor', output_channel_id: channel, recording: { channel_id: recordingChannel, state: 'pending' },
      started_at: new Date(at + 1).toISOString(), ended_at: new Date(at + 1).toISOString(),
      frames: [{ id: id(201), captured_at: new Date(at + 1).toISOString(), role: 'match' }], verification: { state: 'candidate' } });
    expect(f.native.publishSearch).toHaveBeenCalledWith(requestId, 'operator', version, 'sampled', initial.map(i => ({ sample_id: i.id, similarity: i.similarity })));
    expect(f.native.match).toHaveBeenCalledTimes(1);
  });
  it('reuses the original published shortlist after model changes and rejects request identity reuse', async () => {
    const f = fixture(); const page = await f.worker.query(query, 'operator');
    vi.mocked(f.native.status).mockResolvedValue({ ready: true, reason: null, model_version: 'pair-v2' });
    expect(await f.worker.query(query, 'operator')).toEqual(page);
    expect(f.native.match).toHaveBeenCalledTimes(1);
    await expect(f.worker.query({ ...query, query: 'different' }, 'operator')).rejects.toMatchObject({ code: 'search_conflict', statusCode: 409 });
  });
  it('does not fabricate model results or verification jobs when dependencies are unavailable', async () => {
    const f = fixture(); vi.mocked(f.native.status).mockResolvedValue({ ready: false, reason: 'model_pending', model_version: null });
    await expect(f.worker.query(query, 'operator')).rejects.toMatchObject({ code: 'search_not_ready', statusCode: 503 });
    expect(f.native.beginSearch).not.toHaveBeenCalled(); expect(f.native.match).not.toHaveBeenCalled();
    vi.mocked(f.native.status).mockResolvedValue({ ready: true, reason: null, model_version: 'pair-v1' });
    const page = await f.worker.query({ ...query, verify: false }, 'operator');
    expect(page.items.every(i => i.verification.state === 'candidate')).toBe(true);
  });
  it('checks all selected channels and all required sampling kinds before marking coverage sampled', async () => {
    const f = fixture();
    vi.mocked(f.native.coverage).mockResolvedValue([coverage(false)]);
    expect((await f.worker.coverage(scope, 'operator')).state).toBe('partial');
    vi.mocked(f.native.coverage).mockResolvedValue([coverage(false), coverage(true, at, at + 50), coverage(true, at + 50, at + 100)]);
    expect((await f.worker.coverage(scope, 'operator')).state).toBe('sampled');
    vi.mocked(f.native.coverage).mockResolvedValue([coverage(false), coverage(true, at, at + 49), coverage(true, at + 50, at + 100)]);
    expect((await f.worker.coverage(scope, 'operator')).state).toBe('partial');
    vi.mocked(f.native.coverage).mockResolvedValue([]);
    expect((await f.worker.coverage(scope, 'operator')).state).toBe('unknown');
    const otherScope = { ...scope, channel_ids: [channel, inputChannel] };
    vi.mocked(f.native.coverage).mockResolvedValue([coverage(false), coverage(true)]);
    expect((await f.worker.coverage(otherScope, 'operator')).state).toBe('partial');
  });
  it('honors a proven historical policy while keeping an incomplete native projection partial', async () => {
    const f = fixture({ coverageKinds: async () => ['object'] });
    vi.mocked(f.native.coverage).mockResolvedValue([coverage(false)]);
    expect((await f.worker.coverage(scope, 'operator')).state).toBe('sampled');
    vi.mocked(f.native.match).mockResolvedValue({ model_version: 'pair-v1', partial: true, items: initial });
    expect((await f.worker.query(query, 'operator')).coverage).toBe('partial');
  });
  it('does not infer historical coverage or revoke history access from current sampling capabilities', async () => {
    const f = fixture({ channels: async () => [
      { id: channel, name: 'Historical output', sampling_supported: false, sampling_reason: 'projection_unsupported' },
      { id: recordingChannel, name: 'Recording' },
    ] });
    // A currently unsupported channel may have historical object samples. Scene
    // coverage alone cannot prove that the old object branch was fully sampled.
    vi.mocked(f.native.coverage).mockResolvedValue([coverage(true)]);
    expect((await f.worker.coverage(scope, 'operator')).state).toBe('partial');
    const page = await f.worker.query(query, 'operator');
    expect(page.coverage).toBe('partial'); expect(page.items).toHaveLength(3);
    expect(f.native.publishSearch).toHaveBeenCalledWith(requestId, 'operator', version, 'partial', expect.any(Array));
    vi.mocked(f.native.coverage).mockResolvedValue([coverage(false), coverage(true)]);
    expect((await f.worker.coverage(scope, 'operator')).state).toBe('sampled');
  });
  it.each([[], null])('keeps an unknown historical policy %j queryable without promoting coverage', async policy => {
    const f = fixture({ coverageKinds: async () => policy });
    expect((await f.worker.coverage(scope, 'operator')).state).toBe('unknown');
    const page = await f.worker.query(query, 'operator');
    expect(page.coverage).toBe('unknown'); expect(page.items).toHaveLength(3);
    expect(f.native.match).toHaveBeenCalledTimes(1);
    vi.mocked(f.native.coverage).mockResolvedValue([]);
    expect((await f.worker.coverage(scope, 'operator')).state).toBe('unknown');
  });
  it('keeps a known historical gap partial even when another selected source has unknown policy', async () => {
    const f = fixture({ coverageKinds: async source => source === channel ? [] : ['scene'] });
    const combined = { ...scope, channel_ids: [channel, inputChannel] };
    expect((await f.worker.coverage(combined, 'operator')).state).toBe('partial');
    vi.mocked(f.native.coverage).mockResolvedValue([coverage(false), coverage(true), { ...coverage(true), channel: inputChannel }]);
    expect((await f.worker.coverage(combined, 'operator')).state).toBe('unknown');
  });
  it('passes the historical interval to a proven policy provider and rejects malformed policy', async () => {
    const policy = vi.fn<NonNullable<PersistentSearchOptions['coverageKinds']>>(async () => ['object']);
    const f = fixture({ coverageKinds: policy });
    vi.mocked(f.native.coverage).mockResolvedValue([coverage(false)]);
    expect((await f.worker.coverage(scope, 'operator')).state).toBe('sampled');
    expect(policy).toHaveBeenCalledWith(channel, 'operator', scope);
    policy.mockResolvedValue(['scene', 'scene']);
    await expect(f.worker.coverage(scope, 'operator')).rejects.toMatchObject({ code: 'search_unavailable', statusCode: 503 });
  });
  it('preserves explicit immutable slot offsets when an earlier sample disappears', async () => {
    const f = fixture(); await f.worker.query(query, 'operator');
    const session = f.sessions.get(f.key('operator', requestId))!;
    session.items = Array.from({ length: 45 }, (_unused, index) => sample(index + 1));
    const first = await f.worker.page(requestId, undefined, 'operator'); expect(first?.next_cursor).toBe('v1.20');
    f.deleted.add(sample(1).id);
    const second = await f.worker.page(requestId, first!.next_cursor!, 'operator');
    expect(second?.items[0].id).toBe(sample(21).id); expect(second?.next_cursor).toBe('v1.40');
    await expect(f.worker.page(requestId, 'v2.20', 'operator')).rejects.toThrow();
    await expect(f.worker.page(requestId, 'v1.61', 'operator')).rejects.toThrow();
    expect(await f.worker.page(requestId, undefined, 'another-operator')).toBeNull();
  });
  it('requires query membership and frame identity for images and stores feedback separately', async () => {
    const f = fixture(); await f.worker.query(query, 'operator');
    expect(await f.worker.image(requestId, sample(1).id, id(999), 'operator')).toBeNull(); expect(f.native.searchImage).not.toHaveBeenCalled();
    expect(await f.worker.image(requestId, id(999), id(201), 'operator')).toBeNull();
    expect(await f.worker.image(requestId, sample(1).id, id(201), 'operator')).toEqual(Buffer.from([255, 216, 255, 217]));
    expect(f.native.searchImage).toHaveBeenCalledWith(requestId, 'operator', sample(1).id, id(201));
    expect(f.native.image).not.toHaveBeenCalled();
    await f.worker.feedback(requestId, sample(1).id, false, 'operator');
    expect((await f.worker.result(requestId, sample(1).id, 'operator'))?.item.feedback).toBe('irrelevant');
    await expect(f.worker.feedback(requestId, sample(1).id, true, 'another-operator')).rejects.toMatchObject({ statusCode: 404 });
  });
  it('blocks existing pages, detail, images and feedback after channel access is revoked', async () => {
    const f = fixture(); await f.worker.query(query, 'operator'); f.channels.mockResolvedValue([]);
    await expect(f.worker.page(requestId, undefined, 'operator')).rejects.toMatchObject({ code: 'search_scope_denied', statusCode: 403 });
    await expect(f.worker.result(requestId, sample(1).id, 'operator')).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.worker.image(requestId, sample(1).id, id(201), 'operator')).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.worker.feedback(requestId, sample(1).id, false, 'operator')).rejects.toMatchObject({ statusCode: 403 });
    expect(f.native.searchImage).not.toHaveBeenCalled(); expect(f.native.searchFeedback).not.toHaveBeenCalled();
  });
  it('rechecks grants after image I/O and does not leak bytes after a concurrent revocation', async () => {
    const f = fixture(); await f.worker.query(query, 'operator');
    vi.mocked(f.native.searchImage).mockImplementationOnce(async () => { f.channels.mockResolvedValue([]); return Buffer.from([255, 216, 255, 217]); });
    await expect(f.worker.image(requestId, sample(1).id, id(201), 'operator')).rejects.toMatchObject({ statusCode: 403 });
  });
  it('also rechecks grants after coverage I/O before returning channel history metadata', async () => {
    const f = fixture(); vi.mocked(f.native.coverage).mockImplementationOnce(async () => {
      f.channels.mockResolvedValue([]); return [coverage(false), coverage(true)];
    });
    await expect(f.worker.coverage(scope, 'operator')).rejects.toMatchObject({ code: 'search_scope_denied', statusCode: 403 });
  });
  it('keeps unknown recording availability pending and bounds total recorder waiting', async () => {
    vi.useFakeTimers();
    const recording = vi.fn<NonNullable<PersistentSearchOptions['recordingAvailability']>>(() => new Promise(() => {}));
    const f = fixture({ recordingAvailability: recording });
    const running = f.worker.query(query, 'operator');
    await vi.advanceTimersByTimeAsync(2001);
    const page = await running;
    expect(page.items.every(i => i.recording.state === 'pending')).toBe(true); expect(recording).toHaveBeenCalledTimes(1);
    expect(recording.mock.calls[0][0].signal.aborted).toBe(true);
  });
  it('uses explicit recording service evidence and rejects unauthorized recording targets', async () => {
    const f = fixture({ recordingAvailability: async () => 'available' });
    expect((await f.worker.query(query, 'operator')).items[0].recording).toEqual({ channel_id: recordingChannel, state: 'available' });
    f.channels.mockResolvedValue([{ id: channel, name: 'AI输出' }]);
    await expect(f.worker.page(requestId, undefined, 'operator')).rejects.toMatchObject({ statusCode: 403 });
  });
  it('preserves cancellation before submission and maps native contention without retrying compute', async () => {
    const f = fixture(); await f.worker.cancel(requestId, 'operator');
    await expect(f.worker.query(query, 'operator')).rejects.toMatchObject({ code: 'search_cancelled', statusCode: 410 });
    expect(f.native.match).not.toHaveBeenCalled();
    const busy = fixture(); vi.mocked(busy.native.match).mockRejectedValue(new SearchNativeError('busy'));
    await expect(busy.worker.query(query, 'operator')).rejects.toMatchObject({ code: 'search_busy', statusCode: 429 });
    expect(busy.native.match).toHaveBeenCalledTimes(1); expect(busy.native.publishSearch).not.toHaveBeenCalled();
  });
  it('distinguishes retained-search admission capacity from transient inference contention', async () => {
    const f = fixture(); vi.mocked(f.native.beginSearch).mockRejectedValue(new SearchNativeError('capacity'));
    await expect(f.worker.query(query, 'operator')).rejects.toMatchObject({ code: 'search_capacity', statusCode: 429 });
    expect(f.native.match).not.toHaveBeenCalled();
  });
  it('rejects excess queries without queueing, with a global two and per-actor one default', async () => {
    const f = fixture(), gate = deferred<SearchStatus>(), firstEntered = deferred<void>(), bothEntered = deferred<void>();
    let entered = 0;
    vi.mocked(f.native.status).mockImplementation(async () => {
      if (++entered === 1) firstEntered.resolve();
      if (entered === 2) bothEntered.resolve();
      return gate.promise;
    });
    const first = f.worker.query(query, 'first'); await firstEntered.promise;
    await expect(f.worker.query({ ...query, request_id: id(5) }, 'first')).rejects.toMatchObject({ code: 'search_busy', statusCode: 429 });
    const second = f.worker.query(query, 'second'); await bothEntered.promise;
    await expect(f.worker.query(query, 'third')).rejects.toMatchObject({ code: 'search_busy', statusCode: 429 });
    expect(f.native.status).toHaveBeenCalledTimes(2); // No queued third execution.
    gate.resolve({ ready: true, reason: null, model_version: 'pair-v1' }); await Promise.all([first, second]);
    expect((await f.worker.query(query, 'third')).items).toHaveLength(3);
  });
  it('validates admission configuration and releases permits after denied access or native failure', async () => {
    for (const limit of [0, 9, 1.5, Number.NaN, '2', null, false]) expect(() => fixture({ queryConcurrency: limit as never })).toThrow();
    const f = fixture({ queryConcurrency: 1 });
    f.channels.mockResolvedValueOnce([]);
    await expect(f.worker.query(query, 'operator')).rejects.toMatchObject({ statusCode: 403 });
    vi.mocked(f.native.match).mockRejectedValueOnce(new SearchNativeError('busy'));
    await expect(f.worker.query(query, 'operator')).rejects.toMatchObject({ statusCode: 429 });
    expect((await f.worker.query(query, 'operator')).items).toHaveLength(3);
  });
  it('lets cancellation bypass admission and releases the running permit once cancelled work returns', async () => {
    const f = fixture({ queryConcurrency: 1 }), gate = deferred<{ model_version: string; partial: boolean; items: typeof initial }>();
    const entered = deferred<void>();
    vi.mocked(f.native.match).mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const running = f.worker.query(query, 'operator'); await entered.promise;
    await f.worker.cancel(requestId, 'operator');
    expect(f.native.cancelSearch).toHaveBeenCalledWith(requestId, 'operator');
    gate.resolve({ model_version: 'pair-v1', partial: false, items: initial });
    await expect(running).rejects.toMatchObject({ code: 'search_cancelled', statusCode: 410 });
    expect((await f.worker.query({ ...query, request_id: id(6) }, 'operator')).items).toHaveLength(3);
  });
  it('hot-applies admission and session TTL without resetting active permits', async () => {
    let limit = 1, ttl = 120;
    const f = fixture({ queryConcurrency: async () => limit, sessionTtlSeconds: async () => ttl });
    const gate = deferred<SearchStatus>(), entered = deferred<void>();
    vi.mocked(f.native.status).mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const first = f.worker.query(query, 'first'); await entered.promise;
    await expect(f.worker.query(query, 'second')).rejects.toMatchObject({ code: 'search_busy', statusCode: 429 });
    limit = 2;
    const before = Date.now(); await f.worker.query(query, 'second');
    const second = f.sessions.get(f.key('second', requestId))!;
    expect(second.expires_ms).toBeGreaterThanOrEqual(before + 120000);
    expect(second.expires_ms).toBeLessThanOrEqual(Date.now() + 120000);
    limit = 1;
    await expect(f.worker.query(query, 'third')).rejects.toMatchObject({ code: 'search_busy', statusCode: 429 });
    gate.resolve({ ready: true, reason: null, model_version: 'pair-v1' }); await first;
    ttl = 60;
    await f.worker.query(query, 'third');
    expect(f.sessions.get(f.key('third', requestId))!.expires_ms).toBeLessThanOrEqual(Date.now() + 60000);
    expect(() => fixture({ sessionTtlSeconds: 59 })).toThrow();
    expect(() => fixture({ sessionTtlSeconds: 86401 })).toThrow();
  });
  it('bounds slow configuration reads to eight actors and keeps cancellation outside admission', async () => {
    const config = deferred<number>(), read = vi.fn(() => config.promise), f = fixture({ queryConcurrency: read });
    const pending = Array.from({ length: 8 }, (_, index) => f.worker.query(query, `pending-${index}`));
    const completed = Promise.allSettled(pending);
    expect(read).toHaveBeenCalledTimes(8);
    for (const actor of ['overflow', 'pending-0'])
      await expect(f.worker.query(query, actor)).rejects.toMatchObject({ code: 'search_busy', statusCode: 429 });
    expect(read).toHaveBeenCalledTimes(8);
    expect(f.channels).not.toHaveBeenCalled(); expect(f.native.readSearch).not.toHaveBeenCalled();
    expect(f.native.status).not.toHaveBeenCalled(); expect(f.native.match).not.toHaveBeenCalled();
    await f.worker.cancel(requestId, 'pending-0');
    expect(f.native.cancelSearch).toHaveBeenCalledWith(requestId, 'pending-0');
    config.resolve(8);
    const results = await completed;
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(7);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'search_cancelled' } });
    expect(f.native.match).toHaveBeenCalledTimes(7);
    expect((await f.worker.query({ ...query, request_id: id(7) }, 'pending-0')).items).toHaveLength(3);
  });
  it.each([0, 9, 1.5, Number.NaN])('treats invalid dynamic concurrency %s as a safe server failure and releases its checking permit', async invalid => {
    let limit = invalid;
    const f = fixture({ queryConcurrency: async () => limit });
    await expect(f.worker.query(query, 'operator')).rejects.toMatchObject({ code: 'search_configuration_unavailable', statusCode: 503 });
    expect(f.native.readSearch).not.toHaveBeenCalled(); expect(f.native.match).not.toHaveBeenCalled();
    limit = 1;
    expect((await f.worker.query(query, 'operator')).items).toHaveLength(3);
  });
  it.each(['transport', 'zod'])('contains a %s configuration getter failure without leaking it or retaining the checking permit', async kind => {
    let failing = true;
    const f = fixture({ queryConcurrency: async () => {
      if (failing) {
        if (kind === 'zod') z.number().parse('private-config-value');
        throw new Error('private-config-value');
      }
      return 1;
    } });
    const failure = await f.worker.query(query, 'operator').catch(error => error);
    expect(failure).toMatchObject({ code: 'search_configuration_unavailable', statusCode: 503 });
    expect(failure).not.toBeInstanceOf(z.ZodError); expect(String(failure)).not.toContain('private-config-value');
    expect(f.native.match).not.toHaveBeenCalled(); failing = false;
    expect((await f.worker.query(query, 'operator')).items).toHaveLength(3);
  });
  it('releases an admitted permit after invalid dynamic TTL without beginning native computation', async () => {
    let ttl = 59;
    const f = fixture({ queryConcurrency: 1, sessionTtlSeconds: async () => ttl });
    await expect(f.worker.query(query, 'operator')).rejects.toMatchObject({ code: 'search_configuration_unavailable', statusCode: 503 });
    expect(f.native.beginSearch).not.toHaveBeenCalled(); expect(f.native.match).not.toHaveBeenCalled();
    ttl = 60;
    expect((await f.worker.query(query, 'operator')).items).toHaveLength(3);
  });
  it('observes hot concurrency one to two to one while preserving both existing running permits', async () => {
    let limit = 1, entered = 0;
    const firstGate = deferred<SearchStatus>(), secondGate = deferred<SearchStatus>();
    const firstEntered = deferred<void>(), secondEntered = deferred<void>();
    const f = fixture({ queryConcurrency: async () => limit });
    vi.mocked(f.native.status).mockImplementation(async () => {
      ++entered;
      if (entered === 1) { firstEntered.resolve(); return firstGate.promise; }
      if (entered === 2) { secondEntered.resolve(); return secondGate.promise; }
      return { ready: true, reason: null, model_version: 'pair-v1' };
    });
    const first = f.worker.query(query, 'first'); await firstEntered.promise;
    await expect(f.worker.query(query, 'second')).rejects.toMatchObject({ statusCode: 429 });
    limit = 2;
    const second = f.worker.query(query, 'second'); await secondEntered.promise;
    limit = 1;
    await expect(f.worker.query(query, 'third')).rejects.toMatchObject({ statusCode: 429 });
    firstGate.resolve({ ready: true, reason: null, model_version: 'pair-v1' }); await first;
    await expect(f.worker.query(query, 'third')).rejects.toMatchObject({ statusCode: 429 });
    expect(f.native.status).toHaveBeenCalledTimes(2);
    secondGate.resolve({ ready: true, reason: null, model_version: 'pair-v1' }); await second;
    expect((await f.worker.query(query, 'third')).items).toHaveLength(3);
  });
  it('carries the scored evidence generation through snapshot publication', async () => {
    const f = fixture();
    const hits = initial.map(item => ({ ...item, fingerprint: 'b'.repeat(64) }));
    vi.mocked(f.native.match).mockResolvedValue({ model_version: 'pair-v1', partial: false, items: hits });
    await f.worker.query(query, 'operator');
    expect(f.native.publishSearch).toHaveBeenCalledWith(requestId, 'operator', version, 'sampled',
      hits.map(item => ({ sample_id: item.id, similarity: item.similarity, fingerprint: item.fingerprint })));
  });

});

it('projects frozen group evidence and verifies every related-image access against current permissions', async () => {
  const availability=vi.fn(async()=> 'available' as const), f=fixture({recordingAvailability:availability});await f.worker.query(query,'operator');
  const session=f.sessions.get(f.key('operator',requestId))!, item=session.items[0]!;
  item.frames=[{id:item.evidence.frame_id,captured_ms:item.captured_ms,role:'match'},{id:id(900),captured_ms:at,role:'before'},{id:id(901),captured_ms:at+50,role:'after'}];
  item.started_ms=at;item.ended_ms=at+50;
  const page=await f.worker.page(requestId,undefined,'operator');
  expect(page!.items[0]!.frames.map(frame=>frame.id)).toEqual([item.evidence.frame_id,id(900),id(901)]);
  expect(page!.items[0]!.started_at).toBe(new Date(at).toISOString());expect(page!.items[0]!.ended_at).toBe(new Date(at+50).toISOString());
  expect(availability).toHaveBeenCalledWith(expect.objectContaining({from:new Date(at).toISOString(),to:new Date(at+50).toISOString()}));
  expect(await f.worker.image(requestId,item.id,id(900),'operator')).toEqual(Buffer.from([255,216,255,217]));
  expect(f.native.searchImage).toHaveBeenLastCalledWith(requestId,'operator',item.id,id(900));
  const count=vi.mocked(f.native.searchImage).mock.calls.length;
  expect(await f.worker.image(requestId,item.id,id(999),'operator')).toBeNull();expect(f.native.searchImage).toHaveBeenCalledTimes(count);
  f.channels.mockResolvedValue([]);
  await expect(f.worker.image(requestId,item.id,id(900),'operator')).rejects.toMatchObject({statusCode:403});
  expect(f.native.searchImage).toHaveBeenCalledTimes(count);
});


describe('coverage degradation and per-frame display geometry', () => {
  it.each(['unavailable', 'invalid_response', 'storage_unavailable', 'busy'] as const)('keeps candidates when only coverage returns %s', async code => {
    const f = fixture(); vi.mocked(f.native.coverage).mockRejectedValue(new SearchNativeError(code));
    const page = await f.worker.query(query, 'operator');
    expect(page.items).toHaveLength(3); expect(page.coverage).toBe('unknown');
    expect(await f.worker.coverage(scope, 'operator')).toMatchObject({ state: 'unknown', ranges: [] });
  });
  it('never degrades an upstream scope rejection or local revocation into unknown coverage', async () => {
    const f = fixture(); vi.mocked(f.native.coverage).mockRejectedValue(new SearchNativeError('scope_denied'));
    await expect(f.worker.query(query, 'operator')).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.worker.coverage(scope, 'operator')).rejects.toMatchObject({ statusCode: 403 });
    vi.mocked(f.native.coverage).mockImplementation(async () => { f.channels.mockResolvedValue([]); throw new SearchNativeError('unavailable'); });
    await expect(f.worker.coverage(scope, 'operator')).rejects.toMatchObject({ statusCode: 403 });
  });
  it('projects a distinct box for each frame and never applies an object box to a scene', async () => {
    const f = fixture(); await f.worker.query(query, 'operator');
    const session = f.sessions.get(f.key('operator', requestId))!;
    session.items[0]!.frames = [
      { id: id(201), captured_ms: at + 1, role: 'match', bbox: [0.1, 0.2, 0.3, 0.4] },
      { id: id(202), captured_ms: at + 2, role: 'after', bbox: [0.2, 0.3, 0.2, 0.1] },
    ];
    session.items[0]!.started_ms = at + 1; session.items[0]!.ended_ms = at + 2;
    session.items[1]!.kind = 'scene'; session.items[1]!.frames = [{ id: id(202), captured_ms: at + 2, role: 'match', bbox: [0, 0, 1, 1] }];
    const page = await f.worker.page(requestId, undefined, 'operator');
    expect(page!.items[0]!.frames.map(frame => frame.bbox)).toEqual([[0.1, 0.2, 0.3, 0.4], [0.2, 0.3, 0.2, 0.1]]);
    expect(page!.items[1]!.frames[0]!.bbox).toBeUndefined();
  });
});

it('never hides an overlapping pending interval or gap under a sampled interval', async () => {
  for (const state of ['gap', 'pending'] as const) {
    const f = fixture(); vi.mocked(f.native.coverage).mockResolvedValue([coverage(false), coverage(true), coverage(false, at + 20, at + 30, state)]);
    expect((await f.worker.coverage(scope, 'operator')).state).toBe('partial');
    expect((await f.worker.query(query, 'operator')).coverage).toBe('partial');
  }
});
