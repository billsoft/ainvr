import { afterEach, expect, it, vi } from 'vitest';
import { FacesNativeClient } from '../services/facesNativeClient.js';
const pin = 'a'.repeat(64), digest = 'b'.repeat(64), requestId = '11111111-1111-4111-a111-111111111111';
const client = new FacesNativeClient(async () => ({ baseUrl: 'http://127.0.0.1:8099', apiToken: 't'.repeat(32), timeoutMs: 1000 }));
afterEach(() => vi.unstubAllGlobals());
it('uses ONLY extractor endpoints, admits lazy loading via can_extract, validates vector identity and norm', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ schema: 'ainvr.face-runtime.v1', ready: false, can_extract: true, embedding_model: 'face-embed-mbf', model_space_hash: pin, detector_sha256: digest, reason: 'lazy_not_loaded', accuracy_verified: false })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ schema: 'ainvr.face-extraction.v1', status: 'extracted', request_id: requestId, model_space_hash: pin, detector_sha256: digest, jpeg_sha256: digest, accuracy_verified: false, visibility: 'internal_only', quality: { accepted: true, scope: 'geometry_only', reason: 'ok', blur_assessed: false, occlusion_assessed: false, liveness_assessed: false, accuracy_verified: false }, embedding: [1, ...Array(511).fill(0)], dimensions: 512, normalization: 'l2' })));
  vi.stubGlobal('fetch', fetcher);
  expect((await client.status()).can_extract).toBe(true);
  await client.extract(Buffer.from([255, 216, 255, 217]), { request_id: requestId, model_space_hash: pin, detector_sha256: digest, jpeg_sha256: digest, expires_ms: Date.now() + 30000 });
  expect(String(fetcher.mock.calls[0]![0])).toContain('/v1/faces/extractor/status');
  expect(String(fetcher.mock.calls[1]![0])).toContain('/v1/faces/extract');
  expect(fetcher.mock.calls[1]![1].headers['content-type']).toBe('image/jpeg');
});
it('unavailable hardware returns a structured 503 rather than a fake feature', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'face_budget_not_connected' } }), { status: 503 })));
  await expect(client.status()).rejects.toMatchObject({ statusCode: 503, code: 'faces_native_unavailable' });
});
