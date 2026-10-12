import type { AppSettings } from '@/types/channel'

const API_BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body.error) msg = body.error
    } catch {
      // ignore
    }
    const err = new Error(msg) as Error & { status: number }
    err.status = res.status
    throw err
  }
  return res.json() as Promise<T>
}

interface SettingsResponse {
  code: number
  data: AppSettings
}

/**
 * 设置服务：读写系统配置
 * 失败时抛错（不吞默认值），避免 BFF 短暂不可达时默认值覆盖真实配置
 */
export const settingsService = {
  async get(): Promise<AppSettings> {
    const body = await request<SettingsResponse>('/settings')
    return body.data
  },

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const body = await request<SettingsResponse>('/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    return body.data
  },
}

/** 默认设置值（仅用于初始展示占位，不参与保存链路） */
export const DEFAULT_SETTINGS: AppSettings = {
  srsApiHost: '127.0.0.1:1985',
  srsRtmpHost: '',
  srsHttpHost: '',
  srsRtcHost: '',
  srsSrtHost: '',
  monitorSoftLimit: 6,
  monitorHardLimit: 9,
  pollIntervalMs: 5000,
}
