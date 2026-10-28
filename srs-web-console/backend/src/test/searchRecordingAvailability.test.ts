import { describe, expect, it, vi } from 'vitest';
import { createSearchRecordingAvailability, type SearchRecordingAvailabilityInput } from '../services/searchRecordingAvailability.js';
import type { PersistentSearchOptions } from '../services/persistentSearchWorker.js';
const channel = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const at = Date.now() - 86400000;
const config = { baseUrl: 'http://127.0.0.1:8100', apiToken: 't'.repeat(48), timeoutMs: 1000 };
const input = (from = at, to = from): SearchRecordingAvailabilityInput => ({
  channelId: channel, actor: 'operator', from: new Date(from).toISOString(), to: new Date(to).toISOString(),
});
const segment = (id = 'seg-a', start = at - 100, end = at + 100) => ({
  id, channelId: channel, startTs: start, endTs: end, durationMs: end - start,
  sizeBytes: 10000, width: 1920, height: 1080, playable: true, startPrecisionMs: 1,
});
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
type FixtureOptions = {
  segments?: unknown; health?: unknown; channels?: unknown; config?: unknown;
  reply?: (url: URL, options?: RequestInit) => Response | Promise<Response> | undefined;
};
function fixture(options: FixtureOptions = {}) {
  const request = vi.fn<typeof fetch>().mockImplementation(async (target, init) => {
    const url = new URL(String(target)); const reply = await options.reply?.(url, init); if (reply) return reply;
    if (url.pathname === '/v1/recordings/segments') return json(options.segments ?? [segment()]);
    if (url.pathname.endsWith('/availability')) return json({ available: true });
    if (url.pathname === '/v1/recorder/health') return json(options.health ?? { ok: true, storageHealthy: true, blockedOp: null });
    if (url.pathname === '/v1/recorder/config') return json(options.config ?? { files: { segmentSeconds: 60 } });
    if (url.pathname === '/v1/recorder/channels') return json(options.channels ?? [{ id: channel, recording: true, recordingState: 'recording', drainingPrevious: false }]);
    throw Error('Unexpected fixture route');
  });
  const callback = createSearchRecordingAvailability(async () => config, request);
  // Compile-time contract: this is directly usable by PersistentSearchWorker.
  const compatible: NonNullable<PersistentSearchOptions['recordingAvailability']> = callback;
  return { callback, compatible, request };
}
describe('search recording availability', () => {
  it('checks the explicit recording UUID and turns a single instant into one millisecond', async () => {
    const { callback, request } = fixture();
    expect(await callback(input())).toBe('available');
    const [target, options] = request.mock.calls[0]; const url = new URL(String(target));
    expect(url.origin).toBe('http://127.0.0.1:8100');
    expect(url.searchParams.get('channel')).toBe(channel);
    expect(url.searchParams.get('from')).toBe(String(at)); expect(url.searchParams.get('to')).toBe(String(at + 1));
    expect(options?.headers).toMatchObject({ 'x-service-token': config.apiToken });
    expect(options?.redirect).toBe('error'); expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(request.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual(['/v1/recordings/segments', '/v1/recordings/seg-a/availability']);
  });
  it('uses half-open boundaries and requires full contiguous interval coverage', async () => {
    const full = fixture({ segments: [segment('a', at - 100, at), segment('b', at, at + 100)] });
    expect(await full.callback(input(at - 50, at + 50))).toBe('available');
    const gap = fixture({ segments: [segment('a', at - 100, at), segment('b', at + 1, at + 100)] });
    expect(await gap.callback(input(at - 50, at + 50))).toBe('missing');
    // A segment ending exactly at the target does not cover it. If the service
    // incorrectly returns such a row despite its overlap predicate, be cautious.
    expect(await fixture({ segments: [segment('a', at - 100, at)] }).callback(input())).toBe('pending');
  });
  it('does not accept another channel, malformed timing or duplicate rows', async () => {
    for (const segments of [
      [{ ...segment(), channelId: other }], [{ ...segment(), endTs: at - 200 }],
      [segment(), segment()], [{ ...segment(), sizeBytes: 0 }], [{ ...segment(), width: 0 }],
    ]) expect(await fixture({ segments }).callback(input())).toBe('pending');
  });
  it('does not mistake unplayable or unfinished segments for available or missing recordings', async () => {
    for (const override of [{ playable: false }, { complete: false }, { state: 'pending' }, { state: 'writing' }])
      expect(await fixture({ segments: [{ ...segment(), ...override }] }).callback(input())).toBe('pending');
  });
  it('confirms file availability and can use a second overlapping readable segment', async () => {
    const { callback, request } = fixture({ segments: [segment('a'), segment('b')],
      reply: url => url.pathname === '/v1/recordings/a/availability' ? json({ detail: 'file gone' }, 404) : undefined });
    expect(await callback(input())).toBe('available');
    expect(request.mock.calls.filter(call => String(call[0]).includes('/availability'))).toHaveLength(2);
    expect(await fixture({ reply: url => url.pathname.endsWith('/availability') ? json({ detail: 'busy' }, 503) : undefined }).callback(input())).toBe('pending');
    expect(await fixture({ reply: url => url.pathname.endsWith('/availability') ? json({ available: false }) : undefined }).callback(input())).toBe('pending');
  });
  it('limits file probes rather than amplifying a large recording interval', async () => {
    const segments = Array.from({ length: 5 }, (_, n) => segment(`s${n}`, at + n * 10, at + (n + 1) * 10));
    const { callback, request } = fixture({ segments });
    expect(await callback(input(at, at + 50))).toBe('pending');
    expect(request.mock.calls.filter(call => String(call[0]).includes('/availability'))).toHaveLength(0);
  });
  it('reports historical missing only after checking healthy storage and applied segment configuration', async () => {
    expect(await fixture({ segments: [] }).callback(input())).toBe('missing');
    expect(await fixture({ segments: [], health: { ok: true, storageHealthy: false } }).callback(input())).toBe('pending');
    expect(await fixture({ segments: [], health: { ok: true, storageHealthy: true, blockedOp: 'index-read' } }).callback(input())).toBe('pending');
    expect(await fixture({ segments: [], config: { files: {} } }).callback(input())).toBe('pending');
  });
  it('keeps a recent unclosed segment pending using the actual segment length', async () => {
    const recent = input(Date.now() - 120000);
    expect(await fixture({ segments: [], config: { files: { segmentSeconds: 300 } } }).callback(recent)).toBe('pending');
    expect(await fixture({ segments: [], channels: [{ id: channel, recording: false, recordingState: 'disabled' }] }).callback(input(Date.now() - 1000))).toBe('missing');
    expect(await fixture({ segments: [], channels: [{ id: channel, recording: false, recordingState: 'disabled', drainingPrevious: true }] }).callback(input())).toBe('pending');
    expect(await fixture({ segments: [], channels: [{ id: channel, recording: true, recordingState: 'recording', codecWarning: 'no_idr' }] }).callback(input())).toBe('pending');
  });
  it('does not treat pagination, truncation, cap hits or changed response shapes as a negative', async () => {
    const headers = [{ link: '</next>; rel="next"' }, { 'x-next-cursor': 'cursor' }, { 'content-range': 'items 0-19/100' },
      { 'x-truncated': 'true' }, { 'x-results-truncated': 'true' }, { 'x-total-count': '100' }];
    for (const header of headers) {
      const { callback } = fixture({ reply: url => url.pathname === '/v1/recordings/segments' ? json([], 200, header) : undefined });
      expect(await callback(input())).toBe('pending');
    }
    expect(await fixture({ segments: { items: [], next_cursor: 'next' } }).callback(input())).toBe('pending');
    expect(await fixture({ segments: Array.from({ length: 512 }, (_, n) => segment(`s${n}`)) }).callback(input())).toBe('pending');
  });
  it('reuses bounded page promises without creating a persistent availability cache', async () => {
    const signal = AbortSignal.timeout(2000); const { callback, request } = fixture({ segments: [] });
    expect(await Promise.all([callback({ ...input(), signal }), callback({ ...input(at + 1), signal })])).toEqual(['missing', 'missing']);
    const paths = request.mock.calls.map(call => new URL(String(call[0])).pathname);
    expect(paths.filter(path => path === '/v1/recordings/segments')).toHaveLength(2);
    for (const path of ['/v1/recorder/health', '/v1/recorder/config', '/v1/recorder/channels'])
      expect(paths.filter(value => value === path)).toHaveLength(1);
    const available = fixture();
    expect(await Promise.all([available.callback({ ...input(), signal }), available.callback({ ...input(), signal })])).toEqual(['available', 'available']);
    expect(available.request).toHaveBeenCalledTimes(2);
  });
  it('fails closed on unconfigured, external or credentialed connections', async () => {
    const request = vi.fn<typeof fetch>();
    expect(await createSearchRecordingAvailability(async () => null, request)(input())).toBe('pending');
    for (const baseUrl of ['http://example.com:8100', 'http://user:pass@127.0.0.1:8100', 'http://127.0.0.1:8100/untrusted'])
      expect(await createSearchRecordingAvailability(async () => ({ ...config, baseUrl }), request)(input())).toBe('pending');
    expect(request).not.toHaveBeenCalled();
  });
  it('returns pending on HTTP, body and network failures without exposing remote diagnostics', async () => {
    for (const status of [401, 403, 404, 500, 503])
      expect(await fixture({ reply: () => json({ secret: 'do not expose' }, status) }).callback(input())).toBe('pending');
    expect(await fixture({ reply: () => new Response('private error', { headers: { 'content-type': 'text/html' } }) }).callback(input())).toBe('pending');
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('private endpoint secret'));
    expect(await createSearchRecordingAvailability(async () => config, request)(input())).toBe('pending');
  });
  it('observes both external cancellation and a timeout when no external signal is supplied', async () => {
    const before = new AbortController(); before.abort();
    const connection = vi.fn(async () => config), request = vi.fn<typeof fetch>();
    expect(await createSearchRecordingAvailability(connection, request)({ ...input(), signal: before.signal })).toBe('pending');
    expect(connection).not.toHaveBeenCalled();
    const waiting = vi.fn<typeof fetch>().mockImplementation((_target, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted transport')), { once: true });
    }));
    const during = new AbortController(); const callback = createSearchRecordingAvailability(async () => config, waiting);
    const result = callback({ ...input(), signal: during.signal });
    await Promise.resolve(); during.abort(); expect(await result).toBe('pending');
    expect(await createSearchRecordingAvailability(async () => ({ ...config, timeoutMs: 100 }), waiting)(input())).toBe('pending');
  });
  it('rejects invalid identities and ranges before any service access', async () => {
    const connection = vi.fn(async () => config), request = vi.fn<typeof fetch>();
    const callback = createSearchRecordingAvailability(connection, request);
    for (const value of [{ ...input(), channelId: 'processor-id' }, { ...input(), from: 'yesterday' },
      { ...input(), to: new Date(at - 1).toISOString() }, { ...input(), actor: 'bad\nactor' }])
      expect(await callback(value)).toBe('pending');
    expect(connection).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
});
