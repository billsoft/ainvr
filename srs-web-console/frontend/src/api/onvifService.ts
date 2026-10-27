import { request } from './httpClient'
export interface OnvifBinding {
  deviceId: string
  deviceVersion: number
  service: 'media1' | 'media2'
  profileToken: string
  videoSource: string
}
export interface OnvifProfile {
  service: 'media1' | 'media2'
  token: string
  name: string
  videoSource: string
  videoCodec: string
  audioCodec: string
  width: number
  height: number
  fps: number
}
export interface OnvifCapabilities {
  manufacturer: string
  model: string
  firmware: string
  serial: string
  clockVerified: boolean
  clockOffsetSeconds: number
  profiles: OnvifProfile[]
  warnings: string[]
}
export interface OnvifDevice {
  model?: string
  id: string
  name: string
  url: string
  username: string
  version: number
  certificateSHA256: string
  epr?: string
  capabilities?: OnvifCapabilities
  lastError?: string
  credentialSet: boolean
}
export interface OnvifSettings {
  enabled: boolean
  serviceUrl: string
  allowedCIDRs: string[]
  interfaces: string[]
  timeoutSeconds: number
}
export interface OnvifSettingsResponse {
  revision: number
  settings: OnvifSettings
  tokenSet: boolean
}
const messages: Record<string, string> = {
  device_already_configured: '此设备已经配置，请选择已有设备',
  redirect_not_allowed: '设备返回了重定向地址，请直接填写正确的设备服务地址',
  onvif_disabled: '请先在系统配置中启用 ONVIF 接入',
  control_service_unavailable: 'ONVIF 服务暂不可用，请检查系统配置',
  authentication_failed: '摄像头认证失败，请检查专用账号、密码和设备时间',
  address_not_allowed: '摄像头地址不在允许访问的网段内，请检查系统配置',
  device_unreachable: '无法连接摄像头，请检查地址、网络与 ONVIF 开关',
  profile_not_found: '原视频源或码流已不存在，请重新读取并明确选择',
  device_configuration_changed: '设备配置已更新，请重新读取码流',
  version_conflict: '配置已被修改，请重新读取后保存',
  source_already_connected: '该设备码流已经接入，请从通道列表编辑',
  service_credential_missing: 'ONVIF 服务连接密钥尚未配置',
  device_credential_missing: '摄像头凭据不可用，请重新设置',
  service_host_changed: '设备返回了其他主机的服务地址，已停止连接',
  media_host_changed: '设备返回了其他主机的媒体地址，已停止连接',
  unsupported_video_codec: '当前码流编码不支持，请选择 H.264 或 H.265',
  invalid_certificate_pin: '设备证书指纹无效',
  certificate_untrusted: '设备 HTTPS 证书未受信任',
  capacity_exceeded: '设备查询繁忙，请稍后重试',
  discovery_busy: '发现任务正在运行，请稍后重试',
  interface_not_allowed: '请在系统配置中选择允许发现摄像头的网卡',
  profiles_unavailable: '设备未提供可接入的视频码流',
  device_not_found: '原设备配置不存在',
  media_service_unavailable: '设备没有提供可用的媒体服务',
}
export function onvifError(e: unknown) {
  const text = e instanceof Error ? e.message : String(e)
  return messages[text] ?? text
}
async function call<T>(path: string, body?: unknown, method = 'POST') {
  try {
    return await request<T>(
      '/onvif' + path,
      body === undefined ? undefined : { method, body: JSON.stringify(body) },
    )
  } catch (e) {
    throw new Error(onvifError(e))
  }
}
export const onvifService = {
  settings: () => call<OnvifSettingsResponse>('/settings'),
  status: () =>
    call<{
      state: string
      appliedRevision?: number
      desiredRevision?: number
      channels?: Record<string, { error?: string }>
    }>('/status'),
  saveSettings: (body: { settings: OnvifSettings; expectedRevision: number; token?: string }) =>
    call<{ revision: number }>('/settings', body, 'PUT'),
  device: (id: string) => call<OnvifDevice>(`/devices/${encodeURIComponent(id)}`),
  devices: () => call<{ items: OnvifDevice[] }>('/devices'),
  saveDevice: (body: {
    id?: string
    expectedVersion?: number
    name: string
    url: string
    username: string
    password?: string
    certificateSHA256: string
    epr?: string
  }) => call<{ id: string; version: number }>('/devices', body),
  probe: (id: string) =>
    call<{ version: number; capabilities: OnvifCapabilities }>(
      `/devices/${encodeURIComponent(id)}/probe`,
      {},
    ),
  discover: (networkInterface: string) =>
    call<{ items: { url: string; epr: string; scopes: string[] }[] }>('/discover', {
      interface: networkInterface,
    }),
  saveChannel: (body: {
    ptz?: import('./ptzService').CameraPtzDraft
    binding: OnvifBinding
    inputId?: string
    expectedGeneration?: string
    config: {
      name: string
      remark?: string
      downstreamProtocols: string[]
      primaryProtocol: string
      inputEnabled: boolean
    }
  }) => call<{ id: string;ptzApplication?:{state:'applied'|'failed'} }>('/channel-config', body),
}
