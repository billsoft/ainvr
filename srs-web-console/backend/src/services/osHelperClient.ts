/**
 * OS Helper 客户端 — 调宿主机上的 ainvr-os-helper.service（端口 8299）
 *
 * 统一系统操作入口：网络管理 + 重启 + 关机 + 资源采集
 * 鉴权：Bearer Token（环境变量 OS_HELPER_TOKEN）
 */

export interface OsHelperConfig {
  baseUrl: string
  token: string
}

export function osHelperConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OsHelperConfig | null {
  const baseUrl = (env.OS_HELPER_URL || '').trim()
  const token = (env.OS_HELPER_TOKEN || '').trim()
  if (!baseUrl || !token) return null
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token }
}

const REQUEST_TIMEOUT_MS = 10_000
const WRITE_TIMEOUT_MS = 30_000

// =========================== 类型 ===========================

export interface NetIface {
  name: string
  kind: 'ethernet' | 'wifi' | 'bridge'
  state: string
  connected: boolean
  carrier: boolean
  connection: string | null
  system: boolean
  mac: string | null
  mtu: number | null
  ipv4: {
    method: string
    addresses: string[]
    gateway: string | null
    dns: string[]
  }
  ipv6: {
    method: string
    addresses: string[]
    gateway: string | null
    dns: string[]
  }
}

export interface PendingChange {
  /** 本次变更唯一 ID：确认时带回，防止误确认另一次变更（旧版 os-helper 无此字段） */
  id?: string
  iface: string
  state: 'applying' | 'waiting_confirm'
  remaining: number
}

export interface WifiAp {
  ssid: string
  bssid: string
  mode: string
  channel: number | null
  rate: string
  signal: number
  security: string
  active: boolean
}

export interface FallbackInfo {
  interface: string
  address: string
  prefix: number
  reachable: boolean
}

export interface ConnectivityResult {
  iface: string
  gateway: { ok: boolean; latency: number | null }
  internet_v4: { ok: boolean; latency: number | null }
  internet_v6: { ok: boolean; latency: number | null }
  dns: { ok: boolean; latency: number | null }
}

export interface IpConfigInput {
  ipv4: {
    method: 'auto' | 'manual' | 'disabled' | 'link-local'
    address?: string
    netmask?: string
    gateway?: string
    dns?: string[]
  }
  ipv6: {
    method: 'auto' | 'manual' | 'disabled' | 'link-local'
    address?: string
    netmask?: string
    gateway?: string
    dns?: string[]
  }
  rollback_seconds?: number
}

// =========================== 基础请求 ===========================

async function request(
  config: OsHelperConfig,
  path: string,
  options: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 只在真的带 body 时发 Content-Type（GET/无 body POST 不带，和前端
    // httpClient 同一原则；os-helper 虽是自建服务不挑头，保持规范一致）
    const hasBody = options.body !== undefined
    const resp = await fetchImpl(`${config.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    })
    const body = await resp.json().catch(() => ({})) as { error?: string; ok?: boolean }
    if (!resp.ok) {
      throw Object.assign(new Error(body.error || `os-helper 返回 ${resp.status}`),
        { status: resp.status, helperMessage: typeof body.error === 'string' ? body.error : undefined })
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

// =========================== 读操作 ===========================

export async function listInterfaces(
  config: OsHelperConfig,
  includeSystem = false,
  fetchImpl: typeof fetch = fetch,
): Promise<NetIface[]> {
  const data = await request(config, `/network/interfaces?all=${includeSystem}`, {}, REQUEST_TIMEOUT_MS, fetchImpl)
  return data.interfaces || []
}

export async function getPendingChange(
  config: OsHelperConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PendingChange | null> {
  const data = await request(config, '/network/pending', {}, REQUEST_TIMEOUT_MS, fetchImpl)
  return data.pending || null
}

export async function getFallback(
  config: OsHelperConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<FallbackInfo | null> {
  const data = await request(config, '/network/fallback', {}, REQUEST_TIMEOUT_MS, fetchImpl)
  return data.fallback || null
}

export async function scanWifi(
  config: OsHelperConfig,
  iface: string,
  rescan = true,
  fetchImpl: typeof fetch = fetch,
): Promise<WifiAp[]> {
  const data = await request(
    config, `/network/wifi/${encodeURIComponent(iface)}/scan?rescan=${rescan}`,
    {}, REQUEST_TIMEOUT_MS, fetchImpl,
  )
  return data.access_points || []
}

export async function testConnectivity(
  config: OsHelperConfig,
  iface: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectivityResult> {
  return request(config, `/network/interfaces/${encodeURIComponent(iface)}/test`, {}, REQUEST_TIMEOUT_MS, fetchImpl)
}

// =========================== 写操作 ===========================

export async function applyIpConfig(
  config: OsHelperConfig,
  iface: string,
  ipConfig: IpConfigInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ rollback_seconds: number }> {
  return request(
    config,
    `/network/interfaces/${encodeURIComponent(iface)}/config`,
    { method: 'PUT', body: JSON.stringify(ipConfig) },
    WRITE_TIMEOUT_MS,
    fetchImpl,
  )
}

export async function confirmChange(
  config: OsHelperConfig,
  changeId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const options: RequestInit = changeId === undefined
    ? { method: 'POST' }
    : { method: 'POST', body: JSON.stringify({ id: changeId }) }
  await request(config, '/network/confirm', options, WRITE_TIMEOUT_MS, fetchImpl)
}

export async function revertChange(config: OsHelperConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
  await request(config, '/network/revert', { method: 'POST' }, WRITE_TIMEOUT_MS, fetchImpl)
}

/** os-helper systime.status()：设备时间、对时状态与局域网对时服务器 */
export interface SystemTimeStatus {
  epoch_ms: number
  timezone: string
  ntp_enabled: boolean
  /** 本次开机后已与对时服务器同步 */
  ntp_synchronized: boolean
  /** 本次开机后已人工校时 */
  manually_set: boolean
  /** 不早于可信下限（2026-01-01）；否则授权报时钟错误、业务暂停 */
  valid: boolean
  min_valid_epoch_ms: number
  ntp_servers: string[]
}

export async function getSystemTime(config: OsHelperConfig, fetchImpl: typeof fetch = fetch): Promise<SystemTimeStatus> {
  const data = await request(config, '/system/time', {}, REQUEST_TIMEOUT_MS, fetchImpl)
  return data.time
}

/** 手动校时；os-helper 设好后自动重启录像与 AI，restarted 为重启的服务名 */
export async function setSystemTime(
  config: OsHelperConfig,
  epochMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SystemTimeStatus & { restarted: string[] }> {
  const data = await request(config, '/system/time',
    { method: 'PUT', body: JSON.stringify({ epoch_ms: epochMs }) }, WRITE_TIMEOUT_MS, fetchImpl)
  return { ...data.time, restarted: data.restarted ?? [] }
}

export async function setNtpServers(
  config: OsHelperConfig,
  servers: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<SystemTimeStatus> {
  const data = await request(config, '/system/ntp',
    { method: 'PUT', body: JSON.stringify({ servers }) }, WRITE_TIMEOUT_MS, fetchImpl)
  return data.time
}

export async function wifiConnect(
  config: OsHelperConfig,
  iface: string,
  ssid: string,
  password?: string,
  hidden = false,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await request(
    config,
    `/network/wifi/${encodeURIComponent(iface)}/connect`,
    { method: 'POST', body: JSON.stringify({ ssid, password, hidden }) },
    WRITE_TIMEOUT_MS,
    fetchImpl,
  )
}

// =========================== 远程协助 ===========================
// 字段与 shared/os-helper/remote_assist.py 逐字段对齐，BFF 只透传。

export interface RemoteAssistStatus {
  installed: boolean
  /** 开关意图（开机自启），查询失败为 null */
  enabled: boolean | null
  /** 隧道进程实际是否在运行，查询失败为 null */
  running: boolean | null
  state: 'disabled' | 'connecting' | 'connected' | 'error' | 'unavailable' | 'stopping' | 'unknown' | 'suspended'
  message: string | null
  server: { host: string; port: number } | null
  credentials: boolean
  sessions: number
  enabled_at: number | null
  /** 本机授权机器码（去横杠大写），供技术支持核对；尚未读到为 null */
  machine_code?: string | null
}

export interface RemoteAssistEvent {
  ts: number
  type: 'enabled' | 'disabled' | 'server_changed' | 'session_started' | 'session_ended'
  actor: string | null
  detail: string | null
}

export interface RemoteAssistTestResult { ok: boolean; latency_ms: number | null; message: string }

export async function getRemoteAssistStatus(config: OsHelperConfig): Promise<RemoteAssistStatus> {
  const { ok: _ok, ...status } = await request(config, '/remote-assist/status')
  return status
}

export async function listRemoteAssistEvents(config: OsHelperConfig, limit: number): Promise<RemoteAssistEvent[]> {
  const data = await request(config, `/remote-assist/events?limit=${limit}`)
  return data.events || []
}

export async function setRemoteAssistEnabled(config: OsHelperConfig, enabled: boolean, actor: string): Promise<void> {
  await request(config, `/remote-assist/${enabled ? 'enable' : 'disable'}`,
    { method: 'POST', body: JSON.stringify({ actor }) }, WRITE_TIMEOUT_MS)
}

export async function updateRemoteAssistServer(
  config: OsHelperConfig, host: string, port: number, actor: string,
): Promise<{ host: string; port: number }> {
  const data = await request(config, '/remote-assist/server',
    { method: 'PUT', body: JSON.stringify({ host, port, actor }) }, WRITE_TIMEOUT_MS)
  return data.server
}

export async function testRemoteAssist(config: OsHelperConfig): Promise<RemoteAssistTestResult> {
  return request(config, '/remote-assist/test', { method: 'POST' }, WRITE_TIMEOUT_MS)
}

export async function wifiDisconnect(
  config: OsHelperConfig,
  iface: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await request(
    config,
    `/network/wifi/${encodeURIComponent(iface)}/disconnect`,
    { method: 'POST' },
    WRITE_TIMEOUT_MS,
    fetchImpl,
  )
}

export async function storageRequest(config: OsHelperConfig, path: string) {
  return request(config, path, {}, 12000)
}
