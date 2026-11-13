import { searchMigrationModelProfileSchema, type SearchMigrationModel } from './searchModelMigrationContract.js';

/** Reuse the native package contract, never a second package-name table.
 * Verification hashes model files, so coalesce reads and retain a successful
 * result for this immutable pin. A failed/old response is retried at most once
 * per 30 seconds; callers can keep scene sampling while verification is pending.
 * File verification is capability metadata, not hardware readiness or approval. */
export function createSearchModelViewsReader(
  verify: (packageId: string) => Promise<unknown>, now: () => number = Date.now,
): (pin: SearchMigrationModel) => Promise<number | null> {
  let cached: { key: string; result: Promise<number | null>; retryAt: number } | null = null;
  return pin => {
    const key = JSON.stringify([pin.package_id, pin.model_version, pin.package_sha256]);
    if (cached?.key === key && now() < cached.retryAt) return cached.result;
    const entry = { key, result: Promise.resolve<number | null>(null), retryAt: Infinity };
    entry.result = Promise.resolve().then(() => verify(pin.package_id)).then(raw => {
      const profile = searchMigrationModelProfileSchema.parse(raw);
      if (!profile.files_verified || profile.package_id !== pin.package_id ||
          profile.model_version !== pin.model_version || profile.package_sha256 !== pin.package_sha256)
        throw new Error('model_capability_identity_changed');
      return profile.views ?? null;
    }).catch(() => null).then(views => {
      if (views === null) entry.retryAt = now() + 30000;
      return views;
    });
    cached = entry;
    return entry.result;
  };
}
