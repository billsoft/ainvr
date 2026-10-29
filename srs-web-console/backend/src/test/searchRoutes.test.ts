import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { searchRoutes } from '../routes/searchRoutes.js';
import type { SearchWorker } from '../services/searchContract.js';
import { PersistentSearchError } from '../services/persistentSearchWorker.js';
const id = '11111111-1111-4111-8111-111111111111';
const scope = { channel_ids: [id], from: '2026-10-27T00:00:00Z', to: '2026-10-28T00:00:00Z' };
const searchId = '22222222-2222-4222-8222-222222222222';
const resultId = '33333333-3333-4333-8333-333333333333';
const frameId = '44444444-4444-4444-8444-444444444444';
const body = { query: '背黑包的人', scope, request_id: searchId };
function workerFixture(): SearchWorker {
  return { status: vi.fn(async () => ({ ready: true, reason: null, model_version: 'test-v1' })),
    query: vi.fn(async () => ({ search_id: searchId, scope, model_version: 'test-v1', coverage: 'sampled', items: [], next_cursor: null })),
    coverage: vi.fn(), page: vi.fn(), result: vi.fn(), image: vi.fn(), feedback: vi.fn(), cancel: vi.fn() };
}

async function fixture(auth = true, worker?: SearchWorker) {
  const app = Fastify();
  const channels = vi.fn(async () => [{ id, name: '后门' }]);
  await app.register(searchRoutes, { principal: async () => auth ? 'operator' : null, channels, worker });
  return { app, channels };
}
it('requires authentication for status, sources and queries', async () => {
  const { app, channels } = await fixture(false);
  try {
    for (const url of ['/search/status', '/search/channels']) expect((await app.inject(url)).statusCode).toBe(401);
    expect((await app.inject({ url: '/search/text', method: 'POST', payload: body })).statusCode).toBe(401);
    expect(channels).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
it('never returns fake empty results or coverage while models are absent', async () => {
  const { app } = await fixture();
  try {
    expect((await app.inject('/search/status')).json()).toEqual({ ready: false, reason: 'model_pending', model_version: null });
    for (const op of ['text', 'coverage']) {
      const r = await app.inject({ url: `/search/${op}`, method: 'POST', payload: op === 'text' ? body : scope });
      expect(r.statusCode).toBe(503); expect(r.json()).not.toHaveProperty('items');
    }
  } finally { await app.close(); }
});
it('strictly rejects invalid ranges, duplicate scopes, unknown fields and empty queries', async () => {
  const { app } = await fixture();
  try {
    for (const payload of [
      { ...body, query: '  ' }, { ...body, url: 'http://camera' },
      { ...body, scope: { ...scope, channel_ids: [id, id] } },
      { ...body, scope: { ...scope, to: scope.from } },
      { ...body, scope: { ...scope, to: '2026-12-01T00:00:00Z' } },
      { ...body, scope: { ...scope, from: '2026-10-27' } },
    ]) expect((await app.inject({ url: '/search/text', method: 'POST', payload })).statusCode).toBe(400);
  } finally { await app.close(); }
});
it('checks deleted or unauthorized sources before dispatch and rechecks each request', async () => {
  const worker = workerFixture();
  const { app, channels } = await fixture(true, worker);
  try {
    const first = await app.inject({ url: '/search/text', method: 'POST', payload: body });
    expect(first.statusCode).toBe(200);
    expect(worker.query).toHaveBeenCalledWith({ ...body, verify: false }, 'operator');
    channels.mockResolvedValue([]);
    expect((await app.inject({ url: '/search/text', method: 'POST', payload: body })).statusCode).toBe(403);
    expect(worker.query).toHaveBeenCalledTimes(1);
    expect(first.headers['cache-control']).toBe('no-store');
  } finally { await app.close(); }
});
it('does not leak internal provider exceptions', async () => {
  const { app } = await fixture(true, { ...workerFixture(), status: async () => { throw Error('/private/model secret'); } });
  try { const r = await app.inject('/search/status'); expect(r.statusCode).toBe(503); expect(r.body).not.toContain('secret'); }
  finally { await app.close(); }
});
it('preserves safe ownership, cancellation, conflict and capacity errors from the persistent worker', async () => {
  const worker = workerFixture(), { app } = await fixture(true, worker);
  try {
    for (const [code, status] of [['search_scope_denied', 403], ['search_conflict', 409], ['search_cancelled', 410], ['search_busy', 429], ['search_capacity', 429]] as const) {
      vi.mocked(worker.query).mockRejectedValueOnce(new PersistentSearchError(code, status, '安全业务提示'));
      const response = await app.inject({ url: '/search/text', method: 'POST', payload: body });
      expect(response.statusCode).toBe(status); expect(response.json().error).toEqual({ code, message: '安全业务提示' });
    }
  } finally { await app.close(); }
});
it('rechecks coverage ranges and grants instead of returning a broadened or stale projection', async () => {
  const worker = workerFixture(), { app, channels } = await fixture(true, worker);
  const valid = { state: 'partial' as const, scope, ranges: [{ channel_id: id, from: scope.from, to: scope.to, kind: 'object' as const, state: 'sampled' as const }] };
  try {
    vi.mocked(worker.coverage).mockResolvedValueOnce(valid);
    expect((await app.inject({ url: '/search/coverage', method: 'POST', payload: scope })).statusCode).toBe(200);
    vi.mocked(worker.coverage).mockResolvedValueOnce({ ...valid, ranges: [{ ...valid.ranges[0], channel_id: searchId }] });
    expect((await app.inject({ url: '/search/coverage', method: 'POST', payload: scope })).statusCode).toBe(503);
    vi.mocked(worker.coverage).mockImplementationOnce(async () => { channels.mockResolvedValue([]); return valid; });
    expect((await app.inject({ url: '/search/coverage', method: 'POST', payload: scope })).statusCode).toBe(403);
  } finally { await app.close(); }
});
const row = {
  id: resultId, channel_id: id, channel_name: '后门', source_input_id: id,
  processor_id: 'processor', output_channel_id: id, kind: 'object' as const,
  started_at: '2026-10-27T01:00:00Z', ended_at: '2026-10-27T01:00:02Z',
  frames: [{ id: frameId, role: 'match' as const, captured_at: '2026-10-27T01:00:01Z' }],
  recording: { channel_id: id, state: 'available' as const },
  verification: { state: 'candidate' as const }, feedback: null,
};
it('rejects worker scope broadening and out-of-scope candidates', async () => {
  const worker = workerFixture(), { app } = await fixture(true, worker);
  try {
    for (const value of [
      { search_id: searchId, scope: { ...scope, to: '2026-10-29T00:00:00Z' }, model_version: 'v1', coverage: 'sampled', items: [], next_cursor: null },
      { search_id: searchId, scope, model_version: 'v1', coverage: 'sampled', items: [{ ...row, channel_id: '55555555-5555-4555-8555-555555555555' }], next_cursor: null },
      { search_id: searchId, scope, model_version: 'v1', coverage: 'sampled', items: [{ ...row, frames: [{ ...row.frames[0], captured_at: '2026-10-29T00:00:00Z' }] }], next_cursor: null },
    ]) {
      vi.mocked(worker.query).mockResolvedValueOnce(value as any);
      const response = await app.inject({ url: '/search/text', method: 'POST', payload: body });
      expect(response.statusCode).toBe(503); expect(response.body).not.toContain('processor');
    }
  } finally { await app.close(); }
});
it('images require result membership and current channel grants before reading bytes', async () => {
  const worker = workerFixture();
  vi.mocked(worker.result).mockResolvedValue({ search_id: searchId, scope, item: row });
  vi.mocked(worker.image).mockResolvedValue(Buffer.from([255, 216, 255, 217]));
  const { app, channels } = await fixture(true, worker);
  const url = `/search/${searchId}/results/${resultId}/images/${frameId}`;
  try {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await app.inject(url.replace(frameId, id))).statusCode).toBe(404);
    expect(worker.image).toHaveBeenCalledTimes(1);
    channels.mockResolvedValue([]);
    expect((await app.inject(url)).statusCode).toBe(403);
    expect(worker.image).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});
it('does not turn missing evidence or corrupt JPEG into a successful image', async () => {
  const worker = workerFixture();
  vi.mocked(worker.result).mockResolvedValue({ search_id: searchId, scope, item: row });
  const { app } = await fixture(true, worker), url = `/search/${searchId}/results/${resultId}/images/${frameId}`;
  try {
    vi.mocked(worker.image).mockResolvedValueOnce(null).mockResolvedValueOnce(Buffer.from('secret-not-an-image'));
    expect((await app.inject(url)).statusCode).toBe(404);
    const bad = await app.inject(url); expect(bad.statusCode).toBe(503); expect(bad.body).not.toContain('secret');
  } finally { await app.close(); }
});
it('feedback and cancellation are actor-scoped and validate bodies', async () => {
  const worker = workerFixture();
  vi.mocked(worker.result).mockResolvedValue({ search_id: searchId, scope, item: row });
  const { app } = await fixture(true, worker), url = `/search/${searchId}/results/${resultId}/feedback`;
  try {
    expect((await app.inject({ url, method: 'POST', payload: { relevant: true, state: 'confirmed' } })).statusCode).toBe(400);
    expect((await app.inject({ url, method: 'POST', payload: { relevant: true } })).statusCode).toBe(200);
    expect(worker.feedback).toHaveBeenCalledWith(searchId, resultId, true, 'operator');
    expect((await app.inject({ url: `/search/${searchId}/cancel`, method: 'POST' })).statusCode).toBe(200);
    expect(worker.cancel).toHaveBeenCalledWith(searchId, 'operator');
    vi.mocked(worker.result).mockResolvedValue(null);
    expect((await app.inject({ url, method: 'POST', payload: { relevant: false } })).statusCode).toBe(404);
  } finally { await app.close(); }
});

it('returns live sampling reasons without revoking ERP historical query permission', async () => {
  const app = Fastify(), worker = workerFixture();
  const channels = [{ id, name: '全景历史', sampling_supported: false, sampling_reason: 'projection_unsupported' as const }];
  await app.register(searchRoutes, { principal: async () => 'operator', channels: async () => channels, worker });
  try {
    expect((await app.inject('/search/channels')).json()).toEqual({ items: channels });
    expect((await app.inject({ method: 'POST', url: '/search/text', payload: body })).statusCode).toBe(200);
    expect(worker.query).toHaveBeenCalledWith({ ...body, verify: false }, 'operator');
  } finally { await app.close(); }
});
