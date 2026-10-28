import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { DEFAULT_SEARCH_SETTINGS, prepareSearchSettings } from '../store/searchConfigAdapter.js';
import { readAppliedSearchConnection, readEffectiveSearchConfiguration, resolveSearchIndexDirectory } from '../services/searchConnection.js';
import { buildSearchSourceCatalog } from '../services/searchSourceCatalog.js';
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
  const sourceCatalog = vi.fn(async () => ({ sources: [{ channel_id: output, input_stream_id: input,
    processor_id: 'processor-1', input_path: '/live/raw', output_path: '/live/ai', recording_channel_id: output, object: true, scene: true }],
  channels: [{ id: output, name: 'AI output' }], identities: ['stable'] }));
  return { dependencies: { store: store as never, volumes, sourceCatalog }, config, store, versions, volumes, sourceCatalog };
}
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
  it('migration defaults equal the frozen settings and do not alter other desired service versions', () => {
    const sql = readFileSync(new URL('../store/migrations/018_search_runtime.sql', import.meta.url), 'utf8');
    const json = /VALUES\('search-service','system','settings','([\s\S]*?)'::jsonb/.exec(sql)![1];
    expect(JSON.parse(json)).toEqual(DEFAULT_SEARCH_SETTINGS);
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
  expect(active.channels).toEqual([{ id: output, name: 'AI' }]);
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
    expect(catalog.channels).toEqual([{ id: output, name: 'Valid AI' }]);
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
