import type { PgConfigStore } from './pgStore.js';
import type { ServiceConfigAdapter } from './adapter.js';

type Store = Pick<PgConfigStore, 'getServiceState' | 'getLatestVersion' |
  'getVersionSnapshotForService' | 'updateServiceState'>;

/** Restore only backend-owned adapters before accepting requests. Pull services
 * must report their own state. Never confirm a version without applying it. */
export async function restoreLocalConfig(store: Store, adapter: ServiceConfigAdapter): Promise<boolean> {
  const serviceName = adapter.serviceName;
  try {
    const state = await store.getServiceState(serviceName);
    const version = state?.desiredVersion ?? (await store.getLatestVersion('published'))?.version;
    if (version == null) return true;
    const docs = await store.getVersionSnapshotForService(version, serviceName);
    if (!docs.length && state?.desiredVersion == null) {
      // No configuration has ever been published for this service. Its startup
      // settings remain authoritative; do not invent a published version.
      await store.updateServiceState({serviceName, status:'unknown', restartRequired:false, errorMessage:''});
      return true;
    }
    if (!docs.length) throw new Error('Missing configuration snapshot');
    const validation = await adapter.validate(docs);
    if (!validation.ok) throw new Error('Invalid configuration snapshot');
    const result = await adapter.apply(docs, version);
    if (!result.ok || result.applyVia === 'pull') throw new Error('Configuration apply failed');
    await store.updateServiceState({ serviceName, desiredVersion: version, appliedVersion: version,
      status: result.restartRequired ? 'partial' : 'applied', restartRequired: result.restartRequired,
      errorMessage: '', appliedAt: new Date() });
    return true;
  } catch {
    // Do not leak configuration or credentials in logs or the public status.
    console.error(`[config] ${serviceName}: startup configuration application failed`);
    await store.updateServiceState({ serviceName, status: 'failed',
      errorMessage: '启动时应用配置失败，请检查配置与服务连接后重新保存' }).catch(() => undefined);
    return false;
  }
}
