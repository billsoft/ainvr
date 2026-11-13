import { expect, it, vi } from 'vitest';
import { createSearchModelViewsReader } from '../services/searchModelCapabilities.js';
import { SearchNativeClient } from '../services/searchNativeClient.js';

const pin = { package_id: 'siglip2-base-full-int8', model_version: `search-v1-${'a'.repeat(64)}`, package_sha256: 'a'.repeat(64) };
const profile = { ...pin, dimensions: 768, views: 4, input_spec_version: 'scene-views=whole+3squares-shortedge-v1',
  files_verified: true, production_approval_declared: false, pruned: false, runtime_ready: false };

it('reads the existing native profile views contract without claiming runtime readiness', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(profile), { headers: { 'content-type': 'application/json' } }));
  const native = new SearchNativeClient(async () => ({ baseUrl: 'http://127.0.0.1:8400', apiToken: 't'.repeat(48), timeoutMs: 1000 }), request);
  expect(await native.verifyMigrationModel(pin.package_id)).toEqual(profile);
  expect(String(request.mock.calls[0]![0])).toBe('http://127.0.0.1:8400/v1/models/verify');
});

it.each([1, 4, 8])('uses verified views=%i rather than inferring capability from the package name', async views => {
  const verify = vi.fn(async () => ({ ...profile, views }));
  const read = createSearchModelViewsReader(verify);
  expect(await Promise.all([read(pin), read(pin)])).toEqual([views, views]);
  expect(await read({ ...pin })).toBe(views);
  expect(verify).toHaveBeenCalledTimes(1);
});

it.each([
  { views: undefined }, { views: 0 }, { views: 9 }, { views: 1.5 },
  { files_verified: false }, { package_id: 'different' },
  { model_version: `search-v1-${'b'.repeat(64)}`, package_sha256: 'b'.repeat(64) },
  { package_sha256: 'b'.repeat(64) },
])('withholds unknown or mismatched capability and throttles retries: %j', async patch => {
  let now = 0;
  const verify = vi.fn(async () => ({ ...profile, ...patch }));
  const read = createSearchModelViewsReader(verify, () => now);
  expect(await read(pin)).toBeNull();
  now = 29999;
  expect(await read(pin)).toBeNull();
  expect(verify).toHaveBeenCalledTimes(1);
  now = 30000;
  verify.mockResolvedValue(profile);
  expect(await read(pin)).toBe(4);
  expect(verify).toHaveBeenCalledTimes(2);
});

it('rechecks a changed pin even under the same package name and does not cache transient failure forever', async () => {
  let now = 0;
  const verify = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(profile);
  const read = createSearchModelViewsReader(verify, () => now);
  expect(await read(pin)).toBeNull();
  now = 30000;
  expect(await read(pin)).toBe(4);
  const changed = { ...pin, model_version: `search-v1-${'b'.repeat(64)}`, package_sha256: 'b'.repeat(64) };
  verify.mockResolvedValue({ ...profile, ...changed, views: 1 });
  expect(await read(changed)).toBe(1);
  expect(verify).toHaveBeenCalledTimes(3);
});
