import type { Channel, ChannelWithStatus, ChannelStatus, DownstreamProtocol } from '@/types/channel'
import { DOWNSTREAM_LABEL } from '@/types/channel'
import type { ChannelService, ChannelCreateInput } from './channelService'
import { request } from './httpClient'

/**
 * BFF 响应中的通道数据结构（后端类型）
 * 与前端类型有差异，通过映射层转换
 */
export interface BffChannel {
  id: string
  name: string
  upstreamProtocol: 'rtmp' | 'srt' | 'webrtc' | 'rtsp'
  streamName: string
  downstreamProtocols: DownstreamProtocol[]
  app?: string
  primaryProtocol?: DownstreamProtocol
  remark?: string
  rtspUrl?: string
  rtspTransport?: 'tcp' | 'udp'
  inputUsername?: string
  inputEnabled?: boolean
  inputGeneration?: string
  inputCredentialSet?: boolean
  createdAt: number
  updatedAt: number
  status: BffChannelStatus
  urls?: {
    push?: Record<string, string>
    play: Record<string, string>
  }
}

export interface BffChannelStatus {
  online: boolean
  clients: number
  bitrate?: number
  srsOnline: boolean
  inputState?: string
  videoCodec?: string
  videoLevel?: string
  videoWidth?: number
  videoHeight?: number
}

export interface BffListResponse {
  code: number
  data: BffChannel[]
}

export interface BffDetailResponse {
  code: number
  data: BffChannel & { urls: { push?: Record<string, string>; play: Record<string, string> } }
}

/** 后端 upstreamProtocol → 前端 upstream 结构 */
function mapUpstream(bff: BffChannel): Channel['upstream'] {
  return {
    protocol: bff.upstreamProtocol,
    app: bff.app || 'live',
    stream: bff.streamName,
    rtspUrl: bff.rtspUrl,
    rtspTransport: bff.rtspTransport,
    inputUsername: bff.inputUsername,
    inputEnabled: bff.inputEnabled,
    inputCredentialSet: bff.inputCredentialSet,
  }
}

/** 后端 downstreamProtocols → 前端 downstream（protocols 数组 + primary） */
function mapDownstream(bff: BffChannel): Channel['downstream'] {
  const prots = bff.downstreamProtocols as DownstreamProtocol[]
  // 优先用持久化的 primaryProtocol（须在当前协议列表里才有效）；
  // 没有/失效时才回退旧规则（flv 优先，否则取第一个）
  const stored = bff.primaryProtocol
  const primary = (stored && prots.includes(stored))
    ? stored
    : ((prots.find(p => p === 'flv') || prots[0] || 'flv') as DownstreamProtocol)
  return {
    protocols: prots,
    primary,
  }
}

/** 后端 status → 前端 status */
function mapStatus(bff: BffChannel): ChannelStatus {
  return {
    channelId: bff.id,
    online: bff.status.online,
    inputState: bff.status.inputState,
    viewerCount: bff.status.clients,
    bitrateKbps: bff.status.bitrate,
    videoCodec: bff.status.videoCodec,
    videoLevel: bff.status.videoLevel,
    videoWidth: bff.status.videoWidth,
    videoHeight: bff.status.videoHeight,
  }
}

/** 后端 BffChannel → 前端 ChannelWithStatus */
function mapChannel(bff: BffChannel): ChannelWithStatus {
  return {
    id: bff.id,
    inputGeneration: bff.inputGeneration,
    name: bff.name,
    description: bff.remark,
    upstream: mapUpstream(bff),
    downstream: mapDownstream(bff),
    createdAt: new Date(bff.createdAt).toISOString(),
    updatedAt: new Date(bff.updatedAt).toISOString(),
    status: mapStatus(bff),
    urls: bff.urls,
  }
}

// 5 种下行协议全部放开（此前只放行 3 种、静默丢弃用户勾选的 rtmp/srt，
// 且不给任何提示）。仍然用白名单过滤而不是直接透传——防御未来协议还没
// 同步时把非法值捅给后端。
const DOWNSTREAM_WHITELIST = Object.keys(DOWNSTREAM_LABEL) as DownstreamProtocol[]

/** 前端 create input → 后端 create body */
function mapCreateInput(input: ChannelCreateInput): Record<string, unknown> {
  return {
    name: input.name,
    remark: input.description,
    upstreamProtocol: input.upstream.protocol,
    streamName: input.upstream.stream || undefined,
    app: input.upstream.app || undefined,
    primaryProtocol: input.downstream.primary,
    downstreamProtocols: input.downstream.protocols.filter(p => DOWNSTREAM_WHITELIST.includes(p)),
    rtspUrl: input.upstream.rtspUrl,
    rtspTransport: input.upstream.rtspTransport,
    inputUsername: input.upstream.inputUsername,
    inputPassword: input.upstream.inputPassword,
    inputEnabled: input.upstream.inputEnabled,
  }
}

/** 前端 update patch → 后端 update body */
function mapUpdateInput(patch: Partial<ChannelCreateInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (patch.name !== undefined) body.name = patch.name
  if (patch.description !== undefined) body.remark = patch.description
  if (patch.upstream) {
    if (patch.upstream.protocol) body.upstreamProtocol = patch.upstream.protocol
    if (patch.upstream.stream) body.streamName = patch.upstream.stream
    if (patch.upstream.app) body.app = patch.upstream.app
    if (patch.upstream.rtspUrl !== undefined) body.rtspUrl = patch.upstream.rtspUrl
    if (patch.upstream.rtspTransport !== undefined) body.rtspTransport = patch.upstream.rtspTransport
    if (patch.upstream.inputUsername !== undefined) body.inputUsername = patch.upstream.inputUsername
    if (patch.upstream.inputPassword !== undefined) body.inputPassword = patch.upstream.inputPassword
    if (patch.upstream.inputEnabled !== undefined) body.inputEnabled = patch.upstream.inputEnabled
  }
  if (patch.downstream?.protocols) {
    body.downstreamProtocols = patch.downstream.protocols.filter(p => DOWNSTREAM_WHITELIST.includes(p))
  }
  if (patch.downstream?.primary) body.primaryProtocol = patch.downstream.primary
  return body
}

/**
 * HTTP 实现：调用 Fastify BFF 的 /api/channels/* 接口
 * 组件层零改动（与 mock 实现同一接口）
 */
export function createHttpChannelService(): ChannelService {
  return {
    async list({ search } = {}) {
      const body = await request<BffListResponse>('/channels', { signal: AbortSignal.timeout(10000) })
      let channels = body.data.map(mapChannel)
      const q = search?.trim().toLowerCase()
      if (q) {
        channels = channels.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.description ?? '').toLowerCase().includes(q) ||
            c.upstream.stream.toLowerCase().includes(q),
        )
      }
      return channels
    },

    async get(id) {
      try {
        const body = await request<BffDetailResponse>(`/channels/${id}`)
        return mapChannel(body.data)
      } catch (e: any) {
        if (e.status === 404) return null
        throw e
      }
    },

    async create(input) {
      const body = await request<BffDetailResponse>('/channels', {
        method: 'POST',
        body: JSON.stringify(mapCreateInput(input)),
      })
      return mapChannel(body.data)
    },

    async update(id, patch) {
      const body = await request<BffDetailResponse>(`/channels/${id}`, {
        method: 'PUT',
        body: JSON.stringify(mapUpdateInput(patch)),
      })
      return mapChannel(body.data)
    },

    async remove(id) {
      await request<void>(`/channels/${id}`, { method: 'DELETE' })
    },

    async kick(_id) {
      // TODO: Phase 5 实现断开推流（SRS /api/v1/clients/{id} DELETE）
      console.warn('[httpChannelService] kick 未实现')
    },
  }
}
