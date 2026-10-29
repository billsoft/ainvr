import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { PgConfigStore } from '../store/pgStore.js';
import { searchSettingsSchema, type SearchSettings } from '../store/searchConfigAdapter.js';
import type {SearchMigrationIngestionGate} from './searchModelMigrationPlan.js';
import type { SearchSource, SearchSourceCatalog } from './searchSourceCatalog.js';
import type { SearchRuntimeState, SearchModelAuthority } from '../store/searchRuntimeStore.js';
import type { InternalServiceConnection } from './internalServiceHttp.js';

type ConfigStore = Pick<PgConfigStore, 'getServiceState' | 'getVersionSnapshotForService' | 'getSecret'>;
export interface SearchIndexDirectory {
  volume_id: string | null; relative_path: string; resolved_path: string | null;
  ready: boolean; generation: string | null;
}
export interface SearchRuntimeConfiguration {
  desired_version: number; revision: string; settings: SearchSettings;
  history_connection: { uri: string | null; database: string | null; source_version: number | null };
  index_directory: SearchIndexDirectory; sources: SearchSource[];
  dependency_status: 'history_unavailable' | 'storage_unavailable' | 'source_catalog_unavailable' | null;
  ingestion_gate?:SearchMigrationIngestionGate|null;
  active_model_pin?: SearchModelAuthority['active_model_pin'];
  approved_model_transition?: SearchModelAuthority['approved_model_transition'];
}
export interface SearchRuntimeDependencies {
  store: ConfigStore;
  sourceCatalog: () => Promise<SearchSourceCatalog>;
  volumes: () => Promise<unknown>;
  modelAuthority?: () => Promise<SearchModelAuthority>;
  ingestionGate?:(current:{revision:string;source_ids:readonly string[];active_model:SearchModelAuthority['active_model_pin'];approved_transition?:SearchModelAuthority['approved_model_transition']})=>Promise<{gate:SearchMigrationIngestionGate|null}>;
}
export class SearchConfigurationError extends Error {
  constructor(readonly code: 'config_pending' | 'caller_credentials_unavailable' | 'config_changed') { super(code); }
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function dependencyWithin<T>(read: () => Promise<T>): Promise<T | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 2000);
    void Promise.resolve().then(read).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}
const secretRef = /^\$\{secret:(search-service\/[a-zA-Z0-9_.\/-]+)\}$/;
const mongoRef = /^\$\{secret:(ai-service\/[a-zA-Z0-9_.\/-]+)\}$/;
const database = z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/).refine(value => !['admin', 'config', 'local'].includes(value));

export async function readAppliedSearchSettings(store: ConfigStore): Promise<SearchSettings | null> {
  const before = await store.getServiceState('search-service');
  if (before?.status !== 'applied' || !before.appliedVersion || before.appliedVersion !== before.desiredVersion) return null;
  const docs = await store.getVersionSnapshotForService(before.appliedVersion, 'search-service');
  const parsed = searchSettingsSchema.safeParse(docs.find(doc => doc.group === 'system' && doc.name === 'settings')?.config);
  const after = await store.getServiceState('search-service');
  return parsed.success && after?.status === 'applied' && after.appliedVersion === before.appliedVersion &&
    after.desiredVersion === before.desiredVersion ? parsed.data : null;
}

export function resolveSearchIndexDirectory(settings: SearchSettings, rawVolumes: unknown): SearchIndexDirectory {
  const selected = settings.index_storage;
  const absent: SearchIndexDirectory = { ...selected, resolved_path: null, ready: false, generation: null };
  if (!selected.volume_id) return absent;
  const parsed = z.object({ volumes: z.array(z.object({ id: z.string(), mountPath: z.string(), device: z.string(),
    filesystem: z.string(), system: z.boolean(), readOnly: z.boolean(), selectable: z.boolean(), state: z.string(),
  }).passthrough()).max(256) }).safeParse(rawVolumes);
  if (!parsed.success) return absent;
  const matches = parsed.data.volumes.filter(volume => volume.id === selected.volume_id);
  const volume = matches.length === 1 ? matches[0]! : null;
  if (!volume || !volume.selectable || volume.system || volume.readOnly || volume.state !== 'mounted' ||
    !/^\/(?:mnt|media|run\/media)\//.test(volume.mountPath) || /[\u0000-\u001f]/.test(volume.mountPath)) return absent;
  const root = path.posix.resolve(volume.mountPath), resolved = path.posix.resolve(root, selected.relative_path);
  if (!resolved.startsWith(`${root}/`)) return absent;
  return { ...selected, resolved_path: resolved, ready: true,
    generation: digest([volume.id, volume.device, volume.filesystem, root, selected.relative_path, resolved]) };
}

/** The service's own published settings remain the only search definition.
 * History credentials are projected from the AI service's applied snapshot by
 * this explicitly authorized backend path, never by relaxing secret prefixes. */
export async function readEffectiveSearchConfiguration(dependencies: SearchRuntimeDependencies,
  version?: number): Promise<SearchRuntimeConfiguration> {
  const { store } = dependencies;
  const service = await store.getServiceState('search-service');
  const desired = version ?? service?.desiredVersion;
  if (!desired || !Number.isSafeInteger(desired) || desired < 1) throw new SearchConfigurationError('config_pending');
  const docs = await store.getVersionSnapshotForService(desired, 'search-service');
  const settingsDoc = docs.find(doc => doc.group === 'system' && doc.name === 'settings');
  const parsed = searchSettingsSchema.safeParse(settingsDoc?.config);
  if (!parsed.success) throw new SearchConfigurationError('config_pending');
  const settings = parsed.data;
  for (const caller of settings.callers) {
    const reference = secretRef.exec(caller.key);
    const value = reference ? await store.getSecret(reference[1]!) : null;
    if (!value || value.length < 32 || value.length > 512 || /[\r\n]/.test(value))
      throw new SearchConfigurationError('caller_credentials_unavailable');
    caller.key = value;
  }
  const aiState = await store.getServiceState('ai-service');
  const sourceVersion = aiState?.appliedVersion ?? null;
  const history: SearchRuntimeConfiguration['history_connection'] = { uri: null, database: null, source_version: sourceVersion };
  if (sourceVersion) {
    const aiDocs = await store.getVersionSnapshotForService(sourceVersion, 'ai-service');
    const snap = aiDocs.find(doc => doc.group === 'system' && doc.name === 'settings')?.config.snapshot_store;
    if (snap && typeof snap === 'object' && !Array.isArray(snap)) {
      const config = snap as Record<string, unknown>, ref = typeof config.mongo_uri === 'string' ? mongoRef.exec(config.mongo_uri) : null;
      const db = database.safeParse(config.db_name);
      const uri = ref ? await store.getSecret(ref[1]!) : null;
      if (db.success && uri && /^mongodb(?:\+srv)?:\/\/\S+$/.test(uri) && uri.length <= 16384) {
        history.uri = uri; history.database = db.data;
      }
    }
  }
  const [rawVolumes, catalog, authority] = await Promise.all([
    dependencyWithin(dependencies.volumes), dependencyWithin(dependencies.sourceCatalog),
    dependencies.modelAuthority ? dependencyWithin(dependencies.modelAuthority) : Promise.resolve(undefined),
  ]);
  if(dependencies.modelAuthority && !authority)throw new SearchConfigurationError('config_pending');
  const index = resolveSearchIndexDirectory(settings, rawVolumes);
  const sources = (catalog?.sources ?? []).filter(source => settings.sampling.mode === 'all' ||
    settings.sampling.channel_ids.includes(source.channel_id)).map(source => ({ ...source,
      object: source.object && settings.sampling.object, scene: source.scene && settings.sampling.scene,
  }));
  const dependency = !history.uri || !history.database ? 'history_unavailable' : !index.ready ? 'storage_unavailable' :
    !catalog || (settings.sampling.mode === 'selected' && sources.length !== settings.sampling.channel_ids.length) ? 'source_catalog_unavailable' : null;
  const revision = digest({ desired, settings, history, index, sources, source_identities: catalog?.identities ?? null,
    dependency_status: dependency, ...(authority ? {model_authority:authority}: {}) });
  const [serviceAfter, aiAfter] = await Promise.all([store.getServiceState('search-service'), store.getServiceState('ai-service')]);
  if (serviceAfter?.desiredVersion !== service?.desiredVersion || aiAfter?.appliedVersion !== aiState?.appliedVersion)
    throw new SearchConfigurationError('config_changed');
  if(dependencies.modelAuthority && JSON.stringify(await dependencyWithin(dependencies.modelAuthority))!==JSON.stringify(authority))
    throw new SearchConfigurationError('config_changed');
  const operational=dependencies.ingestionGate?await dependencyWithin(()=>dependencies.ingestionGate!({revision,source_ids:sources.map(source=>source.channel_id),active_model:authority?.active_model_pin??null,...(authority?{approved_transition:authority.approved_model_transition}:{})})):undefined;
  if(dependencies.ingestionGate&&!operational)throw new SearchConfigurationError('config_pending');
  return { desired_version: desired, revision, settings, history_connection: history,
    index_directory: index, sources, dependency_status: dependency, ...(authority ?? {}),...(operational?{ingestion_gate:operational.gate}:{}) };
}

/** All BFF data operations are fenced by both the acknowledged version and the
 * live dependency revision. A history/source/storage change cannot silently
 * make an old search session read a different database under the same version. */
export async function readAppliedSearchConfiguration(dependencies: SearchRuntimeDependencies,
  runtime: { read(): Promise<SearchRuntimeState | null> }): Promise<SearchRuntimeConfiguration | null> {
  try {
    const before = await dependencies.store.getServiceState('search-service');
    if (before?.status !== 'applied' || !before.appliedVersion || before.appliedVersion !== before.desiredVersion) return null;
    const ack = await runtime.read();
    if (ack?.status !== 'applied' || ack.desired_version !== before.appliedVersion) return null;
    const effective = await readEffectiveSearchConfiguration(dependencies, before.appliedVersion);
    if (effective.revision !== ack.revision) return null;
    if (effective.settings.enabled && effective.dependency_status) return null;
    const [after, acknowledgement] = await Promise.all([dependencies.store.getServiceState('search-service'), runtime.read()]);
    if (after?.status !== 'applied' || after.appliedVersion !== before.appliedVersion ||
      after.desiredVersion !== before.desiredVersion || acknowledgement?.revision !== ack.revision || acknowledgement.status !== 'applied') return null;
    return effective;
  } catch { return null; }
}

export async function readAppliedSearchConnection(dependencies: SearchRuntimeDependencies,
  runtime: { read(): Promise<SearchRuntimeState | null> }, host = '127.0.0.1'): Promise<InternalServiceConnection | null> {
  if (!['127.0.0.1', 'localhost', 'host.docker.internal'].includes(host)) return null;
  const effective = await readAppliedSearchConfiguration(dependencies, runtime);
  const caller = effective?.settings.callers.find(value => value.name === 'console' && value.scope === 'console');
  return effective && caller ? { baseUrl: `http://${host}:${effective.settings.listen.port}`, apiToken: caller.key, timeoutMs: 30000 } : null;
}
