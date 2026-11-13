import { describe, expect, it, vi } from 'vitest';
import { createSearchImageEmbedder } from '../services/searchImageEmbedder.js';
import { SearchReencodeAiError } from '../services/searchReencodeAi.js';
const sha = 'a'.repeat(64);
const profile = { package_id: 'siglip2-base-full-int8', package_sha256: sha, model_version: `search-v1-${sha}`, dimensions: 768, views: 4,
  input_spec_version: 'spec', files_verified: true, production_approval_declared: true, pruned: false, runtime_ready: false as const };
const jpeg = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);
describe('query picture encoder', () => {
  it('asks the AI service for the current model only, verifying the package once', async () => {
    const encode = vi.fn(async (input: { request: { target: unknown; jpeg_sha256: string; expires_ms: number }; dimensions: number }) => ({ vector: [1, 0] }) as never);
    const verify = vi.fn(async () => profile);
    const embed = createSearchImageEmbedder({ packageId: async () => profile.package_id, profile: verify, ai: { encode }, now: () => 1000 });
    expect(await embed(jpeg, profile.model_version)).toEqual([1, 0]);
    await embed(jpeg, profile.model_version);
    expect(verify).toHaveBeenCalledTimes(1);
    const input = encode.mock.calls[0]![0];
    expect(input.dimensions).toBe(768 * 4);
    expect(input.request.target).toEqual({ package_id: profile.package_id, package_sha256: sha, model_version: profile.model_version });
    expect(input.request.jpeg_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(input.request.expires_ms).toBe(26000);
  });
  it('treats another applied space as not ready and maps encoder failures to search states', async () => {
    const encode = vi.fn();
    const embed = createSearchImageEmbedder({ packageId: async () => profile.package_id, profile: async () => profile, ai: { encode } });
    await expect(embed(jpeg, 'search-v1-' + 'b'.repeat(64))).rejects.toMatchObject({ code: 'model_pending' });
    expect(encode).not.toHaveBeenCalled();
    for (const [failure, code] of [['busy', 'busy'], ['unsupported_image', 'image_invalid'], ['model_unavailable', 'image_unsupported'], ['timeout', 'image_unavailable'], ['target_changed', 'model_pending']] as const) {
      encode.mockRejectedValueOnce(new SearchReencodeAiError(failure));
      await expect(embed(jpeg, profile.model_version)).rejects.toMatchObject({ code });
    }
  });
  it('does not search without an applied model', async () => {
    const embed = createSearchImageEmbedder({ packageId: async () => null, profile: vi.fn(), ai: { encode: vi.fn() } });
    await expect(embed(jpeg, profile.model_version)).rejects.toMatchObject({ code: 'model_pending' });
  });
});
