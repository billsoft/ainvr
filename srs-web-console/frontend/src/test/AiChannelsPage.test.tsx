import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { aiChannelService, createMockAiChannelService } from '@/api/aiChannelService'
import { useAiChannelsStore } from '@/store/aiChannels'
import type { AiChannel } from '@/types/aiChannel'
import { channelService } from '@/api/channelService'
import type { ChannelWithStatus } from '@/types/channel'

// AiChannelsPage 消费的是模块级单例 useAiChannelsStore/aiChannelService，
// 不注入 —— 直接用真实单例，每个用例前重置状态与底层 mock service，
// 保留 useAiChannelsStore 的真实 zustand 响应式订阅（不能自己糊一个假 hook，
// 那样会丢失"store 变了组件自动重渲染"这条关键行为）。
//
// useSettingsStore 单独 mock 掉——它内部会打真实 fetch，AiChannelsPage 只用它读
// pollIntervalMs（轮询间隔本来就与本页大多数断言无关），mock 掉避免真实网络调用
// 拖慢/搞乱测试。
vi.mock('@/store/settings', () => ({
  useSettingsStore: Object.assign(
    (selector?: (s: { settings: null }) => unknown) => (selector ? selector({ settings: null }) : { settings: null }),
    { getState: () => ({ fetchSettings: vi.fn().mockResolvedValue(undefined) }) },
  ),
}))

import AiChannelsPage from '@/pages/AiChannels/index'

function makeChannel(id: string, overrides: Partial<AiChannel> = {}): AiChannel {
  return {
    id,
    name: id,
    state: 'idle',
    config: {
      name: id, enabled: true,
      stream: { url: `rtmp://127.0.0.1/live/${id}`, protocol: 'rtmp', watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 } },
      inference_fps: 5, max_consecutive_failures: 10,
      model: { name: 'yolo26m', adapter: 'yolo26_trt', path: '', input_size: [640, 640], stride: 32, provider: 'tensorrt', engine_cache: '', class_names: null },
      preprocess: { letterbox: true, padding_color: [114, 114, 114], interpolation: 'bilinear', normalize: true, mean: [0, 0, 0], std: [255, 255, 255], rgb_order: true, ai_sample_width: 0, ai_sample_height: 0 },
      postprocess: { conf_threshold: 0.25, iou_threshold: 0.45, max_detections: 300 },
      result_buffer: { max_frames: 30 },
      publish: { enabled: false, mode: 'passthrough_sei', rtmp_base: 'rtmp://127.0.0.1', target_url: null, watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 }, sei: { max_payload_bytes: 1024, match_window_ms: 0, format: 'json' }, osd: { stale_ms: 800, box_thickness: 2, font_scale: 0.5, box_color: [0, 255, 0, 255], text_color: [255, 255, 255, 255], landmark_color: [255, 0, 0, 255], landmark_radius: 3, draw_confidence: true, bitrate_kbps: 4000, iframe_interval: 30 }, effective_target_url: `rtmp://127.0.0.1/live/${id}-ai` },
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

/** 用一份新的内存 mock service 替换单例底层方法（保留对象引用，
 * useAiChannelsStore 是在模块首次加载时以这个引用为默认参数创建的）。 */
function reseed(seed: AiChannel[] = []) {
  Object.assign(aiChannelService, createMockAiChannelService(seed))
}

async function renderPage() {
  // 服务不可达横幅的"去配置中心"现在是 react-router 的 <Link>（回归修复：
  // 此前是裸 <a href> 会触发整页刷新），Link 渲染需要 Router 上下文，
  // 所以这里统一包一层，即使大多数用例走不到降级横幅那条分支。
  const utils = render(<MemoryRouter><AiChannelsPage /></MemoryRouter>)
  await waitFor(() => expect(useAiChannelsStore.getState().loading).toBe(false))
  return utils
}

beforeEach(() => {
  reseed([])
  useAiChannelsStore.setState({ channels: [], loading: false, serviceUnreachable: false, error: null })
})

describe('AiChannelsPage', () => {
  it('缺源卡片和状态筛选一致，独立查询不受接入管理搜索影响', async () => {
    const input = makeChannel('door', { state: 'error' })
    input.stats.last_error = '初始化失败: Open media: Input/output error'
    reseed([input])
    const list = vi.spyOn(channelService, 'list').mockResolvedValue([{
      name: '后门', upstream: { app: 'live', stream: 'door' },
      status: { online: false, srsOnline: true, inputState: 'waiting-source' },
    } as ChannelWithStatus])
    try {
      await renderPage()
      expect(await screen.findByRole('status')).toHaveTextContent('系统正在自动重试')
      expect(list).toHaveBeenCalledWith()
      await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'error')
      expect(screen.queryByText('door')).not.toBeInTheDocument()
      await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'waiting-source')
      expect(screen.getByText('door')).toBeInTheDocument()
    } finally { list.mockRestore() }
  })
  it('空列表展示 EmptyState 与创建入口', async () => {
    await renderPage()
    expect(await screen.findByText('还没有 AI 通道')).toBeInTheDocument()
    expect(screen.getByText('创建第一个 AI 通道')).toBeInTheDocument()
  })

  it('渲染通道卡片：名称、状态徽标、模型、源流信息', async () => {
    reseed([makeChannel('door-cam', { name: '大门摄像头', state: 'running' })])
    await renderPage()
    expect(await screen.findByText('大门摄像头')).toBeInTheDocument()
    expect(screen.getAllByText('运行中').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/模型：通用目标检测/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/源流 rtmp:\/\/127\.0\.0\.1\/live\/door-cam/).length).toBeGreaterThan(0)
  })

  it('按模型显示任务名，不暴露模型/框架名', async () => {
    const ch = makeChannel('face-cam', { state: 'running' })
    ch.config.model = { ...ch.config.model, name: 'yolov12m-face' }
    reseed([ch])
    await renderPage()
    expect(await screen.findByText(/模型：人脸检测（标准）/)).toBeInTheDocument()
    expect(screen.queryByText(/yolo|YOLO/)).not.toBeInTheDocument()
  })

  it('人脸检测（scrfd_trt）通道展示专属模型标签', async () => {
    const ch = makeChannel('face-cam')
    ch.config.model = { ...ch.config.model, adapter: 'scrfd_trt', name: 'scrfd_10g_kps' }
    reseed([ch])
    await renderPage()
    expect(await screen.findByText(/模型：人脸检测（含关键点）/)).toBeInTheDocument()
    expect(screen.queryByText(/SCRFD|scrfd/)).not.toBeInTheDocument()
  })

  it('五态徽标：idle/running/starting/error 分别渲染正确文案', async () => {
    reseed([
      makeChannel('c1', { state: 'idle' }),
      makeChannel('c2', { state: 'running' }),
      makeChannel('c3', { state: 'starting' }),
      makeChannel('c4', { state: 'error' }),
    ])
    await renderPage()
    expect(await screen.findByText('已停止', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getAllByText('运行中').length).toBeGreaterThan(0)
    expect(screen.getByText('启动中', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('错误')).toBeInTheDocument()
  })

  it('点击 ⋮ 菜单：idle 通道展示"启动"而非"停止"', async () => {
    const user = userEvent.setup()
    reseed([makeChannel('c1', { state: 'idle' })])
    await renderPage()
    await user.click(await screen.findByLabelText('更多操作'))
    expect(screen.getByText('启动')).toBeInTheDocument()
    expect(screen.queryByText('停止')).not.toBeInTheDocument()
  })

  it('点击 ⋮ 菜单中的"启动"调用 store.startChannel 并刷新状态', async () => {
    const user = userEvent.setup()
    reseed([makeChannel('c1', { state: 'idle' })])
    await renderPage()
    await user.click(await screen.findByLabelText('更多操作'))
    await user.click(screen.getByText('启动'))

    // 启动成功后能看到运行中状态（筛选器 option + 卡片 badge 可能都有，至少有一个）
    expect((await screen.findAllByText('运行中')).length).toBeGreaterThanOrEqual(1)
    // 等 store 异步完成后状态是 running
    await waitFor(() => {
      expect(useAiChannelsStore.getState().channels.find((c) => c.id === 'c1')?.state).toBe('running')
    })
  })

  it('点击 ⋮ 菜单中的"删除"打开确认弹窗，须输入通道名才能确认', async () => {
    const user = userEvent.setup()
    reseed([makeChannel('c1', { name: '大门摄像头' })])
    await renderPage()
    await user.click(await screen.findByLabelText('更多操作'))
    await user.click(screen.getByText('删除'))

    expect(await screen.findByText('删除 AI 通道')).toBeInTheDocument()
    const confirmBtn = screen.getByTestId('confirm-ok')
    expect(confirmBtn).toBeDisabled()

    await user.type(screen.getByTestId('confirm-input'), '大门摄像头')
    expect(confirmBtn).toBeEnabled()
  })

  it('确认删除后通道从列表中消失（store 是真实响应式的，不需要手动刷新页面）', async () => {
    const user = userEvent.setup()
    reseed([makeChannel('c1', { name: '大门摄像头' })])
    await renderPage()
    await user.click(await screen.findByLabelText('更多操作'))
    await user.click(screen.getByText('删除'))
    await user.type(screen.getByTestId('confirm-input'), '大门摄像头')
    await user.click(screen.getByTestId('confirm-ok'))

    await waitFor(() => expect(screen.queryByText('大门摄像头')).not.toBeInTheDocument())
    expect(await screen.findByText('还没有 AI 通道')).toBeInTheDocument()
  })

  it('服务不可达时展示降级横幅，新建按钮禁用，保留最后成功列表', async () => {
    reseed([makeChannel('c1')])
    useAiChannelsStore.setState({ channels: [makeChannel('c1')], serviceUnreachable: false })
    // list()/health() 两个探测口必须一起失效——真实"服务下线"场景下二者会
    // 同时不可达；只改 list() 会跟 usePolling 里独立的 30s 健康检查产生竞态
    // （health() 仍返回 ok 会把 serviceUnreachable 又设回 false），是本用例
    // 自己模拟得不真实导致的假性 flaky，不是页面代码的问题。
    aiChannelService.list = async () => { throw new Error('网络错误') }
    aiChannelService.health = async () => null

    render(<MemoryRouter><AiChannelsPage /></MemoryRouter>)

    expect(await screen.findByText('AI 服务不可达，以下为上次数据（只读）')).toBeInTheDocument()
    expect(screen.getByText('c1')).toBeInTheDocument() // 保留最后成功列表，不清空
    expect(screen.getByTestId('btn-new-ai-channel')).toBeDisabled()
    // 2026-09-18：AI 不可达场景的"去配置中心"直接带上目标分类，不用用户
    // 自己再从默认的「基础配置」点过去
    expect(screen.getByRole('link', { name: '去配置中心' })).toHaveAttribute('href', '/config-center?category=ai-service')
  })

  it('未开启推流的通道"播放衍生流"按钮禁用', async () => {
    reseed([makeChannel('c1')]) // 默认 publish.enabled: false
    await renderPage()
    const btn = await screen.findByText(/播放衍生流/)
    expect(btn.closest('button')).toBeDisabled()
  })

  it('开启推流的通道卡片展示推流地址信息，"播放衍生流"按钮可用', async () => {
    const ch = makeChannel('c1', { state: 'running' })
    ch.config.publish = { ...ch.config.publish, enabled: true }
    ch.stats.publish = {
      running: true, rtmp_url: 'rtmp://127.0.0.1/live/c1-ai',
      au_in: 900, au_pushed: 900, sei_injected: 900, provider_errors: 0,
      reconnect_count: 0, consecutive_failures: 0, reconnecting: false,
      last_error: '', last_error_at: 0,
    }
    reseed([ch])
    await renderPage()
    expect(await screen.findByText(/推流.*SEI ✓/)).toBeInTheDocument()
    const btn = screen.getByText(/播放衍生流/)
    expect(btn.closest('button')).toBeEnabled()
  })

  it('发布链路真实断流场景（reconnecting=false，但 last_error_at 够新）时卡片仍要显示"推流异常"', async () => {
    // 这是复核时发现的关键场景，不是简化过的理想情况：RTMP-only 断流期间
    // 本地拉流/推理完全正常，ES 样本一直在流动，on_frame_received() 会在
    // 每次拉到 ES 样本时把 reconnecting 清成 false（早于 do_reconnect()
    // 真正跑起来），所以前端轮询几乎不可能采样到 reconnecting=true 这个
    // 瞬时状态——如果 degraded 判定只看 reconnecting，这个测试会失败，
    // 说明卡片在它本该生效的真实场景里反而是哑的（第一版实现的 bug，
    // advisor 复核抓出来的）。last_error_at 才是持续存在的可靠信号。
    const ch = makeChannel('c1', { state: 'running' })
    ch.config.publish = { ...ch.config.publish, enabled: true }
    ch.stats = {
      ...ch.stats,
      publish: {
        running: true, rtmp_url: 'rtmp://127.0.0.1/live/c1-ai',
        au_in: 900, au_pushed: 900, sei_injected: 900, provider_errors: 0, reconnect_count: 1,
        consecutive_failures: 0, reconnecting: false,
        last_error: 'rtmp2sink 断流(测试)', last_error_at: Date.now() / 1000 - 5,
      },
    }
    reseed([ch])
    await renderPage()
    expect(await screen.findByText(/推流异常/)).toBeInTheDocument()
    expect(screen.queryByText(/SEI ✓/)).not.toBeInTheDocument()
  })

  it('last_error_at 是很久以前的旧错误（已经恢复）时不应该一直显示"推流异常"', async () => {
    const ch = makeChannel('c1', { state: 'running' })
    ch.config.publish = { ...ch.config.publish, enabled: true }
    ch.stats = {
      ...ch.stats,
      publish: {
        running: true, rtmp_url: 'rtmp://127.0.0.1/live/c1-ai',
        au_in: 900, au_pushed: 900, sei_injected: 900, provider_errors: 0, reconnect_count: 1,
        consecutive_failures: 0, reconnecting: false,
        last_error: 'rtmp2sink 断流(测试，已恢复)', last_error_at: Date.now() / 1000 - 600,
      },
    }
    reseed([ch])
    await renderPage()
    expect(await screen.findByText(/SEI ✓/)).toBeInTheDocument()
    expect(screen.queryByText(/推流异常/)).not.toBeInTheDocument()
  })

  it('缺少发布统计时不能声称 SEI 推流正常', async () => {
    const ch = makeChannel('c1', { state: 'running' })
    ch.config.publish = { ...ch.config.publish, enabled: true }
    reseed([ch]) // stats.publish 未提供（旧版 ai-service/未启动时的形状）
    await renderPage()
    expect(await screen.findByText(/SEI ⚠ 推流异常/)).toBeInTheDocument()
    expect(screen.queryByText(/SEI ✓/)).not.toBeInTheDocument()
  })

  it('点击"编辑"打开向导且回填该通道数据', async () => {
    const user = userEvent.setup()
    reseed([makeChannel('c1', { name: '大门摄像头' })])
    await renderPage()
    await user.click(await screen.findByLabelText('更多操作'))
    await user.click(screen.getByText('编辑'))

    expect(await screen.findByText(/编辑 AI 通道/)).toBeInTheDocument()
    expect(screen.getByTestId('wizard-id')).toHaveValue('c1')
    expect(screen.getByTestId('wizard-id')).toBeDisabled()
  })

  it('回归：快速切换"查看结果"目标时，先发出的慢响应不能盖掉后打开的通道数据', async () => {
    const user = userEvent.setup()
    reseed([makeChannel('a', { name: '通道A' }), makeChannel('b', { name: '通道B' })])
    await renderPage()

    const fakeResultA = {
      schema_version: '1.2', channel_id: 'a', stream_url: '', stream_protocol: 'rtmp',
      timestamp: 0, frame_pts_ns: 0, frame_index: 1, frame_width: 640, frame_height: 480,
      model: { name: 'x', format: 'engine', provider: 'tensorrt', input_size: [640, 640], end2end: true, version: '1' },
      timing_ms: { decode: 0, preprocess: 0, inference: 0, postprocess: 0, total: 1 },
      task_type: 'object_detection',
      detections: [{ class_id: 0, class_name: 'person', confidence: 0.9, bbox: { x: 0, y: 0, w: 1, h: 1 } }],
      model_extra: {},
    }
    let resolveA: (v: { hasResult: boolean; result: any }) => void = () => {}
    const pendingA = new Promise((r) => { resolveA = r })
    aiChannelService.latestResult = vi.fn((id: string) => {
      if (id === 'a') return pendingA as any
      return Promise.resolve({ hasResult: false, result: null }) // 通道B：暂无结果
    })

    await user.click(screen.getAllByText('查看结果')[0]!) // 先点通道A（慢，挂起不返回）
    await user.click(screen.getAllByText('查看结果')[1]!) // 再点通道B（快，立即 resolve → 暂无结果）
    expect(await screen.findByText('该通道暂无检测结果（可能尚未启动或还没推理出第一帧）')).toBeInTheDocument()

    // 通道A的响应这时才姗姗来迟——若没有请求防串扰，这一步会把"通道B"弹窗
    // 的内容错误地替换成通道A的检测数据（弹窗标题仍显示"通道B"，内容却是
    // "person×1"，标题与数据对不上，这正是审计发现里描述的那种数据串扰）。
    resolveA({ hasResult: true, result: fakeResultA })
    await new Promise((r) => setTimeout(r, 0))

    expect(screen.getByText(/通道B · 最新检测结果/)).toBeInTheDocument()
    expect(screen.queryByText(/person×1/)).not.toBeInTheDocument()
    expect(screen.getByText('该通道暂无检测结果（可能尚未启动或还没推理出第一帧）')).toBeInTheDocument()
  })

  it('顶部统计文案正确反映通道总数与运行中数量', async () => {
    reseed([
      makeChannel('c1', { state: 'running' }),
      makeChannel('c2', { state: 'idle' }),
      makeChannel('c3', { state: 'running' }),
    ])
    await renderPage()
    expect(await screen.findByText('共 3 个通道，2 个运行中')).toBeInTheDocument()
  })
})

describe('AiChannelsPage 停止语义', () => {
  beforeEach(() => reseed([]))
  it('手动停止的通道显示"服务重启后保持"', async () => {
    const ch = makeChannel('c1', { state: 'idle' })
    ch.config = { ...ch.config, manually_stopped: true }
    reseed([ch])
    await renderPage()
    expect(await screen.findByTestId('ai-card-manual-stop')).toHaveTextContent('服务重启后保持')
  })
  it('出错通道停止后同样显示已停止重试', async () => {
    const ch = makeChannel('c1', { state: 'error' })
    ch.config = { ...ch.config, manually_stopped: true }
    reseed([ch])
    await renderPage()
    expect(await screen.findByTestId('ai-card-manual-stop')).toBeInTheDocument()
  })
  it('出错通道可以停止（终止反复重试）', async () => {
    const user = userEvent.setup()
    reseed([makeChannel('c1', { state: 'error' })])
    await renderPage()
    await user.click(await screen.findByLabelText('更多操作'))
    expect(screen.getByText('停止')).toBeInTheDocument()
  })
})
