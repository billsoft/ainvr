import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachWebRTC, SETTLE_CLOSE_MS } from '@/components/player/webrtc'

// Chrome 对"服务器已应答、ICE 已通、加密握手还没完成"时关闭的连接常常永远不释放，
// 每个都占整页的连接名额（190 实测）。所以握手中的连接要等落定再关，其余立即关。

class FakePC {
  static last: FakePC | null = null
  connectionState = 'new'
  iceConnectionState = 'connected'
  onconnectionstatechange: (() => void) | null = null
  oniceconnectionstatechange: (() => void) | null = null
  ontrack: unknown = null
  closeCalls = 0
  constructor() { FakePC.last = this }
  addTransceiver() { return { receiver: {} } }
  async createOffer() { return { type: 'offer', sdp: 'o' } }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() { this.closeCalls++; this.connectionState = 'closed' }
  async getStats() { return new Map() as unknown as RTCStatsReport }
  settle(state: string) { this.connectionState = state; this.onconnectionstatechange?.() }
}

function install(fetchImpl: () => Promise<unknown>) {
  vi.stubGlobal('RTCPeerConnection', FakePC)
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
}
const answered = async () => ({ status: 200, json: async () => ({ code: 0, sdp: 'a' }) })

describe('attachWebRTC 关闭时机', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    FakePC.last = null
  })

  it('握手中被关：画面和回调立即断开，连接等握手落定后才真正关闭', async () => {
    install(answered)
    const video = document.createElement('video')
    const handle = await attachWebRTC(video, { api: 'x', streamurl: 'y' })
    const pc = FakePC.last!
    handle.close()
    expect(pc.closeCalls).toBe(0)
    expect(pc.ontrack).toBeNull()
    expect(pc.oniceconnectionstatechange).toBeNull()
    expect(video.srcObject).toBeNull()
    pc.settle('connecting')
    expect(pc.closeCalls).toBe(0)
    pc.settle('connected')
    expect(pc.closeCalls).toBe(1)
    expect(pc.onconnectionstatechange).toBeNull()
    vi.advanceTimersByTime(SETTLE_CLOSE_MS)
    expect(pc.closeCalls).toBe(1)
  })

  it('握手一直不落定：到时限也关闭，且不再留回调', async () => {
    install(answered)
    const handle = await attachWebRTC(document.createElement('video'), { api: 'x', streamurl: 'y' })
    const pc = FakePC.last!
    handle.close()
    vi.advanceTimersByTime(SETTLE_CLOSE_MS - 1)
    expect(pc.closeCalls).toBe(0)
    vi.advanceTimersByTime(1)
    expect(pc.closeCalls).toBe(1)
    expect(pc.onconnectionstatechange).toBeNull()
  })

  it('握手失败也算落定：立即关闭', async () => {
    install(answered)
    const handle = await attachWebRTC(document.createElement('video'), { api: 'x', streamurl: 'y' })
    const pc = FakePC.last!
    handle.close()
    pc.settle('failed')
    expect(pc.closeCalls).toBe(1)
  })

  it('已连上的连接立即关闭；重复关闭不再挂监听', async () => {
    install(answered)
    const handle = await attachWebRTC(document.createElement('video'), { api: 'x', streamurl: 'y' })
    const pc = FakePC.last!
    pc.connectionState = 'connected'
    handle.close()
    handle.close()
    expect(pc.closeCalls).toBe(1)
    expect(pc.onconnectionstatechange).toBeNull()
  })

  it('服务器没应答（没进入握手）：建连失败照常立即报错，连接立即关闭', async () => {
    install(async () => { throw new TypeError('Failed to fetch') })
    await expect(attachWebRTC(document.createElement('video'), { api: 'x', streamurl: 'y' })).rejects.toThrow()
    expect(FakePC.last!.closeCalls).toBe(1)
  })

  it('握手中建连超时：照常立即报错，连接按时限收尾', async () => {
    install(answered)
    vi.stubGlobal('RTCPeerConnection', class extends FakePC { iceConnectionState = 'checking' })
    const attempt = attachWebRTC(document.createElement('video'), { api: 'x', streamurl: 'y', iceTimeoutMs: 100 })
    const failed = expect(attempt).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(100)
    await failed
    const pc = FakePC.last!
    expect(pc.closeCalls).toBe(0)
    vi.advanceTimersByTime(SETTLE_CLOSE_MS)
    expect(pc.closeCalls).toBe(1)
  })
})
