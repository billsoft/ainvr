import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionCapReached, mediaServerReachable, recoverFromConnectionCap, retryDelay } from '@/components/player/playerRecovery'

describe('播放自动恢复', () => {
  afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear() })

  it('连续失败按 5、10、20、40 秒退避，最长 60 秒', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000])
  })

  it('能连上服务器才算可达；登录过期也算可达（播放请求会自己续期），断网和服务异常都不可达', async () => {
    const answer = (status: number) => vi.stubGlobal('fetch', vi.fn(async () => ({ status })))
    answer(204); expect(await mediaServerReachable()).toBe(true)
    answer(401); expect(await mediaServerReachable()).toBe(true)
    answer(502); expect(await mediaServerReachable()).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await mediaServerReachable()).toBe(false)
  })

  it('认出浏览器的连接名额用尽', () => {
    expect(connectionCapReached(new Error("Failed to construct 'RTCPeerConnection': Cannot create so many PeerConnections"))).toBe(true)
    expect(connectionCapReached(new Error('WebRTC ICE 连接超时'))).toBe(false)
  })

  it('名额用尽时刷新页面恢复画面，10 分钟内只刷新一次，避免反复刷新', () => {
    const reload = vi.fn()
    expect(recoverFromConnectionCap(reload, 1_000_000)).toBe(true)
    expect(recoverFromConnectionCap(reload, 1_000_000 + 5 * 60_000)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(recoverFromConnectionCap(reload, 1_000_000 + 11 * 60_000)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
