import {
  buildFallbackChain,
  createMachine,
  currentProtocol,
  isNoSignalHint,
  onFail,
  onSuccess,
  switchTo,
} from '@/utils/playerMachine'

describe('buildFallbackChain 降级链', () => {
  it('主协议 flv：[flv, hls]', () => {
    expect(buildFallbackChain('flv', ['flv', 'hls', 'rtmp'])).toEqual(['flv', 'hls'])
  })
  it('主协议 hls：[hls, flv]（hls 首位，flv 追加）', () => {
    expect(buildFallbackChain('hls', ['flv', 'hls'])).toEqual(['hls', 'flv'])
  })
  it('主协议 webrtc：链首 webrtc + flv/hls 追加，webrtc 不重复出现', () => {
    expect(buildFallbackChain('webrtc', ['webrtc', 'flv', 'hls'])).toEqual(['webrtc', 'flv', 'hls'])
  })
  it('主协议 flv + 含 webrtc：webrtc 在链末尾，不影响自动降级顺序', () => {
    expect(buildFallbackChain('flv', ['flv', 'webrtc', 'hls'])).toEqual(['flv', 'hls', 'webrtc'])
  })
  it('主协议 hls + 含 webrtc：hls 首位，flv 第二，webrtc 末尾', () => {
    expect(buildFallbackChain('hls', ['flv', 'hls', 'webrtc'])).toEqual(['hls', 'flv', 'webrtc'])
  })
  it('webrtc 未启用时忽略（不可作起点）', () => {
    expect(buildFallbackChain('webrtc', ['flv', 'hls'])).toEqual(['flv', 'hls'])
  })
  it('防御：primary 不在 enabled 时从可用协议选第一个', () => {
    expect(buildFallbackChain('flv', ['hls'])).toEqual(['hls'])
    expect(buildFallbackChain('rtmp', ['flv', 'hls'])).toEqual(['flv', 'hls'])
  })
  it('全无网页协议时返回空链', () => {
    expect(buildFallbackChain('rtmp', ['rtmp', 'srt'])).toEqual([])
  })
  it('去重：enabled 含重复协议', () => {
    expect(buildFallbackChain('flv', ['flv', 'flv', 'hls', 'hls'])).toEqual(['flv', 'hls'])
  })
})

describe('状态机转移', () => {
  it('createMachine：空链直接 failed，带错误信息', () => {
    const s = createMachine([])
    expect(s.status).toBe('failed')
    expect(s.lastError).toBeTruthy()
    expect(currentProtocol(s)).toBeNull()
  })
  it('createMachine：有链进入 connecting，当前协议为链首', () => {
    const s = createMachine(['flv', 'hls'])
    expect(s.status).toBe('connecting')
    expect(currentProtocol(s)).toBe('flv')
  })
  it('connecting → onSuccess → playing（仍能报告当前协议）', () => {
    let s = createMachine(['flv', 'hls'])
    s = onSuccess(s)
    expect(s.status).toBe('playing')
    expect(currentProtocol(s)).toBe('flv')
  })
  it('connecting → onFail → 推进下一协议', () => {
    let s = createMachine(['flv', 'hls'])
    s = onFail(s, 'network 404')
    expect(s.status).toBe('connecting')
    expect(currentProtocol(s)).toBe('hls')
    expect(s.lastError).toBe('network 404')
  })
  it('链尽 → failed（保留最后错误）', () => {
    let s = createMachine(['flv', 'hls'])
    s = onFail(s, 'err1')
    s = onFail(s, 'err2')
    expect(s.status).toBe('failed')
    expect(s.lastError).toBe('err2')
    expect(currentProtocol(s)).toBeNull()
  })
  it('playing 状态下 onFail 回到 connecting 重试；failed 状态幂等', () => {
    let s = createMachine(['flv', 'hls'])
    s = onSuccess(s) // 先到 playing
    expect(s.status).toBe('playing')
    // playing 出错 → 重试当前协议
    s = onFail(s, 'stream broken')
    expect(s.status).toBe('connecting')
    expect(currentProtocol(s)).toBe('flv')
    expect(s.lastError).toBe('stream broken')
    // failed 状态下再 fail 还是 failed
    const f = createMachine(['flv'])
    const failed = onFail(f)
    expect(onFail(failed, 'x').status).toBe('failed')
    expect(onSuccess(onSuccess(s)).status).toBe('playing')
  })
  it('switchTo：切到链内协议重置 connecting；链外协议无效', () => {
    let s = createMachine(['flv', 'hls'])
    s = onFail(s)
    s = switchTo(s, 'flv')
    expect(s.status).toBe('connecting')
    expect(currentProtocol(s)).toBe('flv')
    expect(switchTo(s, 'webrtc')).toBe(s)
  })
})

describe('generation：只在需要重新建连时才 +1（回归：闪一下就黑屏）', () => {
  it('onSuccess 不推进 generation —— 播放成功不该触发重建连接', () => {
    let s = createMachine(['flv', 'hls'])
    const g0 = s.generation
    s = onSuccess(s)
    expect(s.generation).toBe(g0)
  })
  it('connecting 阶段 onFail（换协议）推进 generation', () => {
    let s = createMachine(['flv', 'hls'])
    const g0 = s.generation
    s = onFail(s, 'x')
    expect(s.generation).toBeGreaterThan(g0)
  })
  it('playing 阶段 onFail（同协议重连）推进 generation', () => {
    let s = createMachine(['flv', 'hls'])
    s = onSuccess(s)
    const g0 = s.generation
    s = onFail(s, 'stream broken')
    expect(s.generation).toBeGreaterThan(g0)
  })
  it('switchTo 推进 generation', () => {
    let s = createMachine(['flv', 'hls'])
    s = onSuccess(s)
    const g0 = s.generation
    s = switchTo(s, 'hls')
    expect(s.generation).toBeGreaterThan(g0)
  })
})

describe('isNoSignalHint', () => {
  it('网络类原因判定为无信号', () => {
    expect(isNoSignalHint('NetworkError: 404')).toBe(true)
    expect(isNoSignalHint('连接断开')).toBe(true)
  })
  it('其他原因/无原因不是无信号', () => {
    expect(isNoSignalHint('codec unsupported')).toBe(false)
    expect(isNoSignalHint(undefined)).toBe(false)
  })
})
