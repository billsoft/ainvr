import {afterEach, expect, it, vi} from 'vitest';
import Fastify from 'fastify';
import {alarmEvidenceRoutes} from '../routes/alarmEvidenceRoutes.js';
import {llmProxyRoutes} from '../routes/llmProxy.js';

const faceId = 'a'.repeat(64), ordinaryId = 'b'.repeat(64), imageKey = 'c'.repeat(64);
const config = {baseUrl: 'http://127.0.0.1:9111', apiToken: 'server-evidence-token-'.repeat(3), timeoutMs: 1000};
const jpeg = new Uint8Array([255, 216, 255, 217]);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
const forged = {'x-ainvr-actor': 'console-administrator', 'x-console-token': 'client-input', authorization: 'Bearer client-input'};
const fact = (id: string) => ({event_id: id, channel_id: 'camera', stream_session_id: 'session', track_id: 'track', label_id: 'person',
  source_pts_ns: '1', source_frame_index: '1', analysis_evidence: {source: {width: 1920, height: 1080}},
  ...(id === faceId ? {event_kind: 'face_watchlist'} : {})});
const retained = {state: 'available', evidence: {kind: 'target_crop', image_id: imageKey, channel_id: 'camera', stream_session_id: 'session',
  track_id: 'track', label_id: 'person', source_pts_ns: '1', source_frame_index: '1', frame_width: 1920, frame_height: 1080,
  image_width: 320, image_height: 240, variants: ['processed', 'original'], pinned: true, retention: 'alarm',
  saved_at: '2026-10-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z'}};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['target', 'region'])('passes validated actor through every %s evidence hop; local ordinary evidence remains available', async kind => {
  for (const principal of [null, 'console-local', 'console-administrator']) {
    const fetcher = vi.fn(async (input: URL | string, options?: RequestInit) => {
      const url = new URL(input), headers = new Headers(options?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${config.apiToken}`);
      expect(headers.get('x-ainvr-actor')).toBe(principal);
      expect(headers.has('x-console-token')).toBe(false);
      const id = url.pathname.split('/')[3];
      if (id === faceId && principal !== 'console-administrator') return json({error: {code: 'not_found'}}, 404);
      if (url.pathname.endsWith('/image')) return new Response(jpeg, {headers: {'content-type': 'image/jpeg'}});
      if (url.pathname.endsWith('/evidence')) return json(kind === 'target' ? retained : {state: 'available', evidence: {
        kind: 'region_frame', variants: ['processed'], image_width: 1920, image_height: 1080, pinned: true, retention: 'alarm',
        expires_at: '2099-01-01T00:00:00Z', frames: [{frame_id: 'frame', captured_at: '2026-11-12T00:00:00Z', count: 0}, {frame_id: 'frame-2', captured_at: '2026-11-12T00:00:01Z', count: 0}],
        region: {points: [[.1, .1], [.9, .1], [.9, .9]], erp_wrap: false},
      }});
      return json(kind === 'target' ? fact(id) : {...fact(id), analysis_evidence: {region_state: {semantics: 'region-state-v1'}}});
    });
    vi.stubGlobal('fetch', fetcher);
    const app = Fastify();
    await app.register(alarmEvidenceRoutes, {principal: async () => principal, connection: async () => config,
      aiConnection: async () => { throw Error('Retained evidence must not fall back to AI history'); }});
    try {
      for (const id of [faceId, ordinaryId]) for (const suffix of ['', '/image']) {
        const response = await app.inject({url: `/alarms/behavior-events/${id}/evidence${suffix}`, headers: forged});
        expect(response.statusCode).toBe(!principal ? 401 : id === faceId && principal !== 'console-administrator' ? 404 : 200);
        if (response.statusCode === 200 && suffix) expect(response.rawPayload).toEqual(Buffer.from(jpeg));
      }
      if (!principal) expect(fetcher).not.toHaveBeenCalled();
      else expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/evidence/image'))).toBe(true);
    } finally { await app.close(); }
  }
});

it('internal evidence collector never inherits a client or console administrator claim', async () => {
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
    const sent = new Headers(options?.headers);
    expect(sent.get('authorization')).toBe(`Bearer ${config.apiToken}`);
    expect(sent.has('x-ainvr-actor')).toBe(false);
    return json({error: {code: 'not_found'}}, 404);
  });
  vi.stubGlobal('fetch', fetcher);
  const app = Fastify();
  await app.register(alarmEvidenceRoutes, {principal: async () => 'console-administrator', internalPrincipal: async () => true,
    connection: async () => config, aiConnection: async () => { throw Error('No fallback'); }});
  try {
    expect((await app.inject({url: `/internal/alarm-evidence/${faceId}`, headers: forged})).statusCode).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});

it('review frame proxy preserves administrator access and prevents forged actor escalation', async () => {
  for (const principal of [null, 'console-local', 'console-administrator']) {
    const fetcher = vi.fn(async (input: URL | string, options?: RequestInit) => {
      const sent = new Headers(options?.headers);
      expect(sent.get('x-ainvr-actor')).toBe(principal);
      expect(sent.get('authorization')).toBe(`Bearer ${config.apiToken}`);
      expect(sent.has('x-console-token')).toBe(false);
      if (String(input).includes(faceId) && principal !== 'console-administrator') return new Response(null, {status: 404});
      return new Response(jpeg, {headers: {'content-type': 'image/jpeg'}});
    });
    vi.stubGlobal('fetch', fetcher);
    const app = Fastify();
    await app.register(llmProxyRoutes, {principal: async () => principal, alarmConnection: async () => config, connection: async () => null});
    try {
      for (const id of [faceId, ordinaryId]) {
        const result = await app.inject({url: `/alarms/events/${id}/review-frames/${imageKey}`, headers: forged});
        expect(result.statusCode).toBe(!principal ? 401 : id === faceId && principal !== 'console-administrator' ? 404 : 200);
        if (result.statusCode === 200) expect(result.json().jpeg_base64).toBe(Buffer.from(jpeg).toString('base64'));
      }
      if (!principal) expect(fetcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }
});
