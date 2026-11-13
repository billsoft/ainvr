import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { SearchSourceChannel } from './searchSourceCatalog.js';
import type { InternalServiceConnection } from './internalServiceHttp.js';
import type { PgConfigStore } from '../store/pgStore.js';
import { FacesStore } from '../store/facesStore.js';
import { FacesMongo, type FacesMongoConnection } from '../store/facesMongo.js';
import { FacesNativeClient } from './facesNativeClient.js';
import { FacesPhotos } from './facesPhotos.js';
import { FacesRuntime } from './facesRuntime.js';
import { FacesArchiveProducer } from './facesArchiveProducer.js';
import { FacesDemand } from './facesDemand.js';
import { FacesError, type FacesDiagnostic } from './facesContract.js';
import { operationalLog } from './operationalLog.js';
import { FacesService } from './facesService.js';
import { facesRoutes } from '../routes/facesRoutes.js';
import { facesIngestRoutes, type FacesIngestOptions } from '../routes/facesIngestRoutes.js';

/** Existing applied AI history authority; independent of enabling text search. */
export async function facesHistoryConnection(store: PgConfigStore | null): Promise<FacesMongoConnection | null> {
  if (!store) return null;
  const before = await store.getServiceState('ai-service');
  if (!before?.appliedVersion) return null;
  const docs = await store.getVersionSnapshotForService(before.appliedVersion, 'ai-service');
  const raw = docs.find(document => document.group === 'system' && document.name === 'settings')?.config.snapshot_store;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.mongo_uri !== 'string' || typeof value.db_name !== 'string') return null;
  const reference = /^\$\{secret:(ai-service\/[a-zA-Z0-9_.\/-]+)\}$/.exec(value.mongo_uri);
  if (!reference) return null;
  const uri = await store.getSecret(reference[1]);
  const after = await store.getServiceState('ai-service');
  if (!uri || after?.appliedVersion !== before.appliedVersion) return null;
  return { uri, database: value.db_name };
}
export interface FacesRegistrationOptions {
  captureAuthorized?: () => boolean;
  pool: Pool | null; principal: (request: FastifyRequest) => Promise<string | null>;
  channels: (actor: string) => Promise<SearchSourceChannel[]>;
  extractorConnection: () => Promise<InternalServiceConnection | null>;
  mongoConnection: () => Promise<FacesMongoConnection | null>;
  volumes: () => Promise<unknown>;
  internalPrincipal?: FacesIngestOptions['internalPrincipal']; authorizeCapture?: FacesIngestOptions['authorizeCapture']; captureSources?: FacesIngestOptions['captureSources'];
}
/** Register under the existing /api scope, after alarmPrincipal/searchChannels exist.
 * Main owns app.ts, service-token resolution, license gate and hardware enablement.
 * Add exact alarm-service POST /api/internal/faces/captures auth delegation only when
 * the authoritative capture grant callback is wired; never exempt public routes.
 */
export async function registerFaces(app: FastifyInstance, options: FacesRegistrationOptions) {
  const mongo = new FacesMongo(options.mongoConnection);
  const store = options.pool ? new FacesStore(options.pool) : null;
  const native = new FacesNativeClient(options.extractorConnection);
  const health: Record<'maintenance' | 'reconcile' | 'producer', FacesDiagnostic> = {
    producer: { task: 'producer', state: 'unknown', reason: 'not_run', last_success_at: null },
    maintenance: { task: 'maintenance', state: 'unknown', reason: 'not_run', last_success_at: null },
    reconcile: { task: 'reconcile', state: 'unknown', reason: 'not_run', last_success_at: null },
  };
  const demand = new FacesDemand(native, async () => {
    if (!store) throw new FacesError('faces_configuration_unavailable', '人脸配置库暂不可用', 503);
    const available = new Set((await options.channels('console-administrator')).map(channel => channel.id));
    return (await store.list()).filter(library => library.document.channel_ids.some(id => available.has(id)));
  },
    async () => { if (!options.captureSources) throw Error('faces_sources_unavailable'); return (await options.captureSources()).some(source => source.capture_supported); },
    async () => !!await (await mongo.db()).collection('faces_records').findOne({ kind: 'capture', state: 'ready', 'data.quality.state': 'qualified', expires_at: { $gt: new Date() } }, { projection: { _id: 1 }, maxTimeMS: 3000 }));
  const runtime = new FacesRuntime(mongo, new FacesPhotos(options.volumes), { status: () => demand.status(), extract: native.extract.bind(native) }, async () => store ? store.list() : [], () => Object.values(health));
  const producer = options.captureSources && options.captureAuthorized ? new FacesArchiveProducer(mongo, runtime, options.captureSources, options.captureAuthorized) : null;
  const service = new FacesService(store, runtime, options.channels);
  await app.register(facesRoutes, { principal: options.principal, service });
  if (options.internalPrincipal && options.authorizeCapture) await app.register(facesIngestRoutes, { runtime, internalPrincipal: options.internalPrincipal, authorizeCapture: options.authorizeCapture, captureSources: options.captureSources,
    recordImage: id => service.recordImage(id, 'console-administrator') });
  const jobs: Partial<Record<'maintenance' | 'reconcile' | 'producer', Promise<void>>> = {};
  function background(task: 'maintenance' | 'reconcile' | 'producer', work: () => Promise<unknown>) {
    if (jobs[task]) return;
    jobs[task] = work().then(() => {
      if (health[task].state === 'degraded') operationalLog('INFO', 'faces', `${task}:recovered`);
      health[task] = { task, state: 'ok', reason: null, last_success_at: new Date().toISOString() };
    }, error => {
      const reason = error instanceof FacesError && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'faces_background_unavailable';
      health[task] = { ...health[task], state: 'degraded', reason };
      // operationalLog coalesces repeats for 60s; never log URI/JPEG/vector/body.
      operationalLog('WARN', 'faces', `${task}:${reason}`);
    }).finally(() => { delete jobs[task]; });
  }
  const maintenance = setInterval(() => { background('maintenance', () => runtime.maintainStorage()); }, 60000);
  maintenance.unref();
  const reconcile = setInterval(() => { demand.invalidate(); background('reconcile', async () => {
    const status = await demand.status();
    if (!status.can_extract && status.configuration?.enabled) throw new FacesError(status.reason === 'faces_model_conflict' ? 'faces_model_conflict' : 'faces_model_pending', '人脸模型尚未生效', 503);
  }); }, 5000);
  reconcile.unref();
  const captureTimer = setInterval(() => { if (producer) background('producer', () => producer.tick()); }, 2000);
  captureTimer.unref();
  app.addHook('onClose', async () => { clearInterval(maintenance); clearInterval(reconcile); clearInterval(captureTimer); await Promise.all(Object.values(jobs)); await runtime.close(); });
  return { service, runtime };
}
