import { request } from './httpClient'

/** 与 os-helper systime.status() 逐字段对齐（BFF 只透传） */
export interface SystemTimeStatus {
  epoch_ms: number
  timezone: string
  ntp_enabled: boolean
  /** 本次开机后已与时间服务器同步 */
  ntp_synchronized: boolean
  /** 本次开机后已人工校准 */
  manually_set: boolean
  /** 不早于 2026-01-01；否则授权报时钟错误、录像与 AI 暂停 */
  valid: boolean
  min_valid_epoch_ms: number
  ntp_servers: string[]
}

interface Resp<T> { code: number; data: T }

/** 校时成功后通知全局提示条立即刷新 */
export const SYSTEM_TIME_CHANGED_EVENT = 'ainvr:system-time-changed'

export const systemTimeService = {
  async get(): Promise<SystemTimeStatus> {
    return (await request<Resp<SystemTimeStatus>>('/system-time')).data
  },
  /** 设好后设备会自动重启录像与 AI；restarted 为重启的服务名 */
  async setTime(epochMs: number): Promise<SystemTimeStatus & { restarted: string[] }> {
    return (await request<Resp<SystemTimeStatus & { restarted: string[] }>>('/system-time', {
      method: 'PUT', body: JSON.stringify({ epochMs }),
    })).data
  },
  /** 空数组 = 恢复默认（互联网时间服务器） */
  async setNtpServers(servers: string[]): Promise<SystemTimeStatus> {
    return (await request<Resp<SystemTimeStatus>>('/system-time/ntp-servers', {
      method: 'PUT', body: JSON.stringify({ servers }),
    })).data
  },
}
