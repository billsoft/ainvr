import { mockChannels } from '@/mock/channels'
import {
  DOWNSTREAM_LABEL,
  UPSTREAM_LABEL,
  type DownstreamProtocol,
  type UpstreamProtocol,
} from '@/types/channel'

const UPSTREAMS = Object.keys(UPSTREAM_LABEL) as UpstreamProtocol[]
const DOWNSTREAMS = Object.keys(DOWNSTREAM_LABEL) as DownstreamProtocol[]

describe('mock 通道数据契约', () => {
  it('每条通道结构合法且 primary 在 protocols 内', () => {
    expect(mockChannels.length).toBeGreaterThanOrEqual(3)
    for (const ch of mockChannels) {
      expect(ch.id).toMatch(/^ch-\d{3}$/)
      expect(ch.name.length).toBeGreaterThan(0)
      expect(UPSTREAMS).toContain(ch.upstream.protocol)
      expect(ch.upstream.app.length).toBeGreaterThan(0)
      expect(ch.upstream.stream.length).toBeGreaterThan(0)
      expect(ch.downstream.protocols.length).toBeGreaterThan(0)
      expect(ch.downstream.protocols).toContain(ch.downstream.primary)
      for (const p of ch.downstream.protocols) {
        expect(DOWNSTREAMS).toContain(p)
      }
      expect(ch.status.channelId).toBe(ch.id)
      expect(ch.createdAt).not.toBe('')
      expect(ch.updatedAt).not.toBe('')
    }
  })

  it('同时包含在线与离线通道（列表 UI 需要两种状态）', () => {
    expect(mockChannels.some((c) => c.status.online)).toBe(true)
    expect(mockChannels.some((c) => !c.status.online)).toBe(true)
  })

  it('RTSP 上行必须携带 rtspUrl 源地址', () => {
    for (const ch of mockChannels) {
      if (ch.upstream.protocol === 'rtsp') {
        expect(ch.upstream.rtspUrl).toMatch(/^rtsp:\/\//)
      }
    }
  })

  it('在线通道应有码率与时长，离线通道没有', () => {
    for (const ch of mockChannels) {
      if (ch.status.online) {
        expect(ch.status.bitrateKbps).toBeGreaterThan(0)
        expect(ch.status.durationSec).toBeGreaterThan(0)
      } else {
        expect(ch.status.bitrateKbps).toBeUndefined()
        expect(ch.status.viewerCount).toBe(0)
      }
    }
  })
})
