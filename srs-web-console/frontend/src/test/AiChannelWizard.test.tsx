import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { AiChannelWizard } from '@/pages/AiChannels/AiChannelWizard'
import type { AiChannel, AiStreamOption } from '@/types/aiChannel'
import type { ChannelWithStatus } from '@/types/channel'

describe('编辑向导在线状态', () => {
  it('首次编辑刷新在线流，同一通道轮询不会重复初始化', () => {
    const refresh = vi.fn()
    const initial = makeChannel()
    const props = baseProps({ mode: 'edit', initial, onRefreshStreams: refresh })
    const { rerender } = render(<AiChannelWizard {...props} />)
    expect(refresh).toHaveBeenCalledTimes(1)
    rerender(<AiChannelWizard {...props} initial={structuredClone(initial)} />)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('状态尚未获取或请求失败不能当成离线', () => {
    const props = baseProps({ mode: 'edit', initial: makeChannel(), streamsReady: false, streamsLoading: true,
      srsChannels: [makeSrsChannel('cam01', '大门', 'live', 'cam01')] })
    const { rerender } = render(<AiChannelWizard {...props} />)
    expect(screen.getAllByRole('option').some(x => x.textContent?.includes('状态加载中'))).toBe(true)
    expect(screen.getAllByRole('option').some(x => x.textContent?.includes('离线'))).toBe(false)
    rerender(<AiChannelWizard {...props} streamsLoading={false} streamsError="状态暂不可用" />)
    expect(screen.getByTestId('wizard-streams-error')).toHaveTextContent('状态暂不可用')
    expect(screen.getAllByRole('option').some(x => x.textContent?.includes('状态未知'))).toBe(true)
  })
})

function makeSrsChannel(id: string, name: string, app: string, stream: string, online = true): ChannelWithStatus {
  return {
    id,
    name,
    description: '',
    upstream: { protocol: 'rtmp', app, stream },
    downstream: { protocols: ['webrtc', 'flv', 'hls', 'rtmp'], primary: 'webrtc' },
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    status: {
      channelId: id,
      online,
      viewerCount: online ? 2 : 0,
      bitrateKbps: online ? 2000 : undefined,
      videoCodec: 'H264',
    },
  }
}

const defaultSrsChannels: ChannelWithStatus[] = [
  makeSrsChannel('ch-main', '大门口', 'live', 'phase6_test', true),
  makeSrsChannel('ch-back', '后门', 'live', 'back_door', true),
  makeSrsChannel('ch-offline', '仓库', 'live', 'warehouse', false),
  makeSrsChannel('ch-initial', '已登记默认输入', 'live', 'cam01', true),
  makeSrsChannel('ch-locked', '已登记锁定输入', 'live', 'src_stream', false),
]

function baseProps(overrides: Partial<ComponentProps<typeof AiChannelWizard>> = {}) {
  return {
    open: true,
    mode: 'create' as const,
    initial: null,
    submitting: false,
    streams: [] as AiStreamOption[],
    streamsLoading: false,
    srsChannels: defaultSrsChannels,
    onRefreshStreams: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeChannel(overrides: Partial<AiChannel['config']> = {}): AiChannel {
  return {
    id: 'cam01',
    name: '大门摄像头',
    state: 'running',
    config: {
      name: '大门摄像头', enabled: true,
      stream: { url: 'rtmp://127.0.0.1/live/cam01', protocol: 'rtmp', watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 } },
      inference_fps: 5, max_consecutive_failures: 10,
      model: { name: 'yolo26m', adapter: 'yolo26_trt', path: 'models/yolo26m_fp16.engine', input_size: [640, 640], stride: 32, provider: 'tensorrt', engine_cache: 'trt_engine_cache/', class_names: null },
      preprocess: { letterbox: true, padding_color: [114, 114, 114], interpolation: 'bilinear', normalize: true, mean: [0, 0, 0], std: [255, 255, 255], rgb_order: true, ai_sample_width: 0, ai_sample_height: 0 },
      postprocess: { conf_threshold: 0.3, iou_threshold: 0.5, max_detections: 200 },
      result_buffer: { max_frames: 20 },
      publish: { enabled: false, mode: 'passthrough_sei', rtmp_base: 'rtmp://127.0.0.1', target_url: null, watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 }, sei: { max_payload_bytes: 1024, match_window_ms: 0, format: 'json' }, osd: { stale_ms: 800, box_thickness: 2, font_scale: 0.5, box_color: [0, 255, 0, 255], text_color: [255, 255, 255, 255], landmark_color: [255, 0, 0, 255], landmark_radius: 3, draw_confidence: true, bitrate_kbps: 4000, iframe_interval: 30 }, effective_target_url: 'rtmp://127.0.0.1/live/cam01-ai' },
      snapshot: { enabled: false, max_count: 10000, min_interval_ms: 0, jpeg_quality: 82, max_crop_dimension: 320, padding_ratio: 0.25, projection_mode: 'none', brightness_enabled: false, brightness_target: 128, face_enhance_model: 'none', face_enhance_blend: 0.5 },
      ...overrides,
    },
    stats: {
      state: 'running', elapsed_seconds: 10, frame_count: 100, inference_count: 100, dropped_count: 0, consecutive_errors: 0, inference_fps_actual: 5,
      timing: { preprocess: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, inference: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, postprocess: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, total: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 } },
      result_buffer_size: 5,
    },
  }
}

// 工具：从第①步走下拉选择源流并到第②步
async function selectSourceAndNext(user: ReturnType<typeof userEvent.setup>, channelId = 'ch-main') {
  await user.selectOptions(screen.getByTestId('wizard-stream-select'), channelId)
  await user.click(screen.getByRole('button', { name: '下一步 →' }))
}

describe('AiChannelWizard', () => {
  it('同一通道状态刷新不能重置步骤、输出选择和未保存的配置', async () => {
    const user = userEvent.setup()
    const initial = makeChannel()
    initial.config.publish.enabled = true
    const output = makeSrsChannel('ch-ai', '大门AI输出', 'live', 'ai-n2q08c', false)
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const props = baseProps({ mode: 'edit', initial, srsChannels: [...defaultSrsChannels, output], onSubmit })
    const { rerender } = render(<AiChannelWizard {...props} />)
    await user.clear(screen.getByTestId('wizard-name'))
    await user.type(screen.getByTestId('wizard-name'), '用户修改的名称')
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    await user.selectOptions(screen.getByTestId('wizard-output-select'), output.id)

    // API 轮询会返回新对象；通道身份不变，编辑草稿必须保留。
    for (let i = 0; i < 3; i++) {
      const refreshed = structuredClone(initial)
      refreshed.stats.frame_count += i + 1
      rerender(<AiChannelWizard {...props} initial={refreshed} srsChannels={[...defaultSrsChannels, { ...output }]} />)
      expect(screen.getByTestId('wizard-output-select')).toHaveValue(output.id)
    }
    await user.click(screen.getByTestId('wizard-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      name: '用户修改的名称',
      publish: { target_url: 'rtmp://127.0.0.1:1935/live/ai-n2q08c' },
    })
  })

  it('关闭重开或切换通道时重新初始化，不能沿用另一份编辑草稿', async () => {
    const user = userEvent.setup()
    const initial = makeChannel()
    const props = baseProps({ mode: 'edit', initial })
    const { rerender } = render(<AiChannelWizard {...props} />)
    await user.clear(screen.getByTestId('wizard-name'))
    await user.type(screen.getByTestId('wizard-name'), '未保存的名称')
    rerender(<AiChannelWizard {...props} open={false} />)
    rerender(<AiChannelWizard {...props} />)
    expect(screen.getByTestId('wizard-name')).toHaveValue(initial.config.name)
    const other = makeChannel({ name: '另一通道' })
    other.id = 'cam02'
    other.name = '另一通道'
    rerender(<AiChannelWizard {...props} initial={other} />)
    expect(screen.getByTestId('wizard-name')).toHaveValue('另一通道')
  })

  it('大门：空输出报错后选择已有 AI 输出，保存指定地址并清除旧错误', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const initial = makeChannel()
    initial.id = '2baec0a3-9941-47dc-b1bd-d3d284488097'
    initial.name = '大门'
    initial.config.stream.url = 'rtmp://127.0.0.1:1935/live/xm'
    initial.config.publish.enabled = true
    initial.config.publish.target_url = null
    const outputId = '0d997979-1920-44c7-beee-57f22b521f68'
    render(<AiChannelWizard {...baseProps({
      mode: 'edit', initial, onSubmit,
      srsChannels: [
        makeSrsChannel(initial.id, '大门', 'live', 'xm'),
        makeSrsChannel(outputId, '大门AI输出', 'live', 'ai-n2q08c', false),
      ],
    })} />)
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    expect(screen.getByRole('option', { name: /大门（live\/xm）/ })).toBeDisabled()
    await user.click(screen.getByTestId('wizard-submit'))
    expect(await screen.findByText(/请选择接入管理中的输入和输出 SRS 通道/)).toBeInTheDocument()
    await user.selectOptions(screen.getByTestId('wizard-output-select'), outputId)
    expect(screen.queryByText(/请选择接入管理中的输入和输出 SRS 通道/)).not.toBeInTheDocument()
    await user.click(screen.getByTestId('wizard-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0].publish).toMatchObject({
      enabled: true, target_url: 'rtmp://127.0.0.1:1935/live/ai-n2q08c',
    })
  })

  it('旧未登记输出保留显示且不能保存，选择接入管理通道后可保存', async () => {
    const user = userEvent.setup(); const onSubmit = vi.fn().mockResolvedValue(undefined)
    const initial = makeChannel(); initial.config.publish.enabled = true
    initial.config.publish.target_url = 'rtmp://127.0.0.1:1935/live/unregistered'
    render(<AiChannelWizard {...baseProps({ mode: 'edit', initial, onSubmit })} />)
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    expect(screen.getByTestId('wizard-output-select')).toHaveValue('')
    expect(screen.queryByTestId('wizard-publish-url')).not.toBeInTheDocument()
    expect(screen.queryByText('新建输出通道')).not.toBeInTheDocument()
    expect(screen.getByText(/当前输出地址未登记/)).toBeInTheDocument()
    expect(screen.getByText('推流目标：rtmp://127.0.0.1:1935/live/unregistered')).toBeInTheDocument()
    await user.click(screen.getByTestId('wizard-submit'))
    expect(onSubmit).not.toHaveBeenCalled()
    await user.selectOptions(screen.getByTestId('wizard-output-select'), 'ch-offline')
    await user.click(screen.getByTestId('wizard-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0].publish).toMatchObject({enabled: true, target_url: 'rtmp://127.0.0.1:1935/live/warehouse'})
  })

  it('编辑：缺少输出的提示在选择有效输出后清除，保存所选通道地址', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const initial = makeChannel()
    const props = baseProps({ mode: 'edit', initial, onSubmit })
    const { rerender } = render(<AiChannelWizard {...props} />)
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    expect(screen.getByTestId('wizard-output-select')).toHaveValue('')
    expect(screen.getByText('请选择接入管理中的输出 SRS 通道。')).toBeInTheDocument()
    await user.click(screen.getByTestId('wizard-submit'))
    expect(await screen.findByText(/请选择接入管理中的输入和输出 SRS 通道/)).toBeInTheDocument()
    await user.selectOptions(screen.getByTestId('wizard-output-select'), 'ch-offline')
    expect(screen.queryByText(/请选择接入管理中的输入和输出 SRS 通道/)).not.toBeInTheDocument()
    // 刷新通道状态不能覆盖用户已经选择的输出。
    rerender(<AiChannelWizard {...props} srsChannels={defaultSrsChannels.map((ch) => ({ ...ch }))} />)
    expect(screen.getByTestId('wizard-output-select')).toHaveValue('ch-offline')
    await user.click(screen.getByTestId('wizard-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0].publish).toMatchObject({
      enabled: true, target_url: 'rtmp://127.0.0.1:1935/live/warehouse',
    })
  })

  it('编辑 HTTP-FLV 源：匹配原始接入通道，改选 RTMP 时同时更新协议', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const initial = makeChannel()
    initial.config.stream.url = 'http://127.0.0.1:8080/live/phase6_test.flv?token=test'
    initial.config.stream.protocol = 'flv'
    render(<AiChannelWizard {...baseProps({ mode: 'edit', initial, onSubmit })} />)
    expect(screen.getByTestId('wizard-stream-select')).toHaveValue('ch-main')
    await user.selectOptions(screen.getByTestId('wizard-stream-select'), 'ch-main')
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    await user.selectOptions(screen.getByTestId('wizard-output-select'), 'ch-offline')
    await user.click(screen.getByTestId('wizard-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0].stream).toEqual({
      url: 'rtmp://127.0.0.1:1935/live/phase6_test', protocol: 'rtmp',
    })
  })

  it('open=false 时不渲染任何内容', () => {
    render(<AiChannelWizard {...baseProps({ open: false })} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('第①步：id 不合法时点击下一步被拦下，不进入第②步', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps()} />)
    await user.type(screen.getByTestId('wizard-id'), '带 空格')
    await selectSourceAndNext(user)
    expect(await screen.findByText(/ID 只能包含/)).toBeInTheDocument()
    expect(screen.getByTestId('wizard-id')).toBeInTheDocument() // 仍在第①步
  })

  it('第①步：源流地址为空时点击下一步报错', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps({ srsChannels: [] })} />)
    await user.type(screen.getByTestId('wizard-id'), 'cam01')
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    expect(await screen.findByText('请选择接入管理中的输入 SRS 通道')).toBeInTheDocument()
  })

  it('第①步：从 SRS 通道下拉选择源流，URL 正确回填', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps()} />)
    await user.selectOptions(screen.getByTestId('wizard-stream-select'), 'ch-main')
    expect(screen.getByTestId('wizard-stream-url-display')).toHaveTextContent('rtmp://')
    expect(screen.getByTestId('wizard-stream-url-display')).toHaveTextContent('phase6_test')
  })

  it('第①步：下拉里展示了多个 SRS 通道选项', () => {
    render(<AiChannelWizard {...baseProps()} />)
    const select = screen.getByTestId('wizard-stream-select') as HTMLSelectElement
    // jsdom 下 option.textContent 不可靠，直接用 option 数量判断
    expect(select.options.length).toBe(defaultSrsChannels.length + 1) // 3 个 mock 通道 + 1 个禁用默认提示项
  })

  it('输入只提供接入管理通道选择，不提供手动地址', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps()} />)
    expect(screen.queryByTestId('wizard-stream-url')).not.toBeInTheDocument()
    expect(screen.queryByText('通道不在列表？手动输入')).not.toBeInTheDocument()
    await user.type(screen.getByTestId('wizard-id'), 'processor')
    await user.selectOptions(screen.getByTestId('wizard-stream-select'), 'ch-main')
    await user.click(screen.getByRole('button', {name: '下一步 →'}))
    expect(screen.getByTestId('wizard-model-select')).toBeInTheDocument()
  })

  describe('H.265 源提示按 ai-service 能力说话（设计 §8.4③）', () => {
    const streams: AiStreamOption[] = [{ app: 'live', name: 'phase6_test', clients: 1, bitrateKbps: 2000, videoCodec: 'HEVC', h265: true }]

    it('ai-service 声明支持 → 信息提示"AI 输出同为 H.265"，不再是告警', async () => {
      const user = userEvent.setup()
      render(<AiChannelWizard {...baseProps({ streams, aiCapabilities: { h265: true, enhanced: true } })} />)
      await user.selectOptions(screen.getByTestId('wizard-stream-select'), 'ch-main')
      expect(await screen.findByTestId('wizard-h265-note')).toHaveTextContent('AI 输出同为 H.265')
      expect(screen.queryByText(/疑似/)).not.toBeInTheDocument()
    })

    it('旧版 ai-service（不支持）→ 保留警告并说明要升级', async () => {
      const user = userEvent.setup()
      render(<AiChannelWizard {...baseProps({ streams, aiCapabilities: { h265: false, enhanced: false } })} />)
      await user.selectOptions(screen.getByTestId('wizard-stream-select'), 'ch-main')
      expect(await screen.findByTestId('wizard-h265-note')).toHaveTextContent('不支持 H.265 源')
    })

    it('能力未知（AI 服务不可达）→ 中性说明，不下结论', async () => {
      const user = userEvent.setup()
      render(<AiChannelWizard {...baseProps({ streams, aiCapabilities: null })} />)
      await user.selectOptions(screen.getByTestId('wizard-stream-select'), 'ch-main')
      expect(await screen.findByTestId('wizard-h265-note')).toHaveTextContent('尚未读取到 AI 服务能力')
    })

    it('编辑模式：按 ai-service 实测源编码显示提示（不再固定为 H.264）', () => {
      const ch = makeChannel()
      ch.stats.video_codec = 'h265'
      render(<AiChannelWizard {...baseProps({ mode: 'edit', initial: ch, aiCapabilities: { h265: true, enhanced: true } })} />)
      expect(screen.getByTestId('wizard-h265-note')).toHaveTextContent('AI 输出同为 H.265')
    })
  })

  it('第②步：模型下拉切换后 value 正确更新', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps()} />)
    await selectSourceAndNext(user)

    const select = await screen.findByTestId('wizard-model-select') as HTMLSelectElement
    await user.selectOptions(select, 'yolo26x-face')
    expect(select.value).toBe('yolo26x-face')
  })

  it('回归：第②步推理帧率非法值会拦下"下一步"，不再放任一路到后端才报错', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps()} />)
    await selectSourceAndNext(user)

    // 负数用 fireEvent.change 一次性设完整值（jsdom 下 type 逐键不可靠）
    const fpsInput = await screen.findByDisplayValue('5')
    fireEvent.change(fpsInput, { target: { value: '-1' } })
    await user.click(screen.getByRole('button', { name: '下一步 →' }))

    expect(await screen.findByText(/推理帧率必须在 0-30 之间/)).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-model-select')).toBeInTheDocument() // 仍停在第②步没跳走
  })

  it('第③步：yolo26m 预设不展示 IoU 阈值（端到端 NMS 内嵌）', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps()} />)
    await selectSourceAndNext(user)
    await user.click(await screen.findByRole('button', { name: '下一步 →' }))

    expect(screen.getByText(/置信度阈值/)).toBeInTheDocument()
    expect(screen.queryByText(/IoU 阈值/)).not.toBeInTheDocument()
  })

  it('第②步：固定类别和动态描述分开选择，仅开放已接入模型', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps()} />)
    await selectSourceAndNext(user)
    const types = screen.getByRole('combobox', { name: '模型类型' }) as HTMLSelectElement
    expect(Array.from(types.options, option => option.value)).toEqual(['closed', 'open'])
    const models = screen.getByTestId('wizard-model-select') as HTMLSelectElement
    expect(Array.from(models.options, option => option.value)).toEqual(['yolo26x', 'yolo26x-face'])
    expect(screen.queryByLabelText('识别描述')).not.toBeInTheDocument()
    await user.selectOptions(types, 'open')
    expect(Array.from(models.options).filter(option => !option.disabled).map(option => option.value)).toEqual(['yoloe-26x', 'yoloe-26x-32', 'locateanything-3b'])
    expect(Array.from(models.options).find(option => option.value === 'yoloe-26x-32')).toHaveProperty('disabled', false)
    expect(screen.getByLabelText('识别描述 1')).toBeInTheDocument()
    expect(screen.getByLabelText('标签 ID 1')).toBeInTheDocument()
    expect(screen.getByLabelText('标签名称 1')).toBeInTheDocument()
    expect(screen.getByText(/^每行一个识别类别，可同时检测多个目标/)).toBeInTheDocument()
  })

  it('未登记的旧 HTTP 输入不能进入模型步骤', async () => {
    const user = userEvent.setup(); const initial = makeChannel()
    initial.config.stream.url = 'http://external/not-registered.flv'; initial.config.stream.protocol = 'flv'
    render(<AiChannelWizard {...baseProps({mode: 'edit', initial})} />)
    await user.click(screen.getByRole('button', {name: '下一步 →'}))
    expect(screen.getByText('请选择接入管理中的输入 SRS 通道')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-model-select')).not.toBeInTheDocument()
  })

  it('第③步：选择已有输出通道，publishTargetUrl 正确回填', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps()} />)
    await selectSourceAndNext(user)
    await user.click(await screen.findByRole('button', { name: '下一步 →' }))

    // 开启推流
    // 从下拉选输出通道
    await user.selectOptions(screen.getByTestId('wizard-output-select'), 'ch-back')

    // 检查 URL 显示（用 getAllByText 因为 option 里也有 back_door 文本）
    const urlTexts = screen.getAllByText(/back_door/)
    expect(urlTexts.length).toBeGreaterThanOrEqual(1)
  })

  it('第③步：开启推流但未选输出通道时，提交被拦截', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps({ onSubmit, srsChannels: [defaultSrsChannels[0]!] })} />)
    await selectSourceAndNext(user, 'ch-main')
    await user.click(await screen.findByRole('button', { name: '下一步 →' }))

    // 开启推流，但不选输出

    await user.click(await screen.findByTestId('wizard-submit'))
    expect(await screen.findByText(/请选择接入管理中的输入和输出 SRS 通道/)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('AI 页面不创建 SRS 通道，输出必须从接入管理选择', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps()} />)
    await user.type(screen.getByTestId('wizard-id'), 'processor')
    await selectSourceAndNext(user)
    await user.click(screen.getByRole('button', {name: '下一步 →'}))
    expect(screen.getByTestId('wizard-output-select')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-create-output-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-publish-toggle')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', {name: '手动输入地址'})).not.toBeInTheDocument()
    expect(screen.getByText(/AI 处理器不会创建 SRS 通道/)).toBeInTheDocument()
  })

  it('提交成功后调用 onSubmit 并传入创建 patch', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps({ onSubmit })} />)
    await selectSourceAndNext(user)
    await user.click(await screen.findByRole('button', { name: '下一步 →' }))
    await user.selectOptions(screen.getByTestId('wizard-output-select'), 'ch-offline')
    await user.click(await screen.findByTestId('wizard-submit'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const patch = onSubmit.mock.calls[0]![0]
    expect(patch.stream.url).toContain('phase6_test')
  })

  it('第③步：提交的 patch 不再带 publish.mode 字段（osd_encode 模式已下线，没有可选项）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps({ onSubmit, srsChannels: defaultSrsChannels.slice(0, 2) })} />)
    await selectSourceAndNext(user, 'ch-main')
    await user.click(await screen.findByRole('button', { name: '下一步 →' }))

    // 打开推流开关并选一个输出通道（否则提交会被拦下）。输出不能选源流本身
    // （自己拉自己推是回环，向导会禁用该选项）。
    await user.selectOptions(screen.getByTestId('wizard-output-select'), 'ch-back')

    // 不再有模式单选（曾经的 wizard-publish-mode-passthrough/-osd 已随
    // osd_encode 一起下线）——识别结果叠加改成浏览器端渲染，见 AiPreviewModal。
    expect(screen.queryByTestId('wizard-publish-mode-passthrough')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-publish-mode-osd')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('wizard-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0].publish.mode).toBeUndefined()
  })

  it('提交失败时在当前步骤（弱映射）展示错误信息，不静默吞掉', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('通道已存在: cam01'))
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps({ onSubmit })} />)
    await selectSourceAndNext(user)
    await user.click(await screen.findByRole('button', { name: '下一步 →' }))
    await user.selectOptions(screen.getByTestId('wizard-output-select'), 'ch-offline')
    await user.click(await screen.findByTestId('wizard-submit'))

    expect(await screen.findByText('通道已存在: cam01')).toBeInTheDocument()
  })

  it('编辑模式：通道 ID 输入框禁用，其余字段从 initial 回填', async () => {
    render(<AiChannelWizard {...baseProps({ mode: 'edit', initial: makeChannel() })} />)
    expect(screen.getByTestId('wizard-id')).toBeDisabled()
    expect(screen.getByTestId('wizard-id')).toHaveValue('cam01')
    expect(screen.getByTestId('wizard-name')).toHaveValue('大门摄像头')
  })

  it('点击关闭按钮触发 onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps({ onClose })} />)
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('submitting=true 时提交按钮禁用并显示"保存中…"', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps({ submitting: true })} />)
    await selectSourceAndNext(user)
    await user.click(await screen.findByRole('button', { name: '下一步 →' }))

    const submitBtn = await screen.findByTestId('wizard-submit')
    expect(submitBtn).toBeDisabled()
    expect(submitBtn).toHaveTextContent('保存中…')
  })

  // ---- lockedSource 相关测试 ----

  it('lockedSource: 第①步源流显示为只读，不展示下拉', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps({
      lockedSource: {
        url: 'rtmp://host/live/src_stream',
        displayLabel: '大门口',
        online: true,
      },
    })} />)

    expect(screen.getByText('大门口')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-stream-url-display')).toHaveTextContent('rtmp://host/live/src_stream')
    // 不应该有下拉选择器
    expect(screen.queryByTestId('wizard-stream-select')).not.toBeInTheDocument()
    // 不应该有"手动输入"切换按钮
    expect(screen.queryByText(/通道不在列表/)).not.toBeInTheDocument()
    // 可以继续往下走（验证源流已被正确接受）
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    expect(await screen.findByTestId('wizard-model-select')).toBeInTheDocument()
  })

  it('lockedSource: 离线状态时不阻止向导前进', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps({
      lockedSource: {
        url: 'rtmp://host/live/src_stream',
        displayLabel: '大门口',
        online: false,
      },
    })} />)

    // 离线源也能继续（AI 服务自己会重试重连）
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    expect(await screen.findByTestId('wizard-model-select')).toBeInTheDocument()
  })

  it('lockedSource: 预填名称和 ID（从源流名派生）', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...baseProps({
      lockedSource: {
        url: 'rtmp://host/live/phase6_test',
        displayLabel: '大门口',
        online: true,
      },
    })} />)

    // 名称默认是 "大门口_AI输出"
    const nameInput = screen.getByTestId('wizard-name') as HTMLInputElement
    expect(nameInput.value).toBe('大门口_AI输出')

    // 可以直接下一步到第②步
    await user.click(screen.getByRole('button', { name: '下一步 →' }))
    expect(await screen.findByTestId('wizard-model-select')).toBeInTheDocument()
  })

  it('lockedSource: h265 时按 ai-service 能力显示提示', () => {
    render(<AiChannelWizard {...baseProps({
      lockedSource: {
        url: 'rtmp://host/live/src',
        displayLabel: '大门',
        online: true,
        h265: true,
      },
      aiCapabilities: { h265: false, enhanced: false },
    })} />)

    expect(screen.getByTestId('wizard-h265-note')).toHaveTextContent('不支持 H.265 源')
  })

  it('竞态：编辑模式打开时 srsChannels 为空，列表到达后匹配已登记输入', async () => {
    // 模拟页面刚加载、SRS 通道列表还没到时就点开编辑向导
    const { rerender } = render(
      <AiChannelWizard
        {...baseProps({
          mode: 'edit',
          initial: makeChannel(),
          srsChannels: [],
        })}
      />,
    )
    // 列表未到时保留旧地址，不提供手动输入或隐式创建。
    expect(screen.queryByTestId('wizard-stream-url')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-stream-select')).not.toBeInTheDocument()

    // SRS 列表到达（包含源流 URL 匹配的通道）→ 自动切回下拉模式
    rerender(
      <AiChannelWizard
        {...baseProps({
          mode: 'edit',
          initial: makeChannel(),
          srsChannels: [
            makeSrsChannel('ch-cam01', '大门摄像头', 'live', 'cam01', true),
          ],
        })}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('wizard-stream-select')).toBeInTheDocument()
    })
    // 选中的就是匹配的那个通道
    const select = screen.getByTestId('wizard-stream-select') as HTMLSelectElement
    expect(select.value).toBe('ch-cam01')
  })

  it('接入管理列表刷新不会覆盖已明确选择的输入', async () => {
    const user = userEvent.setup(); const initial = makeChannel()
    const props = baseProps({mode: 'edit', initial})
    const {rerender} = render(<AiChannelWizard {...props} />)
    await user.selectOptions(screen.getByTestId('wizard-stream-select'), 'ch-main')
    rerender(<AiChannelWizard {...props} srsChannels={defaultSrsChannels.map(ch => ({...ch}))} />)
    expect(screen.getByTestId('wizard-stream-select')).toHaveValue('ch-main')
    expect(screen.queryByTestId('wizard-stream-url')).not.toBeInTheDocument()
  })
})
