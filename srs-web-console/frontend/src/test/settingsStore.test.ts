import { vi } from 'vitest'

vi.mock('@/api/systemService', () => ({
  systemService: {
    getSettings: vi.fn(),
  },
}))

import { systemService } from '@/api/systemService'
import { useSettingsStore } from '@/store/settings'

function resetStore() {
  useSettingsStore.setState({ settings: null, loading: false })
}

describe('settings store（全局单次缓存 + invalidate 刷新）', () => {
  beforeEach(() => {
    resetStore()
    vi.mocked(systemService.getSettings).mockReset()
  })

  it('fetchSettings 命中缓存后重复调用不再重复请求', async () => {
    vi.mocked(systemService.getSettings).mockResolvedValue({
      pollIntervalMs: 5000,
    } as any)

    await useSettingsStore.getState().fetchSettings()
    await useSettingsStore.getState().fetchSettings()
    await useSettingsStore.getState().fetchSettings()

    expect(systemService.getSettings).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().settings?.pollIntervalMs).toBe(5000)
  })

  it('invalidate 清缓存并重新拉取——回归"设置保存成功但同会话内全局不生效"的 bug', async () => {
    vi.mocked(systemService.getSettings)
      .mockResolvedValueOnce({ pollIntervalMs: 5000 } as any)
      .mockResolvedValueOnce({ pollIntervalMs: 9000 } as any)

    await useSettingsStore.getState().fetchSettings()
    expect(useSettingsStore.getState().settings?.pollIntervalMs).toBe(5000)

    await useSettingsStore.getState().invalidate()
    expect(useSettingsStore.getState().settings?.pollIntervalMs).toBe(9000)
    expect(systemService.getSettings).toHaveBeenCalledTimes(2)
  })

  it('回归：invalidate 重新拉取失败时保留旧值，不清空成 null（审计发现 P1-4）', async () => {
    vi.mocked(systemService.getSettings)
      .mockResolvedValueOnce({ pollIntervalMs: 5000 } as any)
      .mockRejectedValueOnce(new Error('网络抖动'))

    await useSettingsStore.getState().fetchSettings()
    expect(useSettingsStore.getState().settings?.pollIntervalMs).toBe(5000)

    await useSettingsStore.getState().invalidate() // 这次重新拉取失败
    // 此前会在拉取前先清空成 null，失败后其它页面读到的是 null 退回硬编码
    // 默认值——比不调用 invalidate 还糟。现在必须保留失败前的旧值。
    expect(useSettingsStore.getState().settings?.pollIntervalMs).toBe(5000)
  })

  it('invalidate 之后 fetchSettings 命中的是新缓存，不会退回旧值', async () => {
    vi.mocked(systemService.getSettings)
      .mockResolvedValueOnce({ pollIntervalMs: 5000 } as any)
      .mockResolvedValueOnce({ pollIntervalMs: 9000 } as any)

    await useSettingsStore.getState().fetchSettings()
    await useSettingsStore.getState().invalidate()
    await useSettingsStore.getState().fetchSettings() // 应该命中新缓存，不再请求第 3 次

    expect(systemService.getSettings).toHaveBeenCalledTimes(2)
    expect(useSettingsStore.getState().settings?.pollIntervalMs).toBe(9000)
  })
})
