import { createHash, randomUUID } from 'node:crypto';
import type { SearchMigrationModelProfile } from './searchModelMigrationContract.js';
import { SearchReencodeAiError, type SearchReencodeAiClient } from './searchReencodeAi.js';
import { SearchNativeError } from './searchNativeClient.js';

/** Query picture (one cropped JPEG) to a vector of the current search space. */
export type SearchImageEmbedder = (jpeg: Buffer, modelVersion: string) => Promise<number[]>;

/** The AI service's image encoder for historical evidence: hardware JPEG decode, the same GPU resize and the same
 * model as the sampled evidence. With the current model's sampling session running it reuses those weights.
 * Its request carries job identity for migrations; a query has none, so this names the query itself: the fields
 * are echoed and checked by the caller only, never stored. */
export function createSearchImageEmbedder(options: {
  packageId: () => Promise<string | null>;
  profile: (packageId: string) => Promise<SearchMigrationModelProfile>;
  ai: Pick<SearchReencodeAiClient, 'encode'>;
  now?: () => number;
}): SearchImageEmbedder {
  const now = options.now ?? Date.now;
  let cached: SearchMigrationModelProfile | null = null;
  return async (jpeg, modelVersion) => {
    const packageId = await options.packageId();
    if (!packageId) throw new SearchNativeError('model_pending');
    if (!cached || cached.package_id !== packageId || cached.model_version !== modelVersion) {
      cached = null;
      const profile = await options.profile(packageId).catch(() => { throw new SearchNativeError('model_pending'); });
      // The applied package must be the space the index answers in; a switch in progress is not ready.
      if (profile.model_version !== modelVersion) throw new SearchNativeError('model_pending');
      cached = profile;
    }
    const profile = cached;
    const digest = createHash('sha256').update(jpeg).digest('hex');
    try {
      const result = await options.ai.encode({ jpeg, dimensions: profile.dimensions * (profile.views ?? 1), request: {
        schema_version: 'search-reencode-image-v1', request_id: randomUUID(), job_id: randomUUID(), generation: 1,
        payload_fingerprint: digest, target: { package_id: profile.package_id, package_sha256: profile.package_sha256, model_version: profile.model_version },
        sample_id: randomUUID(), source_fingerprint: digest, jpeg_sha256: digest, expires_ms: now() + 25000,
      } });
      return result.vector;
    } catch (error) {
      if (error instanceof SearchReencodeAiError) {
        if (error.code === 'busy') throw new SearchNativeError('busy');
        if (error.code === 'unsupported_image') throw new SearchNativeError('image_invalid');
        if (error.code === 'model_unavailable') throw new SearchNativeError('image_unsupported');
        if (error.code === 'target_changed') { cached = null; throw new SearchNativeError('model_pending'); }
        throw new SearchNativeError('image_unavailable');
      }
      throw error;
    }
  };
}
