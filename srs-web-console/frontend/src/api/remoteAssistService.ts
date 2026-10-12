import { request } from './httpClient'

/**
 * 远程协助 API。字段与 shared/os-helper/remote_assist.py 逐字段对齐，
 * BFF（routes/remoteAssist.ts）只透传；改字段三方同步。
 */
export type RemoteAssistState = 'disabled' | 'connecting' | 'connected' | 'error' | 'unavailable' | 'stopping' | 'unknown' | 'suspended'

export interface RemoteAssistStatus {
  installed: boolean
  /** 开关意图：开启后长期生效（设备重启后自动恢复），直到在页面关闭；查询失败为 null */
  enabled: boolean | null
  /** 连接程序实际是否在运行（与开关意图分开）；查询失败为 null */
  running: boolean | null
  state: RemoteAssistState
  /** 中文说明（失败原因、未安装等），无则为 null */
  message: string | null
  server: { host: string; port: number } | null
  /** 出厂是否已写入接入凭据（内容永不返回） */
  credentials: boolean
  /** 本机远程登录端口上的回环连接数；不代表已通过身份验证，不是登录审计 */
  sessions: number
  /** 本次开启时间（毫秒），关闭时为 null */
  enabled_at: number | null
  /** 本机授权机器码（去横杠大写），技术支持在中转管理页面据此找到本设备；尚未读到为 null */
  machine_code?: string | null
}

export interface RemoteAssistEvent {
  ts: number
  type: 'enabled' | 'disabled' | 'server_changed' | 'session_started' | 'session_ended'
  actor: string | null
  detail: string | null
}

export interface RemoteAssistTestResult { ok: boolean; latency_ms: number | null; message: string }

export const remoteAssistService = {
  async getStatus(): Promise<RemoteAssistStatus> {
    return (await request<{ code: number; data: RemoteAssistStatus }>('/remote-assist')).data
  },
  async listEvents(limit = 50): Promise<RemoteAssistEvent[]> {
    return (await request<{ code: number; data: RemoteAssistEvent[] }>(`/remote-assist/events?limit=${limit}`)).data
  },
  async enable(): Promise<void> {
    await request('/remote-assist/enable', { method: 'POST' })
  },
  async disable(): Promise<void> {
    await request('/remote-assist/disable', { method: 'POST' })
  },
  /** 修改中转服务器：需管理员密码再次验证，开启期间会被拒绝 */
  async updateServer(host: string, port: number, password: string): Promise<{ host: string; port: number }> {
    const res = await request<{ code: number; data: { host: string; port: number } }>('/remote-assist/server', {
      method: 'PUT', body: JSON.stringify({ host, port, password }),
    })
    return res.data
  },
  /** 检测当前已保存的中转服务器能否连通，不会开启远程协助 */
  async test(): Promise<RemoteAssistTestResult> {
    return (await request<{ code: number; data: RemoteAssistTestResult }>('/remote-assist/test', { method: 'POST' })).data
  },
}
