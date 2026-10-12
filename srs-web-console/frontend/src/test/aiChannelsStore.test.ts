import { describe, it, expect, beforeEach } from 'vitest'
import { createAiChannelsStore } from '@/store/aiChannels'
import { createMockAiChannelService } from '@/api/aiChannelService'
import type { AiChannel } from '@/types/aiChannel'

function makeChannel(id: string, overrides: Partial<AiChannel> = {}): AiChannel {
  return {
    id,
    name: id,
    state: 'idle',
    config: {
      name: id, enabled: true,
      stream: { url: 'rtmp://x/live/y', protocol: 'auto', watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 } },
      inference_fps: 5, max_consecutive_failures: 10,
      model: { name: 'yolo26m', adapter: 'yolo26_trt', path: '', input_size: [640, 640], stride: 32, provider: 'tensorrt', engine_cache: '', class_names: null },
      preprocess: { letterbox: true, padding_color: [114, 114, 114], interpolation: 'bilinear', normalize: true, mean: [0, 0, 0], std: [255, 255, 255], rgb_order: true, ai_sample_width: 0, ai_sample_height: 0 },
      postprocess: { conf_threshold: 0.25, iou_threshold: 0.45, max_detections: 300 },
      result_buffer: { max_frames: 30 },
      publish: { enabled: false, mode: 'passthrough_sei', rtmp_base: 'rtmp://x', target_url: null, watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 }, sei: { max_payload_bytes: 1024, match_window_ms: 0, format: 'json' }, osd: { stale_ms: 800, box_thickness: 2, font_scale: 0.5, box_color: [0, 255, 0, 255], text_color: [255, 255, 255, 255], landmark_color: [255, 0, 0, 255], landmark_radius: 3, draw_confidence: true, bitrate_kbps: 4000, iframe_interval: 30 }, effective_target_url: `rtmp://x/live/${id}-ai` },
      snapshot: { enabled: false, max_count: 10000, min_interval_ms: 0, jpeg_quality: 82, max_crop_dimension: 320, padding_ratio: 0.25, projection_mode: 'none', brightness_enabled: false, brightness_target: 128, face_enhance_model: 'none', face_enhance_blend: 0.5 },
    },
    stats: {
      state: 'idle', elapsed_seconds: 0, frame_count: 0, inference_count: 0, dropped_count: 0, consecutive_errors: 0, inference_fps_actual: 0,
      timing: { preprocess: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, inference: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, postprocess: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, total: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 } },
      result_buffer_size: 0,
    },
    ...overrides,
  }
}

describe('aiChannels store', () => {
  let store: ReturnType<typeof createAiChannelsStore>

  beforeEach(() => {
    const service = createMockAiChannelService([makeChannel('cam01')])
    store = createAiChannelsStore(service)
  })

  it('fetchChannels 成功后清除 serviceUnreachable', async () => {
    store.setState({ serviceUnreachable: true })
    await store.getState().fetchChannels()
    expect(store.getState().serviceUnreachable).toBe(false)
    expect(store.getState().channels).toHaveLength(1)
  })

  it('fetchChannels 失败时保留上一次成功列表，只标记 serviceUnreachable（不清空数据）', async () => {
    const failingService = createMockAiChannelService([makeChannel('cam01')])
    failingService.list = async () => { throw new Error('网络错误') }
    const s = createAiChannelsStore(failingService)
    s.setState({ channels: [makeChannel('cam01')] })

    await s.getState().fetchChannels()
    expect(s.getState().serviceUnreachable).toBe(true)
    expect(s.getState().channels).toHaveLength(1) // 保留，不是清空
  })

  it('checkHealth: health() 返回 null 时标记不可达', async () => {
    const service = createMockAiChannelService()
    service.health = async () => null
    const s = createAiChannelsStore(service)
    await s.getState().checkHealth()
    expect(s.getState().serviceUnreachable).toBe(true)
  })

  it('checkHealth: health() 正常返回时标记可达', async () => {
    await store.getState().checkHealth()
    expect(store.getState().serviceUnreachable).toBe(false)
  })

  it('createChannel 成功后通道出现在列表里', async () => {
    await store.getState().createChannel({ id: 'cam02', stream: { url: 'rtmp://x/live/cam02' } })
    expect(store.getState().channels.map((c) => c.id)).toContain('cam02')
  })

  it('回归：createChannel 直接用响应体更新列表，不必整表重拉（审计发现 P1-5）', async () => {
    const service = createMockAiChannelService([makeChannel('cam01')])
    const s = createAiChannelsStore(service)
    await s.getState().fetchChannels() // 先让本地状态跟 mock service 的种子数据同步

    const listSpy = { count: 0 }
    const originalList = service.list.bind(service)
    service.list = async () => { listSpy.count += 1; return originalList() }

    await s.getState().createChannel({ id: 'cam02', stream: { url: 'rtmp://x/live/cam02' } })
    expect(s.getState().channels.map((c) => c.id)).toEqual(['cam01', 'cam02'])
    expect(listSpy.count).toBe(0) // 没有为了拿到新通道而多打一次 GET /channels
  })

  it('回归：updateChannel 直接用响应体替换对应通道，不必整表重拉（审计发现 P1-5）', async () => {
    const service = createMockAiChannelService([makeChannel('cam01', { name: '旧名字' })])
    const listSpy = { count: 0 }
    const originalList = service.list.bind(service)
    service.list = async () => { listSpy.count += 1; return originalList() }
    const s = createAiChannelsStore(service)
    s.setState({ channels: [makeChannel('cam01', { name: '旧名字' })] })

    await s.getState().updateChannel('cam01', { name: '新名字' })
    expect(s.getState().channels.find((c) => c.id === 'cam01')?.name).toBe('新名字')
    expect(listSpy.count).toBe(0)
  })

  it('deleteChannel 成功后通道从列表消失', async () => {
    await store.getState().fetchChannels()
    expect(store.getState().channels).toHaveLength(1)
    await store.getState().deleteChannel('cam01')
    expect(store.getState().channels).toHaveLength(0)
  })

  it('回归：deleteChannel 是乐观更新——调用期间列表立刻变化，不用等网络返回', async () => {
    let resolveRemove: () => void = () => {}
    const service = createMockAiChannelService([makeChannel('cam01')])
    service.remove = () => new Promise((r) => { resolveRemove = r })
    const s = createAiChannelsStore(service)
    s.setState({ channels: [makeChannel('cam01')] })

    const pending = s.getState().deleteChannel('cam01')
    expect(s.getState().channels).toHaveLength(0) // 请求还没返回，列表已经乐观更新了
    resolveRemove()
    await pending
  })

  it('回归：deleteChannel 失败时回滚到删除前的列表', async () => {
    const service = createMockAiChannelService([makeChannel('cam01')])
    service.remove = async () => { throw new Error('删除失败') }
    const s = createAiChannelsStore(service)
    s.setState({ channels: [makeChannel('cam01')] })

    await expect(s.getState().deleteChannel('cam01')).rejects.toThrow('删除失败')
    expect(s.getState().channels.map((c) => c.id)).toEqual(['cam01']) // 回滚，不是永久消失
  })

  it('startChannel/stopChannel 调用后刷新状态', async () => {
    await store.getState().startChannel('cam01')
    expect(store.getState().channels.find((c) => c.id === 'cam01')?.state).toBe('running')
    await store.getState().stopChannel('cam01')
    expect(store.getState().channels.find((c) => c.id === 'cam01')?.state).toBe('idle')
  })

  it('回归：startChannel 是乐观更新——请求发出后立刻显示 starting，不用等响应', async () => {
    let resolveStart: () => void = () => {}
    const service = createMockAiChannelService([makeChannel('cam01')])
    service.start = () => new Promise((r) => { resolveStart = r })
    const s = createAiChannelsStore(service)
    s.setState({ channels: [makeChannel('cam01', { state: 'idle' })] })

    const pending = s.getState().startChannel('cam01')
    expect(s.getState().channels.find((c) => c.id === 'cam01')?.state).toBe('starting')
    resolveStart()
    await pending
  })

  it('回归：startChannel 失败时回滚到原状态', async () => {
    const service = createMockAiChannelService([makeChannel('cam01')])
    service.start = async () => { throw new Error('启动失败') }
    const s = createAiChannelsStore(service)
    s.setState({ channels: [makeChannel('cam01', { state: 'idle' })] })

    await expect(s.getState().startChannel('cam01')).rejects.toThrow('启动失败')
    expect(s.getState().channels.find((c) => c.id === 'cam01')?.state).toBe('idle')
  })
})

describe('aiChannels store 持久化（回归：审计发现 P1-7——ai-service 挂了时整页刷新会看到全空列表）', () => {
  it('传了 persistKey 时，新建的 store 实例能从上一个实例写入的 sessionStorage 里恢复通道列表', async () => {
    sessionStorage.clear()
    const key = 'test-ai-channels-persist'
    const serviceA = createMockAiChannelService([makeChannel('cam01')])
    const storeA = createAiChannelsStore(serviceA, key)
    await storeA.getState().fetchChannels()
    expect(storeA.getState().channels.map((c) => c.id)).toEqual(['cam01'])

    // 模拟"整页刷新"：不复用 storeA，用同一个 key 重新建一个全新实例，
    // 且这次底层 service 直接坏掉（模拟 ai-service 已经不可达）。
    const serviceB = createMockAiChannelService([])
    serviceB.list = async () => { throw new Error('网络错误') }
    const storeB = createAiChannelsStore(serviceB, key) as ReturnType<typeof createAiChannelsStore> & {
      persist: { rehydrate: () => Promise<void> }
    }
    // zustand persist 中间件的初始化恢复是异步的（即使底层是同步的
    // sessionStorage），显式等它做完，不依赖"创建完立刻就有值"这种
    // 隐式时序假设。
    await storeB.persist.rehydrate()

    // 还没调用任何 action，仅凭 persist 中间件的初始化就应该已经从
    // sessionStorage 恢复出上一个实例写下的列表——不是空的。
    expect(storeB.getState().channels.map((c) => c.id)).toEqual(['cam01'])
  })

  it('不传 persistKey 时不读写 sessionStorage（测试工厂默认行为不变）', async () => {
    sessionStorage.clear()
    const service = createMockAiChannelService([makeChannel('cam01')])
    const s = createAiChannelsStore(service) // 不传 persistKey
    await s.getState().fetchChannels()
    expect(sessionStorage.length).toBe(0)
  })
})
