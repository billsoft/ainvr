import { create } from 'zustand'
import { systemService, type AiServiceSettingsSafe } from '@/api/systemService'
import type { AppSettings } from '@/types/channel'

export type SettingsData = Omit<AppSettings, 'adminPasswordHash' | 'aiService'> & {
  adminPasswordSet: boolean
  aiService: AiServiceSettingsSafe
}

interface SettingsState {
  settings: SettingsData | null
  loading: boolean
  fetchSettings: () => Promise<void>
  /** 清缓存并重新拉取——设置页保存成功后必须调用这个，否则 Topbar/
   * Dashboard/About/Monitor 这些同一 SPA 会话里更早挂载、已经缓存过
   * settings 的组件永远看不到新值（除非用户手动刷新整个页面）。
   * 这个 bug 此前真实存在：monitorSoftLimit/monitorHardLimit/pollIntervalMs
   * "保存成功"但同会话内全局不生效。 */
  invalidate: () => Promise<void>
}

// 模块级 in-flight Promise：多个页面各自的 useEffect 触发时去重，
// 避免同一时刻打多次 GET /api/settings。
let inflight: Promise<void> | null = null

async function doFetch(set: (partial: Partial<SettingsState>) => void) {
  set({ loading: true })
  inflight = (async () => {
    try {
      const data = await systemService.getSettings()
      set({ settings: data, loading: false })
    } catch {
      // 静默失败，settings 保持 null，消费方退回各自的硬编码默认值。
      // 刻意设计：现有页面测试没有 mock systemService，这里 throw 或反复重试
      // 会让页面渲染挂起或报错。
      set({ loading: false })
    } finally {
      inflight = null
    }
  })()
  await inflight
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loading: false,

  async fetchSettings() {
    if (get().settings || inflight) {
      if (inflight) await inflight
      return
    }
    await doFetch(set)
  },

  async invalidate() {
    if (inflight) await inflight
    // ⚠️ 不在这里先 set({ settings: null })——doFetch 失败时只会
    // set({ loading: false })，不touch settings，所以"失败时保留调用前的
    // 旧值"完全取决于调用前 settings 是什么。之前这里会先清空成 null，
    // 若这次重新拉取又失败（网络抖动），消费方（Topbar/Dashboard/About/
    // Monitor）会从"看到旧的但正确的设置"变成"看到 null 退回硬编码默认值"
    // ——比不调用 invalidate() 还糟，是审计发现 P1-4 的真正成因。
    // doFetch 本身的"进 inflight 前不清空"已经足够表达"正在刷新"，
    // 不需要在这里额外制造一个空窗期。
    await doFetch(set)
  },
}))
