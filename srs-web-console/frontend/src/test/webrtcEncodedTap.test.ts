import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachWebRTC, installSeiTap } from '@/components/player/webrtc'
import { SEI_UUID } from '@/components/player/seiDetections'

// 编码帧取 SEI 的两条路（设计 §8.2）：Chrome 的 createEncodedStreams（主线程），
// 标准 RTCRtpScriptTransform（Safari/iPad，Worker 里）。两条路交给回调的都是
// (RTP 时间戳, 含 SEI 的字节, 到达时刻[主线程 performance.now 时基])。

const frameBytes = (withSei: boolean) => {
  const head = [0, 0, 0, 1, 0x4e, 0x01, 0x05, 0x30]
  const body = withSei ? [...SEI_UUID, ...new TextEncoder().encode('{"d":[]}')] : [1, 2, 3]
  return new Uint8Array([...head, ...body, 0, 0, 1, 0x26, 0x01, 9, 9, 9]).buffer
}

describe('installSeiTap（Worker 内运行的 SEI 扫描）', () => {
  it('每帧原样放行；带 SEI 的帧把 UUID 起的字节连同 RTP 时间戳、到达时刻发回主线程', async () => {
    const posted: Array<{ ts: number; arrivalEpochMs: number; data: Uint8Array | null }> = []
    const scope: Record<string, unknown> = {
      performance: { timeOrigin: 1_000_000, now: () => 250 },
      postMessage: (m: never) => posted.push(m),
    }
    installSeiTap(scope, Array.from(SEI_UUID))
    const frames = [
      { timestamp: 9000, data: frameBytes(true), getMetadata: () => ({ rtpTimestamp: 90000 }) },
      { timestamp: 93600, data: frameBytes(false) },
    ]
    const readable = new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(f)
        c.close()
      },
    })
    const passed: unknown[] = []
    const writable = new WritableStream({ write: (f) => void passed.push(f) })
    ;(scope.onrtctransform as (e: unknown) => void)({ transformer: { readable, writable } })
    await vi.waitFor(() => expect(passed).toHaveLength(2))
    expect(passed).toEqual(frames) // 同一对象原样 enqueue，不改帧
    expect(posted).toHaveLength(2)
    expect(posted[0]!.ts).toBe(90000) // getMetadata().rtpTimestamp 优先
    expect(posted[0]!.arrivalEpochMs).toBe(1_000_250)
    expect(Array.from(posted[0]!.data!.subarray(0, 16))).toEqual(Array.from(SEI_UUID))
    expect(posted[1]).toMatchObject({ ts: 93600, data: null }) // 没有 SEI 也要报，缓存据此记"本帧无框"
  })

  it('回调里出错也放行帧（叠框不能拖垮解码）', async () => {
    const scope: Record<string, unknown> = {
      performance: { timeOrigin: 0, now: () => 0 },
      postMessage: () => { throw new Error('boom') },
    }
    installSeiTap(scope, Array.from(SEI_UUID))
    const frame = { timestamp: 1, data: frameBytes(true) }
    const readable = new ReadableStream({ start(c) { c.enqueue(frame); c.close() } })
    const passed: unknown[] = []
    ;(scope.onrtctransform as (e: unknown) => void)({
      transformer: { readable, writable: new WritableStream({ write: (f) => void passed.push(f) }) },
    })
    await vi.waitFor(() => expect(passed).toEqual([frame]))
  })

  it('函数可独立序列化进 Worker（不引用外部变量）', () => {
    const src = `(${installSeiTap.toString()})(self, [1,2])`
    const fakeSelf: Record<string, unknown> = {}
    // eslint-disable-next-line no-new-func
    new Function('self', src)(fakeSelf)
    expect(typeof fakeSelf.onrtctransform).toBe('function')
  })
})

// ---- attachWebRTC 选路 ----

type Listener = ((e: { data: unknown }) => void) | null

class FakeWorker {
  static last: FakeWorker | null = null
  onmessage: Listener = null
  onerror: ((e: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false
  url: string
  constructor(url: string) {
    this.url = url
    FakeWorker.last = this
  }
  terminate() {
    this.terminated = true
  }
}

class FakeScriptTransform {
  worker: FakeWorker
  options: unknown
  constructor(worker: FakeWorker, options: unknown) {
    this.worker = worker
    this.options = options
  }
}

function installFakes(opts: { insertable: boolean; script: boolean; fetchFails?: boolean }) {
  const receiver: Record<string, unknown> = {}
  const created: Array<Record<string, unknown> | undefined> = []
  const closed: unknown[] = []
  class FakePC {
    connectionState = 'connected'
    iceConnectionState = 'connected'
    onconnectionstatechange = null
    oniceconnectionstatechange = null
    ontrack = null
    constructor(cfg?: Record<string, unknown>) {
      created.push(cfg)
    }
    addTransceiver(kind: string) {
      return kind === 'video' ? { receiver } : { receiver: {} }
    }
    async createOffer() { return { type: 'offer', sdp: 'o' } }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() { closed.push(this) }
    async getStats() { return new Map() as unknown as RTCStatsReport }
  }
  if (opts.insertable) {
    receiver.createEncodedStreams = () => {
      const ts = new TransformStream()
      return { readable: ts.readable, writable: ts.writable }
    }
  }
  // 能力按原型判定（建连前就要决定是否声明 encodedInsertableStreams）
  class FakeReceiverProto {}
  if (opts.insertable) {
    Object.assign(FakeReceiverProto.prototype, { createEncodedStreams: receiver.createEncodedStreams })
  }
  vi.stubGlobal('RTCRtpReceiver', FakeReceiverProto)
  vi.stubGlobal('RTCPeerConnection', FakePC)
  vi.stubGlobal('RTCRtpScriptTransform', opts.script ? FakeScriptTransform : undefined)
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (opts.fetchFails) throw new TypeError('Failed to fetch')
    return { json: async () => ({ code: 0, sdp: 'a' }) }
  }))
  URL.createObjectURL = vi.fn(() => 'blob:tap')
  URL.revokeObjectURL = vi.fn()
  return { receiver, created, closed }
}

describe('attachWebRTC 编码帧通道选路', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeWorker.last = null
  })

  it('Worker 异常只报告一次，关闭后的错误不触发恢复', async () => {
    installFakes({ insertable: false, script: true })
    const onError = vi.fn()
    const handle = await attachWebRTC(document.createElement('video'), {
      api: 'x', streamurl: 'y', onEncodedVideoFrame: () => {}, onEncodedPipelineError: onError,
    })
    const worker = FakeWorker.last!
    worker.onerror!({ message: 'worker stopped' })
    worker.onmessageerror!()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(handle.encodedFramesSupported).toBe(false)
    handle.close()
    worker.onerror!({ message: 'closed' })
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('编码管道失败：主动关闭=%s', async (closeFirst) => {
    const { receiver } = installFakes({ insertable: true, script: false })
    let input!: ReadableStreamDefaultController
    receiver.createEncodedStreams = () => ({
      readable: new ReadableStream({ start(c) { input = c } }),
      writable: new WritableStream(),
    })
    const onError = vi.fn()
    const handle = await attachWebRTC(document.createElement('video'), {
      api: 'x', streamurl: 'y', onEncodedVideoFrame: () => {}, onEncodedPipelineError: onError,
    })
    if (closeFirst) handle.close()
    input.error(new Error('stream failed'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onError).toHaveBeenCalledTimes(closeFirst ? 0 : 1)
    handle.close()
  })

  it('只有 RTCRtpScriptTransform（Safari/iPad）→ Worker 通道，回调拿到主线程时基的到达时刻', async () => {
    const { receiver, created } = installFakes({ insertable: false, script: true })
    const video = document.createElement('video')
    const onFrame = vi.fn()
    const handle = await attachWebRTC(video, { api: 'x', streamurl: 'y', onEncodedVideoFrame: onFrame })
    expect(handle.encodedFramesSupported).toBe(true)
    expect(created[0]).toBeUndefined() // 不需要 encodedInsertableStreams
    expect(receiver.transform).toBeInstanceOf(FakeScriptTransform)
    const w = FakeWorker.last!
    const sei = new Uint8Array([7, 7])
    w.onmessage!({ data: { ts: 1234, arrivalEpochMs: performance.timeOrigin + 500, data: sei } })
    w.onmessage!({ data: { ts: 1235, arrivalEpochMs: performance.timeOrigin + 540, data: null } })
    expect(onFrame).toHaveBeenNthCalledWith(1, 1234, sei, 500)
    expect(onFrame.mock.calls[1]![0]).toBe(1235)
    expect(onFrame.mock.calls[1]![1]).toHaveLength(0)
    expect(onFrame.mock.calls[1]![2]).toBeCloseTo(540, 5)
    handle.close()
    expect(w.terminated).toBe(true)
  })

  it('两种都有（Chrome）→ 保持原来的 createEncodedStreams 路径，行为不变', async () => {
    const { receiver, created } = installFakes({ insertable: true, script: true })
    const handle = await attachWebRTC(document.createElement('video'), {
      api: 'x', streamurl: 'y', onEncodedVideoFrame: () => {},
    })
    expect(handle.encodedFramesSupported).toBe(true)
    expect(created[0]).toEqual({ encodedInsertableStreams: true })
    expect(receiver.transform).toBeUndefined()
    expect(FakeWorker.last).toBeNull()
    handle.close()
  })

  it('都没有 → encodedFramesSupported=false，调用方显示不可用', async () => {
    installFakes({ insertable: false, script: false })
    const handle = await attachWebRTC(document.createElement('video'), {
      api: 'x', streamurl: 'y', onEncodedVideoFrame: () => {},
    })
    expect(handle.encodedFramesSupported).toBe(false)
    handle.close()
  })

  it('建连失败（SDP 请求失败）时关掉 PC 和 Worker，不留泄漏——失败后会反复重试', async () => {
    const { closed } = installFakes({ insertable: false, script: true, fetchFails: true })
    await expect(attachWebRTC(document.createElement('video'), {
      api: 'x', streamurl: 'y', onEncodedVideoFrame: () => {},
    })).rejects.toThrow('Failed to fetch')
    expect(closed).toHaveLength(1)
    expect(FakeWorker.last!.terminated).toBe(true)
  })
})
