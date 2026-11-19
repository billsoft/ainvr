import { searchMigrationModelProfileSchema, type SearchMigrationModel } from './searchModelMigrationContract.js';

/** What a verified package can do for sampling: how many view vectors a scene sample carries, and whether the
 * space also stores detector crops. Older services omit `objects`; then only a single-view space takes crops
 * (the rule before crop spaces with scene views existed). */
export interface SearchModelCapability { views: number; objects: boolean }

/** Reuse the native package contract, never a second package-name table.
 * Verification hashes model files, so coalesce reads and retain a successful
 * result for this immutable pin. A failed/old response is retried at most once
 * per 30 seconds; callers can keep scene sampling while verification is pending.
 * File verification is capability metadata, not hardware readiness or approval. */
export function createSearchModelCapabilityReader(
  verify: (packageId: string) => Promise<unknown>, now: () => number = Date.now,
): (pin: SearchMigrationModel) => Promise<SearchModelCapability | null> {
  let cached: { key: string; result: Promise<SearchModelCapability | null>; retryAt: number } | null = null;
  return pin => {
    const key = JSON.stringify([pin.package_id, pin.model_version, pin.package_sha256]);
    if (cached?.key === key && now() < cached.retryAt) return cached.result;
    const entry = { key, result: Promise.resolve<SearchModelCapability | null>(null), retryAt: Infinity };
    entry.result = Promise.resolve().then(() => verify(pin.package_id)).then(raw => {
      const profile = searchMigrationModelProfileSchema.parse(raw);
      if (!profile.files_verified || profile.package_id !== pin.package_id ||
          profile.model_version !== pin.model_version || profile.package_sha256 !== pin.package_sha256)
        throw new Error('model_capability_identity_changed');
      if (profile.views === undefined) return null;
      return { views: profile.views, objects: profile.objects ?? profile.views === 1 };
    }).catch(() => null).then(capability => {
      if (capability === null) entry.retryAt = now() + 30000;
      return capability;
    });
    cached = entry;
    return entry.result;
  };
}

/** View count only (callers that predate crop spaces). */
export function createSearchModelViewsReader(
  verify: (packageId: string) => Promise<unknown>, now: () => number = Date.now,
): (pin: SearchMigrationModel) => Promise<number | null> {
  const read = createSearchModelCapabilityReader(verify, now);
  return pin => read(pin).then(capability => capability?.views ?? null);
}
