// BackendConfigAdapter 单元测试（不需要 PG）：
// 重点验证 2026-09-16 评审修复——经配置中心发布的 backend/system/settings
// 里 srsApiHost 变化时必须热切换 SrsClient，不能等重启。
import { describe, it, expect, vi } from 'vitest';
import { BackendConfigAdapter } from '../store/backendAdapter.js';
import { DEFAULT_SETTINGS, type AppSettings } from '../types/channel.js';

function makeSettingsStore(initial: AppSettings) {
  let current = structuredClone(initial);
  return {
    current: () => current,
    store: {
      read: vi.fn(async () => current),
      setCache: vi.fn((s: AppSettings) => {
        current = structuredClone(s);
      }),
    },
  };
}

function settingsDoc(over: Partial<AppSettings>) {
  return [{
    service: 'backend',
    group: 'system',
    name: 'settings',
    config: { ...structuredClone(DEFAULT_SETTINGS), ...over },
  }] as any;
}

describe('BackendConfigAdapter — srsApiHost 热切换', () => {
  it('srsApiHost 变化：setApiHost 被调用并 setCache 新设置', async () => {
    const { store } = makeSettingsStore(DEFAULT_SETTINGS);
    const srsClient = { setApiHost: vi.fn() };
    const adapter = new BackendConfigAdapter(store as any, srsClient);

    const result = await adapter.apply(settingsDoc({ srsApiHost: '10.0.0.9:1985' }), 7);

    expect(result.ok).toBe(true);
    expect(result.applyVia).toBe('hot');
    expect(srsClient.setApiHost).toHaveBeenCalledTimes(1);
    expect(srsClient.setApiHost).toHaveBeenCalledWith('10.0.0.9:1985');
    expect(store.setCache).toHaveBeenCalledTimes(1);
    expect(store.setCache.mock.calls[0]![0].srsApiHost).toBe('10.0.0.9:1985');
  });

  it('srsApiHost 未变化：不重复调用 setApiHost（避免无谓清缓存）', async () => {
    const { store } = makeSettingsStore(DEFAULT_SETTINGS);
    const srsClient = { setApiHost: vi.fn() };
    const adapter = new BackendConfigAdapter(store as any, srsClient);

    const result = await adapter.apply(settingsDoc({ srsApiHost: DEFAULT_SETTINGS.srsApiHost }), 8);

    expect(result.ok).toBe(true);
    expect(srsClient.setApiHost).not.toHaveBeenCalled();
    expect(store.setCache).toHaveBeenCalledTimes(1);
  });

  it('未注入 srsClient：不报错，setCache 照常（旧构造方式兼容）', async () => {
    const { store } = makeSettingsStore(DEFAULT_SETTINGS);
    const adapter = new BackendConfigAdapter(store as any);

    const result = await adapter.apply(settingsDoc({ srsApiHost: '10.0.0.9:1985' }), 9);

    expect(result.ok).toBe(true);
    expect(store.setCache).toHaveBeenCalledTimes(1);
  });

  it('未注入 settingsStore：不触达运行时，仍返回 hot 成功（防御构造）', async () => {
    const srsClient = { setApiHost: vi.fn() };
    const adapter = new BackendConfigAdapter(undefined, srsClient);

    const result = await adapter.apply(settingsDoc({ srsApiHost: '10.0.0.9:1985' }), 11);

    expect(result.ok).toBe(true);
    expect(result.applyVia).toBe('hot');
    expect(srsClient.setApiHost).not.toHaveBeenCalled();
  });

  it('非法 settings：rejected，setApiHost/setCache 都不调用', async () => {
    const { store } = makeSettingsStore(DEFAULT_SETTINGS);
    const srsClient = { setApiHost: vi.fn() };
    const adapter = new BackendConfigAdapter(store as any, srsClient);

    const result = await adapter.apply(
      [{ service: 'backend', group: 'system', name: 'settings', config: { srsApiHost: 'x' } }] as any,
      10,
    );

    expect(result.ok).toBe(false);
    expect(result.applyVia).toBe('rejected');
    expect(srsClient.setApiHost).not.toHaveBeenCalled();
    expect(store.setCache).not.toHaveBeenCalled();
  });
});
