import { describe, expect, it, vi } from 'vitest';
import { SearchNativeClient } from '../services/searchNativeClient.js';
import { endpoint, limitedBytes } from '../services/internalServiceHttp.js';
const channel = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const config = { baseUrl: 'http://127.0.0.1:8400', apiToken: 't'.repeat(48), timeoutMs: 100 };
const at = Date.now() - 1000;
const scope = { channel_ids: [channel], from: new Date(at - 1).toISOString(), to: new Date(at + 1).toISOString() };
const sample = {
  id: other, channel_id: channel, processor_id: 'fixture', stream_session_id: 'session', track_id: 'track',
  model_version: 'pair-v1', captured_ms: at, kind: 'object', expires_ms: at + 60000,
  evidence: { source_input_id: other, output_channel_id: channel, recording_channel_id: channel,
    frame_id: other, role: 'match', schema_version: '1.0', stream_session_id: 'session',
    source_pts_ns: '1234', source_frame_index: '1', frame_width: 1920, frame_height: 1080 },
};
const page = { model_version: 'pair-v1', partial: true, items: [{ ...sample, similarity: 0.9 }] };
const sessionId = '00000000-0000-4000-8000-000000000003';
const session = { search_id: sessionId, version: 'a'.repeat(64), query: '红衣服的人', model_version: 'pair-v1',
  verify: true, expires_ms: at + 3600000, published: true, coverage: 'partial',
  scope: { channel_ids: [channel], from_ms: at - 1, to_ms: at + 1, limit: 60 },
  items: [{ ...sample, similarity: .9, feedback: false }], next_offset: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture(body: unknown, status = 200) {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => json(body, status));
  return { client: new SearchNativeClient(async () => config, request), request };
}
describe('native search transport', () => {
  it.each(['disabled', 'config_pending'] as const)('preserves %s separately from service failure', async reason => {
    expect(await fixture({ ready: false, reason, model_version: null }).client.status()).toEqual({ ready: false, reason, model_version: null });
    expect((await fixture({ ready: true, reason, model_version: 'pair-v1' }).client.status()).ready).toBe(false);
  });
  it('preserves validated evidence fingerprints in matched samples', async () => {
    const value = { ...page, items: page.items.map(item => ({ ...item, fingerprint: 'c'.repeat(64) })) };
    const result = await fixture(value).client.match('person', scope, 'pair-v1');
    expect(result.items[0].fingerprint).toBe('c'.repeat(64));
    await expect(fixture({ ...page, items: page.items.map(item => ({ ...item, fingerprint: 'invalid' })) }).client.match('person', scope, 'pair-v1'))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('preserves explicit model pending and does not pretend an unconfigured service is ready', async () => {
    const { client } = fixture({ ready: false, reason: 'model_pending', model_version: null });
    expect(await client.status()).toEqual({ ready: false, reason: 'model_pending', model_version: null });
    const request = vi.fn<typeof fetch>();
    expect((await new SearchNativeClient(async () => null, request).status()).reason).toBe('service_unavailable');
    expect(request).not.toHaveBeenCalled();
    expect((await fixture({ ready: true, reason: 'model_pending', model_version: null }).client.status()).ready).toBe(false);
  });
  it('uses the applied local endpoint, service token, timeout and no redirects', async () => {
    const { client, request } = fixture(page);
    expect(await client.match('红色上衣的人', scope, 'pair-v1')).toEqual(page);
    const [url, options] = request.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:8400/v1/match');
    expect(options?.headers).toMatchObject({ 'x-service-token': config.apiToken });
    expect(options?.redirect).toBe('error');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options?.body as string)).toEqual({ query: '红色上衣的人', scope: { channel_ids: [channel], from_ms: at - 1, to_ms: at + 1, limit: 60 } });
  });
  it('refuses external, credentialed or path-injected endpoints before sending a token', async () => {
    for (const baseUrl of ['http://example.com:8400', 'http://user:pass@127.0.0.1:8400', 'http://127.0.0.1:8400/path']) {
      const request = vi.fn<typeof fetch>();
      expect((await new SearchNativeClient(async () => ({ ...config, baseUrl }), request).status()).ready).toBe(false);
      expect(request).not.toHaveBeenCalled();
    }
    expect(() => endpoint(config, '//example.com')).toThrow();
    expect(() => endpoint(config, '/\\example.com')).toThrow();
  });
  it('checks model version, scope, expiration, frame identity and duplicate results', async () => {
    const variants = [
      { ...page, model_version: 'other' },
      { ...page, items: [{ ...page.items[0], model_version: 'other' }] },
      { ...page, items: [{ ...page.items[0], channel_id: other }] },
      { ...page, items: [{ ...page.items[0], captured_ms: at + 1 }] },
      { ...page, items: [{ ...page.items[0], expires_ms: Date.now() - 1 }] },
      { ...page, items: [{ ...page.items[0], evidence: { ...sample.evidence, stream_session_id: 'different' } }] },
      { ...page, items: [page.items[0], page.items[0]] },
    ];
    for (const value of variants) await expect(fixture(value).client.match('人', scope, 'pair-v1')).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('does not retry busy or model-unready compute and never leaks upstream error text', async () => {
    for (const [status, error, code] of [[400, 'query_too_long', 'query_too_long'], [400, 'query_unrepresentable', 'query_unrepresentable'], [400, 'query_invalid_utf8', 'query_invalid_utf8'], [400, 'query_too_large', 'query_too_large'], [400, 'private secret', 'unavailable'], [429, 'private text', 'busy'], [429, 'search_capacity', 'capacity'], [503, 'model_pending', 'model_pending'], [401, 'token=secret', 'scope_denied']] as const) {
      const { client, request } = fixture({ error }, status);
      await expect(client.match('人', scope, 'pair-v1')).rejects.toMatchObject({ code, message: code });
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
  it('enforces request timeouts and sanitizes network failures', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('private endpoint failed')), { once: true });
    }));
    await expect(new SearchNativeClient(async () => config, request).match('人', scope, 'pair-v1')).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
  });
  it('returns raw coverage intervals without claiming complete video coverage', async () => {
    const range = { channel, from: at - 1, to: at + 1, scene: false, state: 'sampled' };
    expect(await fixture({ model_version: 'pair-v1', ranges: [range] }).client.coverage(scope, 'pair-v1')).toEqual([range]);
    await expect(fixture({ model_version: 'pair-v1', ranges: [{ ...range, channel: other }] }).client.coverage(scope, 'pair-v1')).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('returns only validated JPEGs with explicit channel/model parameters', async () => {
    const image = Buffer.from([255, 216, 255, 217]);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(image, { headers: { 'content-type': 'image/jpeg' } }));
    const client = new SearchNativeClient(async () => config, request);
    expect(await client.image(other, channel, 'pair-v1')).toEqual(image);
    expect(String(request.mock.calls[0][0])).toContain(`channel_id=${channel}&model_version=pair-v1`);
    expect(await fixture({ error: 'not_found' }, 404).client.image(other, channel, 'pair-v1')).toBeNull();
    await expect(fixture({ html: '<script/>' }).client.image(other, channel, 'pair-v1')).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('bounds JSON and JPEG bodies even without a content-length header', async () => {
    let cancelled = false;
    const oversized = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } });
    const client = new SearchNativeClient(async () => config, vi.fn<typeof fetch>().mockImplementation(async () => oversized()));
    await expect(client.match('人', scope, 'pair-v1')).rejects.toMatchObject({ code: 'invalid_response' });
    expect(cancelled).toBe(true);
    await expect(limitedBytes(new Response('abc', { headers: { 'content-length': '500' } }), 100)).rejects.toThrow('Response too large');
  });
  it('opens a bounded persistent query using the server principal and complete request identity', async () => {
    const { client, request } = fixture({ version: session.version });
    const expiresMs = Date.now() + 3600000;
    expect(await client.beginSearch({ query: session.query, scope, verify: true, request_id: sessionId }, 'operator', 'pair-v1', expiresMs)).toBe(session.version);
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toEqual({ id: sessionId, actor: 'operator', query: session.query,
      model_version: 'pair-v1', verify: true, expires_ms: expiresMs,
      scope: { channel_ids: [channel], from_ms: at - 1, to_ms: at + 1, limit: 60 } });
    expect(String(request.mock.calls[0][0])).toMatch(/\/v1\/searches\/begin$/);
  });
  it('reads stable query slots and preserves false feedback distinctly from no feedback', async () => {
    const { client, request } = fixture(session);
    const result = await client.readSearch(sessionId, 'operator');
    expect(result?.scope).toEqual(scope);
    expect(result?.items[0].feedback).toBe(false);
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toEqual({ id: sessionId, actor: 'operator', offset: 0, limit: 20 });
    expect(await fixture({ error: 'not_found' }, 404).client.readSearch(sessionId, 'other-operator')).toBeNull();
  });
  it('checks snapshot identity, model, cursor, scope and unpublished states before projection', async () => {
    for (const invalid of [
      { ...session, search_id: channel },
      { ...session, next_offset: 19 },
      { ...session, model_version: 'other-model' },
      { ...session, scope: { ...session.scope, channel_ids: [channel, channel] } },
      { ...session, items: [{ ...session.items[0], channel_id: other }] },
      { ...session, published: false },
    ]) await expect(fixture(invalid).client.readSearch(sessionId, 'operator')).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('publishes only sample references and preserves conflict and cancellation semantics', async () => {
    const { client, request } = fixture({ published: false });
    expect(await client.publishSearch(sessionId, 'operator', session.version, 'partial', [{ sample_id: sample.id, similarity: .9 }])).toBe(false);
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toEqual({ id: sessionId, actor: 'operator', version: session.version,
      coverage: 'partial', items: [{ sample_id: sample.id, similarity: .9 }] });
    for (const [status, code] of [[409, 'conflict'], [410, 'cancelled']] as const) {
      const remote = fixture({ error: 'sensitive remote text' }, status);
      await expect(remote.client.publishSearch(sessionId, 'operator', session.version, 'unknown', [])).rejects.toMatchObject({ code, message: code });
      expect(remote.request).toHaveBeenCalledTimes(1);
    }
  });
  it('sends ownership-scoped feedback and idempotent cancellation without image or query duplication', async () => {
    const feedback = fixture({ stored: true }); await feedback.client.searchFeedback(sessionId, 'operator', sample.id, false);
    expect(JSON.parse(feedback.request.mock.calls[0][1]?.body as string)).toEqual({ id: sessionId, actor: 'operator', sample_id: sample.id, relevant: false });
    const cancel = fixture({ cancelled: true }); await cancel.client.cancelSearch(sessionId, 'operator');
    expect(JSON.parse(cancel.request.mock.calls[0][1]?.body as string)).toEqual({ id: sessionId, actor: 'operator' });
    await expect(feedback.client.searchFeedback(sessionId, 'bad\nactor', sample.id, false)).rejects.toThrow();
    expect(feedback.request).toHaveBeenCalledTimes(1);
  });
  it('reads image bytes through the query-bound storage operation, never an unbound second sample lookup', async () => {
    const image = Buffer.from([255, 216, 255, 217]);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(image, { headers: { 'content-type': 'image/jpeg' } }));
    const client = new SearchNativeClient(async () => config, request);
    expect(await client.searchImage(sessionId, 'operator', sample.id, sample.evidence.frame_id)).toEqual(image);
    expect(String(request.mock.calls[0][0])).toBe('http://127.0.0.1:8400/v1/searches/image');
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toEqual({ id: sessionId, actor: 'operator', sample_id: sample.id, frame_id: sample.evidence.frame_id });
    expect(await fixture({ error: 'not_found' }, 404).client.searchImage(sessionId, 'operator', sample.id, sample.evidence.frame_id)).toBeNull();
  });
});

it('transports grouped refs and validates frozen multiframe reads without granting new image identity', async () => {
  const fingerprint='c'.repeat(64), refs=[{sample_id:sample.id,fingerprint},{sample_id:'00000000-0000-4000-8000-000000000008',fingerprint:'d'.repeat(64)}];
  const matched=await fixture({...page,items:[{...sample,fingerprint,similarity:.9,evidence_refs:refs}]}).client.match('person',scope,'pair-v1');
  expect(matched.items[0]!.evidence_refs).toEqual(refs);
  await expect(fixture({...page,items:[{...sample,fingerprint,similarity:.9,evidence_refs:[refs[1]]}]}).client.match('person',scope,'pair-v1')).rejects.toMatchObject({code:'invalid_response'});
  const frames=[{id:sample.evidence.frame_id,captured_ms:at,role:'match'},{id:refs[1]!.sample_id,captured_ms:at-20,role:'before'}];
  const value={...session,scope:{...session.scope,from_ms:at-50,to_ms:at+50},items:[{...sample,fingerprint,similarity:.9,feedback:false,frames,started_ms:at-20,ended_ms:at}]};
  const read=await fixture(value).client.readSearch(sessionId,'operator');
  expect(read!.items[0]!.frames).toEqual(frames);expect(read!.items[0]!.started_ms).toBe(at-20);
  for(const patch of [{frames:[frames[1]]},{frames:[frames[0],frames[0]]},{started_ms:at+1},{ended_ms:at-1},
    {frames:[frames[0],{...frames[1],captured_ms:at-100}]},{kind:'scene'}])
    await expect(fixture({...value,items:[{...value.items[0],...patch}]}).client.readSearch(sessionId,'operator')).rejects.toMatchObject({code:'invalid_response'});
  const publish=fixture({published:true});await publish.client.publishSearch(sessionId,'operator',session.version,'partial',[{sample_id:sample.id,similarity:.9,fingerprint,evidence_refs:refs}]);
  expect(JSON.parse(publish.request.mock.calls[0]![1]!.body as string).items[0].evidence_refs).toEqual(refs);
  await expect(publish.client.publishSearch(sessionId,'operator',session.version,'partial',[{sample_id:sample.id,similarity:.9,fingerprint,evidence_refs:[{sample_id:sample.id,fingerprint:'f'.repeat(64)}]}])).rejects.toMatchObject({code:'invalid_response'});
  expect(publish.request).toHaveBeenCalledTimes(1);
});

it.each([401, 403])('preserves upstream authorization rejection %s rather than treating it as an unavailable coverage read', async status => {
  await expect(fixture({ error: 'unauthorized' }, status).client.coverage(scope, 'pair-v1')).rejects.toMatchObject({ code: 'scope_denied' });
  await expect(fixture({ error: 'unauthorized' }, status).client.status()).rejects.toMatchObject({ code: 'scope_denied' });
});
it('accepts only bounded normalized per-frame boxes from persisted evidence', async () => {
  const value = { ...session, items: [{ ...session.items[0], frames: [{ id: other, captured_ms: at, role: 'match', bbox: [0.2, 0.3, 0.4, 0.5] }], started_ms: at, ended_ms: at }] };
  expect((await fixture(value).client.readSearch(sessionId, 'operator'))!.items[0]!.frames![0]!.bbox).toEqual([0.2, 0.3, 0.4, 0.5]);
  for (const bbox of [[-0.1, 0, 1, 1], [0.5, 0, 0.6, 1], [0, 0, 0, 1], [0, 0, 1]]) {
    const invalid = structuredClone(value); invalid.items[0]!.frames[0]!.bbox = bbox;
    await expect(fixture(invalid).client.readSearch(sessionId, 'operator')).rejects.toMatchObject({ code: 'invalid_response' });
  }
});
