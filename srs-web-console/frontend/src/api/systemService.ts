import type { AppSettings } from '@/types/channel'
import { request } from './httpClient'

interface SummaryResponse {
  code: number
  data: {
    srsOnline: boolean
    srsVersion: string
    /** srsVersion 是否来自 SRS 实时查询（false = 读不到 SRS，显示的是设置里的值） */
    srsVersionLive?: boolean
    /** SRS ≥ 7.0.33：能把 RTMP 的 H.265 转成 WebRTC */
    srsRtcHevc?: boolean
    serverTime: number
    streams: {
      total: number
      online: number
      totalClients: number
      totalBitrateKbps: number
    }
    channels: {
      total: number
      online: number
      offline: number
    }
  }
}

/** aiService 的回显形态——apiKey 不回显明文，只回显"设没设"（同 adminPasswordHash 模式） */
export interface AiServiceSettingsSafe {
  baseUrl: string
  pollIntervalMs: number
  aiApiKeySet: boolean
}

type SettingsData = Omit<AppSettings, 'adminPasswordHash' | 'aiService'> & {
  adminPasswordSet: boolean
  aiService: AiServiceSettingsSafe
}

interface SettingsResponse {
  code: number
  data: SettingsData
}

/**
 * 系统服务：运行汇总、只读设置回显、AI 连接测试与改密码
 * （参数修改已全部改走配置中心配置文档 + 发布流程）
 */
export const systemService = {
  /** 获取汇总数据（顶栏 + 仪表盘用） */
  async getSummary(): Promise<SummaryResponse['data']> {
    const body = await request<SummaryResponse>('/summary')
    return body.data
  },

  /** 获取设置 */
  async getSettings(): Promise<SettingsResponse['data']> {
    const body = await request<SettingsResponse>('/settings')
    return body.data
  },

  /** 测试 AI 微服务连通性。candidate 不传则测已保存的 settings.aiService；
   * 传了则测这组候选值（向导里"先测后存"场景，不要求先保存才能测）。 */
  async testAiConnection(candidate?: { baseUrl?: string; apiKey?: string }): Promise<{
    ok: boolean
    reason?: 'unauthorized' | 'unreachable' | 'timeout' | 'error'
    message?: string
    health?: unknown
  }> {
    const body = await request<{ code: number; data: {
      ok: boolean
      reason?: 'unauthorized' | 'unreachable' | 'timeout' | 'error'
      message?: string
      health?: unknown
    } }>('/ai-test-connection', {
      method: 'POST',
      body: JSON.stringify(candidate ?? {}),
    })
    return body.data
  },

  /** 修改密码 */
  async changePassword(password: string, oldPassword?: string): Promise<{ adminPasswordSet: boolean }> {
    const res = await request<{ code: number; data: { adminPasswordSet: boolean } }>(
      '/settings/password',
      { method: 'PUT', body: JSON.stringify({ password, oldPassword }) },
    )
    return res.data
  },
}
