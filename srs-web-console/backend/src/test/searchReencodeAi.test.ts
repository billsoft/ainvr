import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SearchReencodeAiClient, SearchReencodeAiError, type SearchReencodeRequest } from '../services/searchReencodeAi.js';

test('reencode capabilities use the fixed authenticated endpoint without claiming model readiness', async () => {
  let called = 0;
  const client = new SearchReencodeAiClient(connection, async (url, init) => {
    called++; assert.equal(String(url), 'http://127.0.0.1:8000/api/v1/search/reencode/capabilities');
    assert.equal(init?.method, 'GET'); assert.equal(new Headers(init?.headers).get('x-api-key'), 'k'.repeat(48));
    assert.equal(init?.body, undefined);
    return Response.json({ schema_version: 'search-reencode-capabilities-v1', implemented: true,
      target_package_ids: ['siglip2-base-full-int8'], max_image_bytes: 8388608, max_duration_ms: 30000,
      cpu_model_fallback: false, cpu_image_processing: false });
  });
  const capabilities = await client.capabilities(); assert.equal(called, 1);
  assert.deepEqual(capabilities.target_package_ids, ['siglip2-base-full-int8']); assert.equal('ready' in capabilities, false);
});

test('reencode capabilities reject CPU fallback, oversized budgets and fake ready declarations', async () => {
  const value = { schema_version: 'search-reencode-capabilities-v1', implemented: true,
    target_package_ids: ['siglip2-base-full-int8'], max_image_bytes: 8388608, max_duration_ms: 30000,
    cpu_model_fallback: false, cpu_image_processing: false };
  for (const patch of [{ cpu_model_fallback: true }, { max_duration_ms: 600000 }, { ready: true }]) {
    const client = new SearchReencodeAiClient(connection, async () => Response.json({ ...value, ...patch }));
    await assert.rejects(client.capabilities(), (error: unknown) => error instanceof SearchReencodeAiError && error.code === 'invalid_result');
  }
});

const now = 1793200000000, jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
const request = (): SearchReencodeRequest => ({ schema_version: 'search-reencode-image-v1',
  request_id: '10000000-0000-4000-8000-000000000001', job_id: '10000000-0000-4000-8000-000000000002', generation: 1,
  payload_fingerprint: 'a'.repeat(64), target: { package_id: 'siglip2-base-full-int8', package_sha256: 'b'.repeat(64), model_version: `search-v1-${'b'.repeat(64)}` },
  sample_id: '10000000-0000-4000-8000-000000000003', source_fingerprint: 'c'.repeat(64),
  jpeg_sha256: createHash('sha256').update(jpeg).digest('hex'), expires_ms: now + 20000 });
function connection() { return Promise.resolve({ baseUrl: 'http://127.0.0.1:8000', apiToken: 'k'.repeat(48), timeoutMs: 25000 }); }
const reply = (r = request()) => ({ ...r, input_kind: 'retained-jpeg', preprocessing_version: 'jpeg-jpu-full-bt601-gles-area256-v1',
  image_width: 74, image_height: 80, dimensions: 3, vector: [1, 0, 0] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const code = (expected: SearchReencodeAiError['code']) => (error: unknown) => error instanceof SearchReencodeAiError && error.code === expected;

test('reencode sends one bounded raw original JPEG through the existing fixed AI control endpoint', async () => {
  let calls = 0;
  const client = new SearchReencodeAiClient(connection, (async (url, init) => {
    ++calls; assert.equal(String(url), 'http://127.0.0.1:8000/api/v1/search/reencode');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'POST');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'k'.repeat(48)); assert.equal(headers['content-type'], 'image/jpeg');
    assert.deepEqual(JSON.parse(headers['x-ainvr-search-reencode']!), request());
    assert.deepEqual(Buffer.from(init!.body as Uint8Array), jpeg);
    return json(reply());
  }) as typeof fetch, () => now);
  assert.deepEqual((await client.encode({ request: request(), dimensions: 3, jpeg })).vector, [1, 0, 0]); assert.equal(calls, 1);
});
test('reencode rejects altered original image before calling the hardware service', async () => {
  let calls = 0; const client = new SearchReencodeAiClient(connection, (async () => { ++calls; return json(reply()); }) as typeof fetch, () => now);
  await assert.rejects(client.encode({ request: request(), dimensions: 3, jpeg: Buffer.from([255, 216, 9, 8, 255, 217]) }), code('invalid_result'));
  await assert.rejects(client.encode({ request: request(), dimensions: 3, jpeg: Buffer.alloc(8 * 1024 * 1024 + 1) }), code('invalid_result'));
  assert.equal(calls, 0);
});
test('reencode enforces short future expiry before dispatch', async () => {
  let calls = 0; const client = new SearchReencodeAiClient(connection, (async () => { ++calls; return json(reply()); }) as typeof fetch, () => now);
  for (const expires_ms of [now - 1, now + 1000, now + 30001])
    await assert.rejects(client.encode({ request: { ...request(), expires_ms }, dimensions: 3, jpeg }), code('expired'));
  assert.equal(calls, 0);
});
test('reencode refuses arbitrary remote addresses without transmitting credentials or pixels', async () => {
  let calls = 0;
  const client = new SearchReencodeAiClient(async () => ({ ...(await connection()), baseUrl: 'http://192.0.2.5:8000' }),
    (async () => { ++calls; return json(reply()); }) as typeof fetch, () => now);
  await assert.rejects(client.encode({ request: request(), dimensions: 3, jpeg }), code('unavailable')); assert.equal(calls, 0);
});
for (const field of ['request_id', 'job_id', 'generation', 'payload_fingerprint', 'sample_id', 'source_fingerprint', 'jpeg_sha256', 'target'] as const) {
  test(`reencode binds response ${field} to the exact submitted work`, async () => {
    const result = reply();
    if (field === 'generation') result.generation = 2;
    else if (field === 'target') result.target = { ...request().target, package_id: 'other-model' };
    else if (field.endsWith('_id')) result[field as 'request_id'] = '20000000-0000-4000-8000-000000000001';
    else result[field as 'payload_fingerprint'] = 'd'.repeat(64);
    const client = new SearchReencodeAiClient(connection, (async () => json(result)) as typeof fetch, () => now);
    await assert.rejects(client.encode({ request: request(), dimensions: 3, jpeg }), code('invalid_result'));
  });
}
test('reencode rejects mismatched dimensions, non-unit values and unsupported preprocessing', async () => {
  for (const change of [{ dimensions: 2 }, { vector: [1, 1, 1] }, { preprocessing_version: 'cpu-fallback' }]) {
    const client = new SearchReencodeAiClient(connection, (async () => json({ ...reply(), ...change })) as typeof fetch, () => now);
    await assert.rejects(client.encode({ request: request(), dimensions: 3, jpeg }), code('invalid_result'));
  }
});
test('reencode busy is not silently retried', async () => {
  let calls = 0; const client = new SearchReencodeAiClient(connection, (async () => { ++calls; return json({}, 429); }) as typeof fetch, () => now);
  await assert.rejects(client.encode({ request: request(), dimensions: 3, jpeg }), code('busy')); assert.equal(calls, 1);
});
test('reencode distinguishes target replacement and unsupported image from temporary busy', async () => {
  for (const [reason, expected] of [['search_reencode_target_changed', 'target_changed'], ['search_reencode_unsupported_image', 'unsupported_image']] as const) {
    const client = new SearchReencodeAiClient(connection, (async () => json({ error: { code: reason } }, 409)) as typeof fetch, () => now);
    await assert.rejects(client.encode({ request: request(), dimensions: 3, jpeg }), code(expected));
  }
  const client = new SearchReencodeAiClient(connection, (async () => json({}, 409)) as typeof fetch, () => now);
  await assert.rejects(client.encode({ request: request(), dimensions: 3, jpeg }), code('unavailable'));
});
test('reencode rejects a late success after expiry', async () => {
  let clock = now;
  const client = new SearchReencodeAiClient(connection, (async () => { clock += 21000; return json(reply()); }) as typeof fetch, () => clock);
  await assert.rejects(client.encode({ request: request(), dimensions: 3, jpeg }), code('expired'));
});
test('reencode cancellation propagates the signal without a second request', async () => {
  const controller = new AbortController(); let calls = 0;
  const client = new SearchReencodeAiClient(connection, (async (_url, init) => {
    ++calls; controller.abort(); throw init!.signal!.reason;
  }) as typeof fetch, () => now);
  await assert.rejects(client.encode({ request: request(), dimensions: 3, jpeg, signal: controller.signal }), code('cancelled')); assert.equal(calls, 1);
});
