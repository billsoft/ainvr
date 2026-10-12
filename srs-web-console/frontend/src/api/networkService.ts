import { request } from './httpClient'

export type IpMethod = 'auto' | 'manual' | 'disabled' | 'link-local'

export interface IpFamily {
  method: IpMethod
  address?: string
  /** IPv4 传点分掩码（255.255.255.0）；IPv6 传数字前缀长度（64）。os-helper 两种都收。 */
  netmask?: string
  gateway?: string
  dns?: string[]
}

export interface IpConfig {
  ipv4: IpFamily
  ipv6: IpFamily
  rollback_seconds?: number
}

/**
 * 以下类型与 os-helper（shared/os-helper/nm.py）的返回结构逐字段对齐，
 * BFF（routes/network.ts）只透传不转换，这里就是前后端唯一契约。
 * 改字段必须三方同步：nm.py → osHelperClient.ts → 本文件。
 */

/** nm.py _iface_detail：IP 协议族运行时信息。addresses 元素为 "地址/前缀"，如 192.168.1.5/24 */
export interface IpFamilyInfo {
  /** NetworkManager 配置方式：auto/manual/disabled/link-local（NM 异常时可能缺省为 disabled） */
  method: string
  addresses: string[]
  gateway: string | null
  dns: string[]
}

/** nm.py list_interfaces 单项结构 */
export interface NetworkInterface {
  name: string
  kind: 'ethernet' | 'wifi' | 'bridge'
  /** nmcli device status 的原始状态文案（随系统 locale 可能是中文），展示用；判断连接用 connected */
  state: string
  connected: boolean
  /** 物理链路（网线插上/无线关联），来自 sysfs carrier */
  carrier: boolean
  connection: string | null
  /** 系统虚拟网卡（docker/l4tbr0/usb0 等），默认不列出、不允许修改 */
  system: boolean
  mac: string | null
  mtu: number | null
  /** nm.py 暂未采集速率，恒为 null，保留字段位 */
  speed: number | null
  ipv4: IpFamilyInfo
  ipv6: IpFamilyInfo
}

/** nm.py wifi_scan 单项结构。security 是 nmcli 原文：开放网络为空串，其余如 WEP/WPA2/WPA3 */
export interface WifiAccessPoint {
  ssid: string
  bssid: string
  mode: string
  channel: number | null
  rate: string
  /** 0-100 */
  signal: number
  security: string
  active: boolean
}

/** nm.py get_fallback_info：出厂兜底地址，没走 provisioning 的设备为 null */
export interface FallbackInfo {
  interface: string
  address: string
  prefix: number
  /** 此刻是否真的挂在网卡上——没插网线/还没走完 provisioning 都会是 false，不代表出错 */
  reachable: boolean
}

/** nm.py pending_info：无待确认变更时整个为 null */
export interface PendingChange {
  /** 本次变更唯一 ID：自动确认按它计时、确认时带回，防止误确认另一次变更（旧版 os-helper 无此字段） */
  id?: string
  iface: string
  state: 'applying' | 'waiting_confirm'
  /** 距自动回滚剩余秒数（os-helper 实时计算） */
  remaining: number
}

/** nm.py check_connectivity 结构 */
export interface ConnectivityTest {
  iface: string
  gateway: { ok: boolean; latency: number | null }
  internet_v4: { ok: boolean; latency: number | null }
  internet_v6: { ok: boolean; latency: number | null }
  dns: { ok: boolean; latency: number | null }
}

interface ListResp { code: number; data: NetworkInterface[] }
interface PendingResp { code: number; data: PendingChange | null }
interface FallbackResp { code: number; data: FallbackInfo | null }
interface WifiScanResp { code: number; data: WifiAccessPoint[] }
interface TestResp { code: number; data: ConnectivityTest }
interface ApplyResp { code: number; data: { ok: boolean; rollback_seconds: number } }

/**
 * 网络管理 API
 * 系统级操作，直接落 os-helper 生效，不走配置中心。
 */
export const networkService = {
  /** 网卡列表（默认只列物理网卡；all=true 连系统虚拟网卡一起列） */
  async listInterfaces(all = false): Promise<NetworkInterface[]> {
    const res = await request<ListResp>(`/network/interfaces${all ? '?all=true' : ''}`)
    return res.data
  },

  /** 查询待确认的变更（安全回滚倒计时），无变更时返回 null */
  async getPending(): Promise<PendingChange | null> {
    const res = await request<PendingResp>('/network/pending')
    return res.data
  },

  /** 出厂兜底地址信息，没走 provisioning 的设备返回 null */
  async getFallback(): Promise<FallbackInfo | null> {
    const res = await request<FallbackResp>('/network/fallback')
    return res.data
  },

  /** 连通性检测 */
  async testConnectivity(iface: string): Promise<ConnectivityTest> {
    const res = await request<TestResp>(`/network/interfaces/${encodeURIComponent(iface)}/test`)
    return res.data
  },

  /** WiFi 扫描 */
  async scanWifi(iface: string, rescan = true): Promise<WifiAccessPoint[]> {
    const res = await request<WifiScanResp>(
      `/network/wifi/${encodeURIComponent(iface)}/scan${rescan ? '' : '?rescan=false'}`,
    )
    return res.data
  },

  /** 应用 IP 配置（带安全回滚）。返回 os-helper 实际受理的回滚秒数。 */
  async applyIpConfig(iface: string, config: IpConfig): Promise<{ rollbackSeconds: number }> {
    const res = await request<ApplyResp>(
      `/network/interfaces/${encodeURIComponent(iface)}/config`,
      { method: 'PUT', body: JSON.stringify(config) },
    )
    return { rollbackSeconds: res.data.rollback_seconds }
  },

  /** 确认变更（取消回滚）。changeId 为页面看到的那次变更，与设备当前待确认变更不符时会被拒绝 */
  async confirm(changeId?: string): Promise<void> {
    await request('/network/confirm', changeId === undefined
      ? { method: 'POST' }
      : { method: 'POST', body: JSON.stringify({ id: changeId }) })
  },

  /** 立即回滚 */
  async revert(): Promise<void> {
    await request('/network/revert', { method: 'POST' })
  },

  /** WiFi 连接 */
  async wifiConnect(iface: string, ssid: string, password?: string | null, hidden?: boolean): Promise<void> {
    await request(`/network/wifi/${encodeURIComponent(iface)}/connect`, {
      method: 'POST',
      body: JSON.stringify({ ssid, password, hidden }),
    })
  },

  /** WiFi 断开 */
  async wifiDisconnect(iface: string): Promise<void> {
    await request(`/network/wifi/${encodeURIComponent(iface)}/disconnect`, {
      method: 'POST',
    })
  },
}
