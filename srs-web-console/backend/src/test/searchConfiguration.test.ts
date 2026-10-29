import { describe, expect, it } from 'vitest';
import { DEFAULT_SEARCH_SETTINGS, prepareSearchSettings, searchSettingsSchema, SearchConfigAdapter } from '../store/searchConfigAdapter.js';
import { sanitizeImportDocSecrets, resolveSecretRefs } from '../routes/configPolicy.js';
import { loadServiceTokens, resolveServiceByToken } from '../services/serviceTokens.js';
import { isConfigService } from '../store/services.js';

const defaults = () => structuredClone(DEFAULT_SEARCH_SETTINGS);
describe('search configuration shares the existing parameter-store contract', () => {
  it('registers its configuration token without granting any other service identity', () => {
    expect(isConfigService('search-service')).toBe(true);
    const tokens = loadServiceTokens({ CONFIG_SERVICE_TOKEN_SEARCH_SERVICE: 'test-search-token' });
    expect(resolveServiceByToken(tokens, 'test-search-token')).toBe('search-service');
    expect(resolveServiceByToken(tokens, 'missing')).toBeUndefined();
    expect(() => loadServiceTokens({ CONFIG_SERVICE_TOKEN_AI_SERVICE: 'same-private-value',
      CONFIG_SERVICE_TOKEN_SEARCH_SERVICE: 'same-private-value' })).toThrow('distinct credential');
    try { loadServiceTokens({ CONFIG_SERVICE_TOKEN_AI_SERVICE: 'same-private-value',
      CONFIG_SERVICE_TOKEN_SEARCH_SERVICE: 'same-private-value' }); }
    catch (error) { expect(String(error)).not.toContain('same-private-value'); }
  });
  it('is disabled and resource bounded before models or historical storage exist', async () => {
    expect(searchSettingsSchema.parse(defaults()).enabled).toBe(false);
    expect(defaults().model.package_id).toBe('siglip2-base-full-int8');
    expect((await new SearchConfigAdapter().validate([{ group: 'system', name: 'settings', config: defaults() }] as never)).ok).toBe(true);
    for (const overrides of [{ enabled: true }, { listen: { host: '0.0.0.0', port: 8400 } },
      { limits: { ...defaults().limits, producer_bytes: 2 ** 40 } },
      { index_storage: { volume_id: 'disk', relative_path: '../system' } },
      { history: { source: 'ai-history', mongo_uri: 'mongodb://secret' } },
      { model: { package_id: '/tmp/not-a-package' } }])
      expect(searchSettingsSchema.safeParse({ ...defaults(), ...overrides }).success).toBe(false);
  });
  it('rejects ambiguous selection, intervals, and mixed caller scopes', () => {
    const a = defaults(); a.sampling.mode = 'selected';
    expect(searchSettingsSchema.safeParse(a).success).toBe(false);
    const b = defaults(); b.sampling.channel_ids = ['4f2bda2a-fb2a-4800-84ef-19a63ab02df7'];
    expect(searchSettingsSchema.safeParse(b).success).toBe(false);
    const c = defaults(); c.sampling.scene_static_interval_ms = 1000;
    expect(searchSettingsSchema.safeParse(c).success).toBe(false);
    const d = prepareSearchSettings(defaults()); d.callers[0].scope = 'producer';
    expect(searchSettingsSchema.safeParse(d).success).toBe(false);
    d.callers[0].scope = 'console'; d.callers[1].key = d.callers[0].key;
    expect(searchSettingsSchema.safeParse(d).success).toBe(false);
  });
  it('preserves explicitly selected so400m and empty models instead of applying the new default', () => {
    for (const package_id of ['siglip-so400m-i18n-full-int8', null]) {
      const selected = { ...defaults(), model: { package_id } };
      expect(prepareSearchSettings(selected).model.package_id).toBe(package_id);
      expect(prepareSearchSettings(selected).enabled).toBe(false);
    }
  });
  it('provisions only at explicit save and preserves versioned references on later edits', async () => {
    const first = prepareSearchSettings(defaults());
    expect(first.callers.map(c => c.name)).toEqual(['console', 'producer']);
    expect(first.callers[0].key).not.toBe(first.callers[1].key);
    const saved = new Map<string, string>();
    const store = { setSecret: async (name: string, value: string) => { saved.set(name, value); } };
    const safe = await sanitizeImportDocSecrets('search-service', first, store as never, 'operator');
    expect(saved.size).toBe(2);
    expect(JSON.stringify(safe)).not.toContain(first.callers[0].key);
    const second = prepareSearchSettings({ ...safe, callers: [] }, safe);
    expect(second.callers).toEqual(safe.callers);
    expect(await sanitizeImportDocSecrets('search-service', second, store as never, 'operator')).toEqual(safe);
    expect(saved.size).toBe(2);
  });
  it('does not weaken the cross-service secret boundary for history reuse', async () => {
    const node = { uri: '${secret:ai-service/snapshot_store.mongo_uri}' };
    let reads = 0;
    await resolveSecretRefs(node, 'search-service', async () => { ++reads; return 'private'; });
    expect(node.uri).toBeNull(); expect(reads).toBe(0);
  });
  it('new historical database drafts cannot mutate the URI referenced by an applied snapshot', async () => {
    const secrets = new Map<string, string>([['ai-service/snapshot_store.mongo_uri', 'mongodb://legacy-applied/db']]);
    const store = { setSecret: async (name: string, value: string) => { secrets.set(name, value); } };
    const oldSnapshot = { snapshot_store: { mongo_uri: '${secret:ai-service/snapshot_store.mongo_uri}' } };
    const next = await sanitizeImportDocSecrets('ai-service', { snapshot_store: { mongo_uri: 'mongodb://new-draft/db' } }, store as never, 'admin');
    expect(next.snapshot_store).not.toEqual(oldSnapshot.snapshot_store);
    await resolveSecretRefs(oldSnapshot, 'ai-service', async name => secrets.get(name) ?? null);
    expect(oldSnapshot.snapshot_store.mongo_uri).toBe('mongodb://legacy-applied/db');
    await resolveSecretRefs(next, 'ai-service', async name => secrets.get(name) ?? null);
    expect(next.snapshot_store).toEqual({ mongo_uri: 'mongodb://new-draft/db' });
  });
});
