import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { DEFAULT_SEARCH_SETTINGS, prepareSearchSettings } from '../store/searchConfigAdapter.js';
import { readAppliedSearchConnection, readEffectiveSearchConfiguration, resolveSearchIndexDirectory } from '../services/searchConnection.js';
import { buildSearchSourceCatalog, type SearchSourceCatalog } from '../services/searchSourceCatalog.js';
import { searchRuntimeRoutes } from '../routes/searchRuntimeRoutes.js';

const input = 'fe671d50-8714-482e-9083-b92692b4dfaa', output = 'd9d39f59-0f10-43ec-89f1-b8af97676d84';
function fixture() {
  const config = prepareSearchSettings(structuredClone(DEFAULT_SEARCH_SETTINGS));
  config.callers = config.callers.map(c => ({ ...c, key: '${secret:search-service/callers.' + c.name + '.key/v1}' }));
  config.index_storage.volume_id = 'disk-uuid';
  const versions = { search: 2, applied: 2, ai: 1 };
  const store = {
    getServiceState: vi.fn(async (name: string) => name === 'search-service'
      ? { appliedVersion: versions.applied, desiredVersion: versions.search, status: 'applied' }
      : { appliedVersion: versions.ai }),
    getVersionSnapshotForService: vi.fn(async (_version: number, service: string) => [{ group: 'system', name: 'settings', config:
      service === 'search-service' ? config : { snapshot_store: { mongo_uri: '${secret:ai-service/snapshot_store.mongo_uri/v1}', db_name: 'ai_snapshots' } } }]),
    getSecret: vi.fn(async (name: string) => name.startsWith('ai-service/') ? 'mongodb://fixture-only/history' : name.includes('console') ? 'a'.repeat(64) : 'b'.repeat(64)),
  };
  const volumes = vi.fn(async () => ({ volumes: [{ id: 'disk-uuid', device: '/dev/fake1', filesystem: 'ext4',
    mountPath: '/mnt/fixture-disk', system: false, readOnly: false, selectable: true, state: 'mounted' }] }));
  const sourceCatalog = vi.fn(async (): Promise<SearchSourceCatalog> => ({ sources: [{ channel_id: output, input_stream_id: input,
    processor_id: 'processor-1', input_path: '/live/raw', output_path: '/live/ai', recording_channel_id: output, object: true, scene: true }],
  channels: [{ id: output, name: 'AI output' }], identities: ['stable'] }));
  return { dependencies: { store: store as never, volumes, sourceCatalog }, config, store, versions, volumes, sourceCatalog };
}
it('production producer grants wait for an actual pin and carry its exact expected model pair',async()=>{
  const f=fixture();f.config.enabled=true;
  const model={package_id:f.config.model.package_id!,model_version:`search-v1-${'a'.repeat(64)}`,package_sha256:'a'.repeat(64)};
  let authority:any={active_model_pin:null,approved_model_transition:null};
  const dependencies={...f.dependencies,modelAuthority:async()=>authority};
  let revision=(await readEffectiveSearchConfiguration(dependencies)).revision;
  const runtime={read:async()=>({desired_version:2,revision,status:'applied' as const,error_code:null}),acknowledge:async()=>true};
  const app=Fastify();await app.register(searchRuntimeRoutes,{dependencies,runtime,internalPrincipal:async()=>false,
    producerPrincipal:async req=>req.headers['x-service-token']==='ai-only',principal:async()=>null,managementConnection:async()=>null});
  try{
    const read=async()=> (await app.inject({url:'/internal/search/producer-config',headers:{'x-service-token':'ai-only'}})).json();
    expect(await read()).toMatchObject({enabled:false,reason:'config_pending',model:{package_id:null},sources:[],api_token:null});
    authority={active_model_pin:model,approved_model_transition:null};revision=(await readEffectiveSearchConfiguration(dependencies)).revision;
    const active=await read();expect(active.enabled).toBe(true);expect(active.model).toEqual({package_id:model.package_id,
      expected_model_version:model.model_version,expected_package_sha256:model.package_sha256});
    authority={active_model_pin:model,approved_model_transition:{job_id:output,generation:1,payload_fingerprint:'b'.repeat(64),source:model,target:{...model,model_version:`search-v1-${'c'.repeat(64)}`,package_sha256:'c'.repeat(64)}}};
    revision=(await readEffectiveSearchConfiguration(dependencies)).revision;
    expect(await read()).toMatchObject({enabled:false,model:{package_id:null},sources:[],api_token:null,limits:null});
  }finally{await app.close();}
});
it('model authority changes invalidate the same runtime revision and cannot race a configuration read',async()=>{
  const f=fixture(),model={package_id:f.config.model.package_id!,model_version:`search-v1-${'a'.repeat(64)}`,package_sha256:'a'.repeat(64)};
  let authority:any={active_model_pin:null,approved_model_transition:null};const dependencies={...f.dependencies,modelAuthority:async()=>authority};
  const first=await readEffectiveSearchConfiguration(dependencies);authority={active_model_pin:model,approved_model_transition:null};
  expect((await readEffectiveSearchConfiguration(dependencies)).revision).not.toBe(first.revision);
  const moving={...f.dependencies,modelAuthority:vi.fn().mockResolvedValueOnce({active_model_pin:null,approved_model_transition:null}).mockResolvedValueOnce(authority)};
  await expect(readEffectiveSearchConfiguration(moving)).rejects.toThrow('config_changed');
});
describe('effective search configuration and dependency fencing', () => {
  it('projects only applied AI history and changes revision when its applied generation changes', async () => {
    const f = fixture(), first = await readEffectiveSearchConfiguration(f.dependencies);
    expect(first.history_connection.database).toBe('ai_snapshots');
    expect(first.history_connection.source_version).toBe(1);
    expect(first.settings.callers[0].key).toBe('a'.repeat(64));
    expect(first.sources[0].recording_channel_id).toBe(output);
    expect(first.index_directory.resolved_path).toBe('/mnt/fixture-disk/ainvr/search-index');
    expect(first.dependency_status).toBeNull();
    f.versions.ai = 3;
    const second = await readEffectiveSearchConfiguration(f.dependencies);
    expect(second.revision).not.toBe(first.revision);
    expect(f.store.getVersionSnapshotForService).toHaveBeenCalledWith(3, 'ai-service');
  });
  it('does not return a connection until native has ACKed the same live dependency revision', async () => {
    const f = fixture(), effective = await readEffectiveSearchConfiguration(f.dependencies);
    let revision = effective.revision;
    const runtime = { read: async () => ({ desired_version: 2, revision, status: 'applied' as const, error_code: null }) };
    expect((await readAppliedSearchConnection(f.dependencies, runtime))?.baseUrl).toBe('http://127.0.0.1:8400');
    revision = 'f'.repeat(64);
    expect(await readAppliedSearchConnection(f.dependencies, runtime)).toBeNull();
    revision = effective.revision; f.versions.ai = 4;
    expect(await readAppliedSearchConnection(f.dependencies, runtime)).toBeNull();
    f.versions.ai = 1; f.versions.search = 3;
    expect(await readAppliedSearchConnection(f.dependencies, runtime)).toBeNull();
  });
  it('does not guess history defaults or accept cross-service caller secrets', async () => {
    const f = fixture(); f.store.getSecret.mockResolvedValue(null as never);
    await expect(readEffectiveSearchConfiguration(f.dependencies)).rejects.toThrow('caller_credentials_unavailable');
    f.config.callers = [];
    const disabled = await readEffectiveSearchConfiguration(f.dependencies);
    expect(disabled.settings.enabled).toBe(false);
    expect(disabled.history_connection.uri).toBeNull();
    expect(disabled.dependency_status).toBe('history_unavailable');
  });
  it('rejects system/read-only/unmounted/duplicate UUIDs and never falls back to eMMC', async () => {
    const f = fixture(), raw = await f.volumes();
    for (const changes of [{ system: true }, { readOnly: true }, { state: 'unmounted' }, { mountPath: '/' }]) {
      const value = structuredClone(raw); Object.assign(value.volumes[0], changes);
      expect(resolveSearchIndexDirectory(f.config, value).resolved_path).toBeNull();
    }
    raw.volumes.push(raw.volumes[0]);
    expect(resolveSearchIndexDirectory(f.config, raw).ready).toBe(false);
  });
  it('binds mount generation to both configured and resolved directories on the same volume', async () => {
    const f = fixture(), raw = await f.volumes();
    const first = resolveSearchIndexDirectory(f.config, raw);
    expect(resolveSearchIndexDirectory(f.config, structuredClone(raw))).toEqual(first);
    expect(first.generation).toBe(createHash('sha256').update(JSON.stringify([
      'disk-uuid', '/dev/fake1', 'ext4', '/mnt/fixture-disk', 'ainvr/search-index', '/mnt/fixture-disk/ainvr/search-index',
    ])).digest('hex'));
    f.config.index_storage.relative_path = 'ainvr/search-index-next';
    const changed = resolveSearchIndexDirectory(f.config, raw);
    expect(changed.ready).toBe(true);
    expect(changed.volume_id).toBe(first.volume_id);
    expect(changed.generation).not.toBe(first.generation);
    expect(resolveSearchIndexDirectory(f.config, raw)).toEqual(changed);
  });
  it('refuses the old catalog acknowledgement after switching directories without changing the volume', async () => {
    const f = fixture(), first = await readEffectiveSearchConfiguration(f.dependencies);
    const runtime = { read: async () => ({ desired_version: 2, revision: first.revision, status: 'applied' as const, error_code: null }) };
    expect(await readAppliedSearchConnection(f.dependencies, runtime)).not.toBeNull();
    f.config.index_storage.relative_path = 'ainvr/search-index-next';
    const changed = await readEffectiveSearchConfiguration(f.dependencies);
    expect(changed.index_directory.generation).not.toBe(first.index_directory.generation);
    expect(changed.revision).not.toBe(first.revision);
    expect(await readAppliedSearchConnection(f.dependencies, runtime)).toBeNull();
  });
  it('a stalled optional dependency cannot prevent a disabled service from applying', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.sourceCatalog.mockImplementation(() => new Promise(() => undefined));
      const pending = readEffectiveSearchConfiguration(f.dependencies);
      await vi.advanceTimersByTimeAsync(2001);
      const effective = await pending;
      expect(effective.settings.enabled).toBe(false);
      expect(effective.dependency_status).toBe('source_catalog_unavailable');
    } finally { vi.useRealTimers(); }
  });
  it('migration defaults preserve the historical initial package and do not alter other desired service versions', () => {
    const sql = readFileSync(new URL('../store/migrations/018_search_runtime.sql', import.meta.url), 'utf8');
    const json = /VALUES\('search-service','system','settings','([\s\S]*?)'::jsonb/.exec(sql)![1];
    expect(JSON.parse(json)).toEqual({ ...DEFAULT_SEARCH_SETTINGS, model: { package_id: 'siglip-so400m-i18n-full-int8' } });
    expect(sql).toContain("WHERE service_name='search-service'");
    expect(sql).not.toContain('DELETE');
  });
});

it('static sources include only unique AI outputs, retain offline mappings and gate objects on configured tracking', () => {
  const channels = [
    { id: input, name: 'Raw', streamName: 'raw', app: 'live', inputGeneration: 'one' },
    { id: output, name: 'AI', streamName: 'ai', app: 'live' },
  ] as never;
  const processor = { id: 'processor-1', config: { stream: { url: 'rtmp://127.0.0.1:1935/live/raw' },
    inference_fps: 10, analytics: { enabled: true }, publish: { enabled: true, target_url: 'rtmp://127.0.0.1/live/ai' } } };
  const active = buildSearchSourceCatalog(channels, [processor]);
  expect(active.channels).toEqual([{ id: output, name: 'AI', sampling_supported: true, sampling_reason: null }]);
  expect(active.sources[0]).toMatchObject({ channel_id: output, input_stream_id: input, recording_channel_id: output,
    input_path: '/live/raw', output_path: '/live/ai', object: true });
  processor.config.analytics.enabled = false;
  expect(buildSearchSourceCatalog(channels, [processor]).sources[0]).toMatchObject({ object: false, scene: true });
  expect(buildSearchSourceCatalog(channels, [processor, { ...processor, id: 'other' }]).sources).toEqual([]);
});

it('keeps original source identity but projects actual consumed and effective published paths for chained AI', () => {
  const final = 'fd5805ea-755c-4b09-86e8-64d07cad1903';
  const channels = [
    { id: input, name: 'Raw', streamName: 'raw', app: 'live' },
    { id: output, name: 'First AI', streamName: 'first-ai', app: 'live' },
    { id: final, name: 'Second AI', streamName: 'second-ai', app: 'analysis' },
  ] as never;
  const processors = [
    { id: 'first', config: { stream: { url: 'rtmp://127.0.0.1/live/raw' }, publish: { enabled: true, target_url: 'rtmp://localhost/live/first-ai' } } },
    { id: 'second', config: { stream: { url: 'rtmp://localhost:1935/live/first-ai' }, publish: { enabled: true,
      target_url: 'rtmp://127.0.0.1/live/old-target', effective_target_url: 'rtmp://127.0.0.1:1935/analysis/second-ai' } } },
  ];
  const catalog = buildSearchSourceCatalog(channels, processors);
  expect(catalog.sources.find(source => source.channel_id === final)).toMatchObject({
    input_stream_id: input, processor_id: 'second', input_path: '/live/first-ai', output_path: '/analysis/second-ai', recording_channel_id: final,
  });
  expect(catalog.sources.find(source => source.channel_id === output)?.input_path).toBe('/live/raw');
  expect(catalog.sources.map(source => source.output_path)).not.toContain('/live/old-target');
});

it('never projects credential-bearing, non-local or non-RTMP stream addresses', () => {
  const channels = [{ id: input, name: 'Raw', streamName: 'raw', app: 'live' }, { id: output, name: 'AI', streamName: 'ai', app: 'live' }] as never;
  const original = { id: 'processor', config: { stream: { url: 'rtmp://127.0.0.1/live/raw' },
    publish: { enabled: true, target_url: 'rtmp://127.0.0.1/live/ai' } } };
  for (const url of ['rtmp://user:private@127.0.0.1/live/raw', 'rtmp://192.0.2.1/live/raw', 'rtsp://127.0.0.1/live/raw']) {
    const processor = structuredClone(original); processor.config.stream.url = url;
    expect(buildSearchSourceCatalog(channels, [processor]).sources).toEqual([]);
  }
  const processor = structuredClone(original); processor.config.publish.target_url = 'rtmp://user:private@127.0.0.1/live/ai';
  expect(buildSearchSourceCatalog(channels, [processor]).sources).toEqual([]);
});

it('omits invalid legacy stream names without hiding or renaming unrelated valid sources', () => {
  const badInput = 'cf1acf02-5a04-421a-b9af-d340abdd1f65', badOutput = '07541859-929f-48e8-b50d-0366d78c2692';
  for (const badName of ['old.name', 'encoded%2Dname']) {
    const channels = [
      { id: input, name: 'Valid raw', streamName: 'raw', app: 'live' },
      { id: output, name: 'Valid AI', streamName: 'ai', app: 'live' },
      { id: badInput, name: 'Legacy raw', streamName: badName, app: 'live' },
      { id: badOutput, name: 'Legacy AI', streamName: 'legacy_ai', app: 'live' },
    ] as never;
    const processors = [
      { id: 'valid-processor', config: { stream: { url: 'rtmp://127.0.0.1/live/raw' }, publish: { enabled: true, target_url: 'rtmp://127.0.0.1/live/ai' } } },
      { id: 'legacy-processor', config: { stream: { url: `rtmp://127.0.0.1/live/${badName}` }, publish: { enabled: true, target_url: 'rtmp://127.0.0.1/live/legacy_ai' } } },
    ];
    const catalog = buildSearchSourceCatalog(channels, processors);
    expect(catalog.channels).toEqual([{ id: output, name: 'Valid AI', sampling_supported: true, sampling_reason: null }]);
    expect(catalog.sources).toHaveLength(1);
    expect(catalog.sources[0]).toMatchObject({ input_path: '/live/raw', output_path: '/live/ai' });
    expect(JSON.stringify(catalog)).not.toContain(badName);
    expect(processors[1].config.stream.url).toContain(badName);
  }
});

it('changing an actual processor path changes the same runtime revision instead of introducing another identity', async () => {
  const f = fixture(), first = await readEffectiveSearchConfiguration(f.dependencies);
  const catalog = await f.sourceCatalog(); catalog.sources[0].input_path = '/live/new-actual-input';
  f.sourceCatalog.mockResolvedValue(catalog);
  const changed = await readEffectiveSearchConfiguration(f.dependencies);
  expect(changed.revision).not.toBe(first.revision);
  expect(changed.sources[0].input_stream_id).toBe(first.sources[0].input_stream_id);
});

it('runtime API rejects console/foreign identities, rejects stale ACKs, and allows disabled ACK without history or models', async () => {
  const f = fixture(), app = Fastify(), acknowledge = vi.fn(async () => true);
  await app.register(searchRuntimeRoutes, {
    dependencies: f.dependencies, runtime: { acknowledge },
    internalPrincipal: async req => req.headers['x-service-token'] === 'search-config-only',
    producerPrincipal: async req => req.headers['x-service-token'] === 'ai-config-only',
    principal: async req => req.headers['x-console-token'] === 'console-only' ? 'admin' : null,
    managementConnection: async () => null,
  } as never);
  try {
    for (const headers of [{}, { 'x-console-token': 'console-only' }, { 'x-service-token': 'other-service' }])
      expect((await app.inject({ url: '/internal/search/runtime-config', headers })).statusCode).toBe(403);
    const response = await app.inject({ url: '/internal/search/runtime-config', headers: { 'x-service-token': 'search-config-only' } });
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    const effective = response.json();
    expect((await app.inject({ method: 'POST', url: '/internal/search/runtime-state', headers: { 'x-service-token': 'search-config-only' },
      payload: { desired_version: 2, revision: '0'.repeat(64), status: 'applied' } })).statusCode).toBe(409);
    expect(acknowledge).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/internal/search/runtime-state', headers: { 'x-service-token': 'search-config-only' },
      payload: { desired_version: 2, revision: effective.revision, status: 'applied' } })).statusCode).toBe(200);
    expect(acknowledge).toHaveBeenCalledWith({desired_version:2,revision:effective.revision,status:'applied',error_code:null},
      {expected_transition:null});
    expect((await app.inject({ url: '/search/models', headers: { 'x-console-token': 'console-only' } })).json())
      .toEqual({ items: [], service_ready: false, reason: 'service_unavailable' });
  } finally { await app.close(); }
});

it('AI receives only applied producer credentials, withholds them on disabled or changed dependencies', async () => {
  const f = fixture(); f.config.enabled = true; f.config.model.package_id = 'candidate-package';
  Object.assign(f.config.limits, { producer_queue: 3, producer_bytes: 33554432, image_max_bytes: 1048576, retention_days: 7 });
  let revision = (await readEffectiveSearchConfiguration(f.dependencies)).revision;
  const app = Fastify();
  await app.register(searchRuntimeRoutes, {
    dependencies: f.dependencies,
    runtime: { acknowledge: async () => true, read: async () => ({ desired_version: 2, revision, status: 'applied', error_code: null }) },
    internalPrincipal: async req => req.headers['x-service-token'] === 'search-config-only',
    producerPrincipal: async req => req.headers['x-service-token'] === 'ai-config-only',
    principal: async () => 'admin', managementConnection: async () => null,
  } as never);
  try {
    for (const token of ['', 'console-only', 'search-config-only', 'recorder-config-only'])
      expect((await app.inject({ url: '/internal/search/producer-config', headers: { 'x-service-token': token } })).statusCode).toBe(403);
    const read = () => app.inject({ url: '/internal/search/producer-config', headers: { 'x-service-token': 'ai-config-only' } });
    const active = await read();
    expect(active.json()).toMatchObject({ enabled: true, endpoint: 'http://127.0.0.1:8400', api_token: 'b'.repeat(64),
      revision, model: { package_id: 'candidate-package' }, valid_for_ms: 30000 });
    expect(active.json().limits).toEqual({ producer_queue: 3, producer_bytes: 33554432, image_max_bytes: 1048576, retention_days: 7 });
    expect(active.json().sources[0]).toMatchObject({ input_path: '/live/raw', output_path: '/live/ai' });
    for (const privateValue of ['a'.repeat(64), 'mongodb://', 'ai_snapshots', '/mnt/fixture-disk', 'http_workers', 'query_concurrency']) expect(active.body).not.toContain(privateValue);
    const inactive = (reason: string) => ({ enabled: false, reason, endpoint: null, api_token: null, revision: null,
      model: { package_id: null }, sampling: null, sources: [], valid_for_ms: 0, limits: null });
    f.versions.ai = 3;
    expect((await read()).json()).toEqual(inactive('config_pending'));
    f.versions.ai = 1; f.config.enabled = false;
    revision = (await readEffectiveSearchConfiguration(f.dependencies)).revision;
    const disabled = await read();
    expect(disabled.json()).toEqual(inactive('disabled'));
    expect(disabled.body).not.toContain('b'.repeat(64));
  } finally { await app.close(); }
});

it('keeps mixed raw-planar and ERP historical sources while refusing both ERP sampling kinds', async () => {
  const erp = 'fd5805ea-755c-4b09-86e8-64d07cad1903';
  const channels = [{ id: input, name: 'Raw', app: 'live', streamName: 'raw' },
    { id: output, name: 'Normal', app: 'live', streamName: 'ai' },
    { id: erp, name: 'Panorama', app: 'live', streamName: 'erp' }] as never;
  const processor = { id: 'normal', config: { inference_fps: 10, analytics: { enabled: true },
    stream: { url: 'rtmp://127.0.0.1/live/raw' }, publish: { enabled: true, target_url: 'rtmp://127.0.0.1/live/ai' } } };
  const panoramic = structuredClone(processor);
  panoramic.id = 'panorama'; panoramic.config.publish.target_url = 'rtmp://127.0.0.1/live/erp';
  const catalog = buildSearchSourceCatalog(channels, [processor, { ...panoramic,
    config: { ...panoramic.config, snapshot: { projection_mode: 'erp_equirect' } } }]);
  expect(catalog.sources.find(source => source.channel_id === output)).toMatchObject({ object: true, scene: true });
  expect(catalog.sources.find(source => source.channel_id === erp)).toMatchObject({ object: false, scene: false });
  expect(catalog.channels.find(source => source.id === erp)).toMatchObject({ sampling_supported: false, sampling_reason: 'projection_unsupported' });
  expect(catalog.channels.map(source => source.id)).toEqual([output, erp].sort());
  const f = fixture(); f.sourceCatalog.mockResolvedValue(catalog);
  expect((await readEffectiveSearchConfiguration(f.dependencies)).dependency_status).toBeNull();
  f.config.sampling.mode = 'selected'; f.config.sampling.channel_ids = [erp];
  const selected = await readEffectiveSearchConfiguration(f.dependencies);
  expect(selected.dependency_status).toBeNull();
  expect(selected.sources).toHaveLength(1);
  expect(selected.sources[0]).toMatchObject({ channel_id: erp, object: false, scene: false });
});
it('defaults a missing processing projection to none and changes the same runtime revision on ERP switches', async () => {
  const channels = [{ id: input, name: 'Raw', app: 'live', streamName: 'raw' },
    { id: output, name: 'AI', app: 'live', streamName: 'ai' }] as never;
  const processor = { id: 'processor', config: { inference_fps: 10, analytics: { enabled: true },
    stream: { url: 'rtmp://127.0.0.1/live/raw' }, publish: { enabled: true, target_url: 'rtmp://127.0.0.1/live/ai' } } };
  const implicit = buildSearchSourceCatalog(channels, [processor]);
  const explicit = buildSearchSourceCatalog(channels, [{ ...processor, config: { ...processor.config, snapshot: { projection_mode: 'none' } } }]);
  expect(implicit.sources).toEqual(explicit.sources);
  expect(implicit.channels).toEqual(explicit.channels);
  const erp = buildSearchSourceCatalog(channels, [{ ...processor, config: { ...processor.config, snapshot: { projection_mode: 'erp_equirect' } } }]);
  expect(erp.identities).not.toEqual(explicit.identities);
  const f = fixture(); f.sourceCatalog.mockResolvedValue(explicit);
  const first = await readEffectiveSearchConfiguration(f.dependencies);
  f.sourceCatalog.mockResolvedValue(erp);
  const changed = await readEffectiveSearchConfiguration(f.dependencies);
  expect(changed.revision).not.toBe(first.revision);
  expect(changed.sources.map(source => source.channel_id)).toEqual(first.sources.map(source => source.channel_id));
  expect(changed.dependency_status).toBeNull();
});

it('operational finalization pauses producer credentials without changing definition revision or old query access',async()=>{
 const f=fixture();f.config.enabled=true;
 const model={package_id:f.config.model.package_id!,package_sha256:'a'.repeat(64),model_version:`search-v1-${'a'.repeat(64)}`};
 let gate:any=null;const ingestionGate=vi.fn(async()=>({gate})),deps={...f.dependencies,modelAuthority:async()=>({active_model_pin:model,approved_model_transition:null}),ingestionGate};
 const baseline=await readEffectiveSearchConfiguration(deps),revision=baseline.revision;
 const runtime={read:async()=>({desired_version:2,revision,status:'applied' as const,error_code:null}),acknowledge:async()=>true};
 const app=Fastify();await app.register(searchRuntimeRoutes,{dependencies:deps,runtime,internalPrincipal:async()=>true,producerPrincipal:async()=>true,principal:async()=>null,managementConnection:async()=>null});
 try{
 const active=(await app.inject({url:'/internal/search/producer-config'})).json();expect(active.enabled).toBe(true);
 gate={paused:true,plan_id:output,epoch:input,generation:3,worker:input,source:model,source_ids_sha256:'b'.repeat(64),expires_ms:Date.now()+20000};
 const paused=await readEffectiveSearchConfiguration(deps);expect(paused.revision).toBe(revision);expect(paused.ingestion_gate).toEqual(gate);
 expect(ingestionGate).toHaveBeenCalledWith({revision,source_ids:[output],active_model:model,approved_transition:null});
 expect((await app.inject({url:'/internal/search/producer-config'})).json()).toEqual({enabled:false,reason:'config_pending',endpoint:null,api_token:null,revision:null,model:{package_id:null},sampling:null,sources:[],valid_for_ms:0,limits:null});
 expect(await readAppliedSearchConnection(deps,runtime)).not.toBeNull();
 expect((await app.inject({url:'/internal/search/runtime-config'})).json().ingestion_gate).toEqual(gate);
 gate=null;expect((await readEffectiveSearchConfiguration(deps)).revision).toBe(revision);
 expect((await app.inject({url:'/internal/search/producer-config'})).json().enabled).toBe(true);
 }finally{await app.close();}
});
it('an unavailable operational gate authority fails closed instead of issuing sampling keys',async()=>{
 const f=fixture();f.config.enabled=true;
 await expect(readEffectiveSearchConfiguration({...f.dependencies,ingestionGate:async()=>{throw new Error('private_pg_detail');}})).rejects.toThrow('config_pending');
});

describe('configuration-administrator search capacity', () => {
  const capacity = { samples: 2, bytes: 5000, max_samples: 1000, max_bytes: 100000, retention_days: 30, coverage: 10, max_coverage: 1000 };
  async function appFor(body: unknown = capacity, status = 200) {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    const app = Fastify(); await app.register(searchRuntimeRoutes, { dependencies: null, runtime: null,
      principal: async req => typeof req.headers['x-test-principal'] === 'string' ? req.headers['x-test-principal'] : null,
      internalPrincipal: async () => false, producerPrincipal: async () => false,
      managementConnection: async () => ({ baseUrl: 'http://127.0.0.1:8400', apiToken: 'x'.repeat(48), timeoutMs: 1000 }), fetchImpl });
    return { app, fetchImpl };
  }
  it('passes the rolling-retention fields through and still accepts a service that does not report them', async () => {
    const rolling = { ...capacity, evicted_samples: 12, evicted_bytes: 123456, eviction_runs: 2, rolling_min_age_ms: 600000, oldest_retained_captured_ms: 1793250000000 };
    const { app } = await appFor(rolling);
    try {
      const res = await app.inject({ url: '/v1/config/search-capacity', headers: { 'x-test-principal': 'console-administrator' } });
      expect(res.statusCode).toBe(200); expect(res.json()).toEqual(rolling);
    } finally { await app.close(); }
    const empty = await appFor({ ...capacity, evicted_samples: 0, evicted_bytes: 0, eviction_runs: 0, rolling_min_age_ms: 600000, oldest_retained_captured_ms: null });
    try {
      const res = await empty.app.inject({ url: '/v1/config/search-capacity', headers: { 'x-test-principal': 'console-administrator' } });
      expect(res.statusCode).toBe(200); expect(res.json().oldest_retained_captured_ms).toBeNull();
    } finally { await empty.app.close(); }
  });
  it('rejects anonymous, search users and service tokens before reading global device usage', async () => {
    const { app, fetchImpl } = await appFor();
    try {
      for (const principal of [null, 'operator', 'search-service', 'producer']) {
        const res = await app.inject({ url: '/v1/config/search-capacity', headers: principal ? { 'x-test-principal': principal } : {} });
        expect(res.statusCode).toBe(403);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
      const res = await app.inject({ url: '/v1/config/search-capacity', headers: { 'x-test-principal': 'console-administrator' } });
      expect(res.statusCode).toBe(200); expect(res.json()).toEqual(capacity); expect(res.headers['cache-control']).toBe('no-store');
      expect(String(fetchImpl.mock.calls[0]![0])).toBe('http://127.0.0.1:8400/v1/capacity');
    } finally { await app.close(); }
  });
  it.each([{ ...capacity, bytes: -1 }, { ...capacity, samples: Number.MAX_SAFE_INTEGER + 1 }, { ...capacity, token: 'never-forward' }])('refuses invalid capacity without exposing native data', async body => {
    const { app } = await appFor(body);
    try { const res = await app.inject({ url: '/v1/config/search-capacity', headers: { 'x-test-principal': 'console-administrator' } });
      expect(res.statusCode).toBe(503); expect(res.body).not.toContain('never-forward');
    } finally { await app.close(); }
  });
});
