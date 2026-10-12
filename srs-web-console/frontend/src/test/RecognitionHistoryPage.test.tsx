import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { aiChannelService, createMockAiChannelService } from '@/api/aiChannelService'
import type { AiChannel } from '@/types/aiChannel'
import type { SnapshotItem, SnapshotOverview, SnapshotPage } from '@/types/snapshot'

const mockGetOverview = vi.fn()
const mockListPage = vi.fn()
const mockDeleteRange = vi.fn()
const mockClearAll = vi.fn()
vi.mock('@/api/snapshotService', () => ({
  snapshotService: {
    getOverview: (...args: unknown[]) => mockGetOverview(...args),
    listPage: (...args: unknown[]) => mockListPage(...args),
    getImageBlob: vi.fn().mockResolvedValue(null),
    deleteOne: vi.fn(),
    deleteRange: (...args: unknown[]) => mockDeleteRange(...args),
    clearAll: (...args: unknown[]) => mockClearAll(...args),
  },
}))

import RecognitionHistoryPage from '@/pages/RecognitionHistory'

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

function makeOverview(overrides: Partial<SnapshotOverview> = {}): SnapshotOverview {
  return {
    enabled: true, connected: true, last_error: null, count: 50, max_count: 10000, storage_bytes: 2048,
    earliest_timestamp: 1000, latest_timestamp: 2000,
    ...overrides,
  }
}

function makeItem(channelId: string, imageId: string): SnapshotItem {
  return {
    image_id: imageId, channel_id: channelId, channel_name: channelId,
    frame_pts_ns: 1000, timestamp: 1700000000, model_name: 'scrfd_10g_kps', task_type: 'face_detection',
    class_id: 0, class_name: 'face', confidence: 0.9,
    bbox: { x: 0, y: 0, w: 10, h: 10 }, landmarks: null, image_width: 20, image_height: 20, enhanced: false,
  }
}

function reseed(seed: AiChannel[] = []) {
  Object.assign(aiChannelService, createMockAiChannelService(seed))
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/recognition-history', element: <RecognitionHistoryPage /> },
      { path: '/recognition-history/:channelId', element: <RecognitionHistoryPage /> },
    ],
    { initialEntries: [path] },
  )
  const utils = render(<RouterProvider router={router} />)
  return { ...utils, router }
}

beforeEach(() => {
  mockGetOverview.mockReset()
  mockListPage.mockReset()
  mockDeleteRange.mockReset()
  mockClearAll.mockReset()
  mockGetOverview.mockResolvedValue(null)
  mockListPage.mockResolvedValue({ items: [], next_cursor: null } as SnapshotPage)
  // 时间范围弹窗内部用 WheelColumn（时/分/秒滚轮）渲染，挂载就会调
  // scrollTo 对齐位置——jsdom 没有真实滚动实现，桩掉即可。
  Element.prototype.scrollTo = vi.fn()
})

describe('RecognitionHistoryPage —— 热切换归档', () => {
  it('每通道开关只更新归档，关闭后仍显示已有历史和计数', async () => {
    reseed([makeChannel('cam01'), makeChannel('cam02')])
    let enabled = true
    mockGetOverview.mockImplementation((id: string) => Promise.resolve(makeOverview({ enabled: id === 'cam01' ? enabled : true })))
    mockListPage.mockResolvedValue({ items: [makeItem('cam01', 'old-image')], next_cursor: null })
    const updateSpy = vi.spyOn(aiChannelService, 'update').mockImplementation(async () => {
      enabled = false
      return { applied: true, applied_via: 'hot', channel: makeChannel('cam01'), hot_fields: ['snapshot'], restart: null }
    })
    renderAt('/recognition-history/cam01')
    const toggle = await screen.findByRole('switch', { name: '「cam01」识别历史归档' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(toggle)
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('cam01', { snapshot: { enabled: false } }))
    expect(await screen.findByText(/归档已关闭：不再截取/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '「cam01」识别历史归档' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: '「cam02」识别历史归档' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText('去开启归档')).not.toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
  })
  it('保存期间禁止重复切换，失败后保留真实开关状态并允许重试', async () => {
    reseed([makeChannel('cam01')])
    mockGetOverview.mockResolvedValue(makeOverview())
    let rejectSave!: (error: Error) => void
    const save = new Promise<never>((_, reject) => { rejectSave = reject })
    const updateSpy = vi.spyOn(aiChannelService, 'update').mockReturnValue(save)
    renderAt('/recognition-history/cam01')
    const toggle = await screen.findByRole('switch', { name: '「cam01」识别历史归档' })
    await userEvent.click(toggle)
    expect(toggle).toBeDisabled()
    await userEvent.click(toggle)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    await act(async () => { rejectSave(new Error('保存失败')); await save.catch(() => {}) })
    expect(toggle).not.toBeDisabled()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })
})

describe('RecognitionHistoryPage —— 左侧通道列表', () => {
  it.each([
    ['channel_deleting', '正在删除'],
    ['service_stopping', '正在停止'],
    ['unavailable', '暂不可用'],
  ] as const)('归档器不可用原因 %s 不误报为数据库故障', async (reason, wording) => {
    reseed([makeChannel('cam01')])
    mockGetOverview.mockResolvedValue(makeOverview({ connected: false, reason, last_error: null }))
    renderAt('/recognition-history/cam01')
    expect(await screen.findByText(wording)).toBeInTheDocument()
    expect(screen.getAllByRole('status').some(element => element.textContent?.includes(wording))).toBe(true)
    expect(screen.queryByText('连接失败')).not.toBeInTheDocument()
    expect(screen.queryByText(/数据库连接中断/)).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '「cam01」识别历史归档' })).toHaveAttribute('aria-checked', 'true')
  })
  it('积压与未保存截图明确显示，不能伪装归档正常', async () => {
    reseed([makeChannel('cam01')])
    mockGetOverview.mockResolvedValue(makeOverview({
      archive_stats: { backpressured: true, queue_depth: 64, dropped_count: 2, write_error_count: 1,
        healthy: false, faults: [{ stage: "capture", message: "download unavailable", duration_seconds: 31 }],
        delivery: { accepted: 100, committed: 33, outstanding: 64, quarantined: 3, deleted: 0,
          oldest_wait_seconds: 2.1, stages: { queued: 64 } } },
    }))
    renderAt('/recognition-history/cam01')
    expect(await screen.findByText(/归档处理积压，已降低本通道识别速度/)).toBeInTheDocument()
    expect(screen.getByText(/归档异常（截图，持续 31 秒）/)).toHaveTextContent("暂时无法获取截图")
    expect(screen.getByText(/本次运行有 2 个目标截图未保存/)).toBeInTheDocument()
    expect(screen.getByText(/本次归档接收 100 个目标/)).toBeInTheDocument()
    expect(screen.getByText(/有 3 个目标处理失败/)).toBeInTheDocument()
  })
  it('渲染通道列表，展示开启/未开启状态', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' }), makeChannel('cam02', { name: '后门摄像头' })])
    mockGetOverview.mockImplementation((id: string) =>
      Promise.resolve(id === 'cam01' ? makeOverview({ enabled: true, count: 5, max_count: 100 }) : makeOverview({ enabled: false })),
    )
    renderAt('/recognition-history')

    expect(await screen.findByText('大门摄像头')).toBeInTheDocument()
    expect(screen.getByText('后门摄像头')).toBeInTheDocument()
    expect(screen.getByText('5/100')).toBeInTheDocument()
    expect(screen.getByText('已关闭')).toBeInTheDocument()
  })

  it('没有配置任何通道时展示提示，不是空白', async () => {
    reseed([])
    renderAt('/recognition-history')
    expect(await screen.findByText('选择左侧通道查看识别历史')).toBeInTheDocument()
    expect(await screen.findByText('还没有配置任何 AI 通道')).toBeInTheDocument()
  })

  it('进入页面默认自动选中第一个通道，不用手动点', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' }), makeChannel('cam02', { name: '后门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview({ count: 0 }))
    const { router } = renderAt('/recognition-history')

    await waitFor(() => expect(router.state.location.pathname).toBe('/recognition-history/cam01'))
    expect(await screen.findByRole('heading', { name: '大门摄像头' })).toBeInTheDocument()
    // 回归锁：默认范围必须是"播种"进初始 state，不是空范围 mount 后再靠
    // effect 补一次——否则这里会先以空范围 fetch 一次，range 变化后再
    // fetch 一次，变成 2 次而不是 1 次。
    await waitFor(() => expect(mockListPage).toHaveBeenCalledTimes(1))
  })

  it('点击通道后跳转到对应 URL 并展示详情', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' }), makeChannel('cam02', { name: '后门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview({ count: 0 }))
    const { router } = renderAt('/recognition-history')
    await screen.findByText('后门摄像头')
    await userEvent.click(screen.getByText('后门摄像头'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/recognition-history/cam02'))
  })
})

describe('RecognitionHistoryPage —— 授权未就绪', () => {
  it('授权通过后下一轮自动轮询重新加载历史，无需刷新或启动通道', async () => {
    vi.useFakeTimers()
    try {
      reseed([makeChannel('cam01')])
      mockGetOverview.mockResolvedValue(makeOverview({ connected: false, reason: 'license_pending' }))
      renderAt('/recognition-history/cam01')
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(screen.getByText('等待授权')).toBeInTheDocument()
      mockListPage.mockClear()
      mockGetOverview.mockResolvedValue(makeOverview())
      mockListPage.mockResolvedValue({ items: [makeItem('cam01', 'after-license')], next_cursor: null })
      const start = vi.spyOn(aiChannelService, 'start')
      await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
      expect(mockListPage).toHaveBeenCalled()
      expect(screen.queryByText('等待授权')).not.toBeInTheDocument()
      expect(screen.getByText('已加载全部记录')).toBeInTheDocument()
      expect(start).not.toHaveBeenCalled()
      start.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })
  it('服务刚重启、授权未放行时明确提示等待授权，不误报数据库连接失败', async () => {
    reseed([makeChannel('cam01', { name: '大门口' })])
    mockGetOverview.mockResolvedValue(makeOverview({ enabled: true, connected: false, count: 0,
      reason: 'license_pending', last_error: '授权未就绪，暂时无法访问识别历史' }))
    renderAt('/recognition-history/cam01')
    expect(await screen.findByText('等待授权')).toBeInTheDocument()
    expect(screen.getByText(/正在等待设备授权/)).toBeInTheDocument()
    expect(screen.queryByText('连接失败')).not.toBeInTheDocument()
    expect(screen.queryByText(/数据库连接中断/)).not.toBeInTheDocument()
  })
})

describe('RecognitionHistoryPage —— 未开启通道', () => {
  it('关闭状态可热开启，只更新对应通道 enabled', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview({ enabled: false }))
    const updateSpy = vi.spyOn(aiChannelService, 'update')

    renderAt('/recognition-history/cam01')
    const toggle = await screen.findByRole('switch', { name: '「大门摄像头」识别历史归档' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(toggle)

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('cam01', { snapshot: { enabled: true } }))
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  })
})

describe('RecognitionHistoryPage —— 只读信息直接可见，设置收进弹窗', () => {
  it('主内容区直接显示数量/投影模式，不再常驻可编辑控件', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview({ count: 5, max_count: 100 }))
    renderAt('/recognition-history/cam01')

    expect(await screen.findByText('5 / 100 条')).toBeInTheDocument()
    expect(screen.getByText('不启用坐标转换')).toBeInTheDocument()
    // 投影模式此前是常驻页面的 <select>，现在只应该出现在设置弹窗里（未打开时不存在）
    expect(screen.queryByTestId('projection-mode-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('max-count-input')).not.toBeInTheDocument()
  })

  it('通道行悬停设置按钮——点击打开设置弹窗，改上限后保存调用 update', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview({ max_count: 10000 }))
    const updateSpy = vi.spyOn(aiChannelService, 'update')

    renderAt('/recognition-history/cam01')
    await userEvent.click(await screen.findByTestId('channel-settings-cam01'))

    const input = await screen.findByTestId('max-count-input')
    await userEvent.clear(input)
    await userEvent.type(input, '2000')
    await userEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('cam01', { snapshot: { max_count: 2000 } }))
  })

  it('设置弹窗里切换投影模式——保存调用 update 带 projection_mode', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview())
    const updateSpy = vi.spyOn(aiChannelService, 'update')

    renderAt('/recognition-history/cam01')
    await userEvent.click(await screen.findByTestId('channel-settings-cam01'))

    const select = await screen.findByTestId('projection-mode-select')
    await userEvent.selectOptions(select, 'erp_equirect')
    await userEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('cam01', { snapshot: { projection_mode: 'erp_equirect' } }))
  })

  it('设置弹窗危险区点击清空——弹出二次确认，输入"清空"后才调用 clearAll', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview({ count: 10 }))

    renderAt('/recognition-history/cam01')
    await userEvent.click(await screen.findByTestId('channel-settings-cam01'))
    await userEvent.click(await screen.findByTestId('open-clear-confirm'))

    // 设置弹窗应关闭，二次确认弹窗打开
    expect(screen.queryByTestId('settings-save')).not.toBeInTheDocument()
    expect(await screen.findByText(/清空「大门摄像头」的识别历史/)).toBeInTheDocument()

    await userEvent.type(screen.getByTestId('confirm-input'), '清空')
    await userEvent.click(screen.getByTestId('confirm-ok'))

    await waitFor(() => expect(mockClearAll).toHaveBeenCalledWith('cam01'))
    // 回归锁：之前这页没挂 <Toaster/>，toast.success 调用了但用户在页面上
    // 什么都看不到——只断言 mock 被调用测不出这个问题，必须断言真的渲染出来。
    expect(await screen.findByText('已清空')).toBeInTheDocument()
  })

  it('未选中该通道也能从列表直接悬停设置——不需要先点进详情', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' }), makeChannel('cam02', { name: '后门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview({ max_count: 10000 }))
    const updateSpy = vi.spyOn(aiChannelService, 'update')

    // 当前查看 cam01，但对 cam02 点设置
    renderAt('/recognition-history/cam01')
    await screen.findByText('后门摄像头')
    await userEvent.click(screen.getByTestId('channel-settings-cam02'))

    const input = await screen.findByTestId('max-count-input')
    await userEvent.clear(input)
    await userEvent.type(input, '3000')
    await userEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('cam02', { snapshot: { max_count: 3000 } }))
  })
})

describe('RecognitionHistoryPage —— channelId 切换的分页重置（回归）', () => {
  it('上一个通道已翻到底之后切到新通道，新通道的第一页必须正常加载', async () => {
    reseed([makeChannel('cam01', { name: 'A馆' }), makeChannel('cam02', { name: 'B馆' })])
    mockGetOverview.mockResolvedValue(makeOverview())
    mockListPage.mockImplementation((channelId: string) => {
      if (channelId === 'cam01') return Promise.resolve({ items: [makeItem('cam01', 'a1')], next_cursor: null })
      if (channelId === 'cam02') return Promise.resolve({ items: [makeItem('cam02', 'b1')], next_cursor: null })
      return Promise.resolve({ items: [], next_cursor: null })
    })

    const { router } = renderAt('/recognition-history/cam01')
    await waitFor(() => expect(screen.getByText('已加载全部记录')).toBeInTheDocument())

    await act(async () => {
      await router.navigate('/recognition-history/cam02')
    })

    // 默认时间范围（最近 10 分钟）从进页面起就一直生效，切通道不清空它——
    // 这里不再是空过滤 {}，而是带着 fromTs/toTs 的默认范围。
    await waitFor(() => {
      const call = mockListPage.mock.calls.find((c) => c[0] === 'cam02')
      expect(call).toBeTruthy()
      expect(call?.[1]).toBeNull()
      expect(call?.[2]).toBe(20)
      expect(call?.[3]).toHaveProperty('fromTs')
      expect(call?.[3]).toHaveProperty('toTs')
    })
  })
})

describe('RecognitionHistoryPage —— 默认最近 10 分钟', () => {
  it('进入页面即默认选中"10分"预设并显示选中态，范围约等于最近 10 分钟，只发一次搜索', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview())

    renderAt('/recognition-history/cam01')

    expect(await screen.findByRole('button', { name: '10分' })).toHaveAttribute('aria-pressed', 'true')

    await waitFor(() => expect(mockListPage).toHaveBeenCalledTimes(1))
    const filters = mockListPage.mock.calls[0]?.[3]
    expect(filters).toHaveProperty('fromTs')
    expect(filters).toHaveProperty('toTs')
    // 10 分钟 = 600 秒，留一点执行耗时的容差
    expect(filters.toTs - filters.fromTs).toBeGreaterThan(595)
    expect(filters.toTs - filters.fromTs).toBeLessThan(610)
  })
})

describe('RecognitionHistoryPage —— 时间范围快捷按钮 + 置信度筛选', () => {
  it('点击"时"快捷按钮——切换选中态，且带着这个范围重新搜索', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview())

    renderAt('/recognition-history/cam01')
    await screen.findByRole('button', { name: '10分' })
    mockListPage.mockClear()
    await userEvent.click(screen.getByRole('button', { name: '时' }))

    expect(screen.getByRole('button', { name: '时' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '10分' })).toHaveAttribute('aria-pressed', 'false')

    await waitFor(() => {
      const lastCall = mockListPage.mock.calls.at(-1)
      expect(lastCall?.[0]).toBe('cam01')
      expect(lastCall?.[3]).toHaveProperty('fromTs')
      expect(lastCall?.[3]).toHaveProperty('toTs')
    })
  })

  it('输入置信度下限——按 % 换算成 0-1 传给 listPage', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview())

    renderAt('/recognition-history/cam01')
    await userEvent.type(await screen.findByTestId('min-confidence-input'), '40')

    await waitFor(() => {
      const lastCall = mockListPage.mock.calls.at(-1)
      expect(lastCall?.[3]).toMatchObject({ minConfidence: 0.4 })
    })
  })

  it('置信度留空/0——不带 minConfidence 参数（不过滤），但默认时间范围仍然带着', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview())

    renderAt('/recognition-history/cam01')
    await waitFor(() => {
      const lastCall = mockListPage.mock.calls.at(-1)
      expect(lastCall?.[3]).not.toHaveProperty('minConfidence')
      expect(lastCall?.[3]).toHaveProperty('fromTs')
    })
  })

  it('"清除筛选"仅在偏离默认状态时出现——点击后重置回最近 10 分钟默认值、清空置信度', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview())

    renderAt('/recognition-history/cam01')
    await screen.findByRole('button', { name: '10分' })
    expect(screen.queryByText('清除筛选')).not.toBeInTheDocument()

    await userEvent.type(screen.getByTestId('min-confidence-input'), '40')
    await userEvent.click(screen.getByRole('button', { name: '天' }))
    expect(await screen.findByText('清除筛选')).toBeInTheDocument()

    mockListPage.mockClear()
    await userEvent.click(screen.getByText('清除筛选'))

    expect((screen.getByTestId('min-confidence-input') as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('button', { name: '10分' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('清除筛选')).not.toBeInTheDocument()

    await waitFor(() => {
      const lastCall = mockListPage.mock.calls.at(-1)
      expect(lastCall?.[3]).not.toHaveProperty('minConfidence')
      expect(lastCall?.[3]).toHaveProperty('fromTs')
      expect(lastCall?.[3]).toHaveProperty('toTs')
    })
  })
})

describe('RecognitionHistoryPage —— 时间范围弹窗（统一走"范围变化触发搜索"）', () => {
  it('点击触发器打开弹窗，改动草稿后点确定——应用新范围、清除预设选中态、重新搜索', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview())

    renderAt('/recognition-history/cam01')
    await userEvent.click(await screen.findByTestId('range-trigger'))
    const fromPanel = await screen.findByTestId('range-picker-from')
    await userEvent.click(within(fromPanel).getByText('00:00'))

    mockListPage.mockClear()
    await userEvent.click(screen.getByTestId('range-picker-confirm'))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // 弹窗确定跟快捷按钮一样，都只通过 applyRange 这一条路径生效——
    // 但弹窗选的是自定义范围，不代表任何预设，"10分" 不该再显示选中。
    expect(screen.getByRole('button', { name: '10分' })).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(mockListPage).toHaveBeenCalled())
  })

  it('点击"取消"——关闭弹窗，不改变当前范围，不重新搜索', async () => {
    reseed([makeChannel('cam01', { name: '大门摄像头' })])
    mockGetOverview.mockResolvedValue(makeOverview())

    renderAt('/recognition-history/cam01')
    await userEvent.click(await screen.findByTestId('range-trigger'))
    await screen.findByRole('dialog')
    mockListPage.mockClear()
    await userEvent.click(screen.getByTestId('range-picker-cancel'))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '10分' })).toHaveAttribute('aria-pressed', 'true')
    expect(mockListPage).not.toHaveBeenCalled()
  })
})

describe('RecognitionHistoryPage —— 首页数据先于通道列表返回（回归）', () => {
  // 2026-09-23 生产复现：ai-service 换成 C++ 版后快照查询比"通道列表 + 逐个
  // 概览"两跳更快返回。列表容器（含滚动哨兵）要等 selected 就绪才渲染——
  // 首页数据到达时容器还没挂载，补屏拿不到容器、滚动哨兵也从未被观察，
  // 之后再也不会重新挂上，页面永远只显示第一页 20 条（"10 分钟只有 2 条"）。
  it('容器晚于首页数据挂载时，挂载后仍会继续加载下一页', async () => {
    reseed([makeChannel('cam01', { name: '大门口' })])
    let releaseOverview: () => void = () => {}
    mockGetOverview.mockImplementation(
      () => new Promise((resolve) => { releaseOverview = () => resolve(makeOverview()) }),
    )
    mockListPage.mockImplementation((_id: string, cursor: string | null) =>
      Promise.resolve(cursor == null
        ? { items: [makeItem('cam01', 'p1')], next_cursor: 'c1' }
        : { items: [makeItem('cam01', 'p2')], next_cursor: null }),
    )

    renderAt('/recognition-history/cam01')
    await waitFor(() => expect(mockListPage).toHaveBeenCalledTimes(1))
    await act(async () => { await Promise.resolve() })  // 首页数据已落 state，容器仍未挂载

    // 模拟通道服务自带延迟：等概览请求真正发出后再放行，否则放行是空操作
    await waitFor(() => expect(mockGetOverview).toHaveBeenCalled())
    await act(async () => { releaseOverview() })  // 通道列表就绪 → 容器挂载

    await waitFor(() => {
      expect(mockListPage.mock.calls.some((c) => c[1] === 'c1')).toBe(true)
    })
    expect(await screen.findByText('已加载全部记录')).toBeInTheDocument()
  })
})
