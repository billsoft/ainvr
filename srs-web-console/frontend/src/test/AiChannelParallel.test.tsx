// 多个 AI 通道并行:输出流防冲突、源流地址取 ai-service 视角的 SRS、
// 通道卡片区分"抽帧跳过"与"过载丢帧"并在算力不足时告警。
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { AiChannelCard } from '@/pages/AiChannels/AiChannelCard'
import { AiChannelWizard } from '@/pages/AiChannels/AiChannelWizard'
import { DEFAULT_AI_RTMP_BASE, DEFAULT_WIZARD_VALUE, aiServiceRtmpBase, findOutputConflict, validateStep2 } from '@/features/aiChannelForm'
import type { AiChannel, AiChannelStats, AiStreamOption } from '@/types/aiChannel'
import type { ChannelWithStatus } from '@/types/channel'

function makeAi(id: string, src: string, out: string | null, statsOverrides: Partial<AiChannelStats> = {}): AiChannel {
  return {
    id,
    name: `${id}-名称`,
    state: 'running',
    config: {
      name: `${id}-名称`, enabled: true,
      stream: { url: src, protocol: 'rtmp', watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 } },
      inference_fps: 15, max_consecutive_failures: 10,
      model: { name: 'yolo26m', adapter: 'yolo26_trt', path: 'models/yolo26m_fp16.engine', input_size: [640, 640], stride: 32, provider: 'tensorrt', engine_cache: 'trt_engine_cache/', class_names: null },
      preprocess: { letterbox: true, padding_color: [114, 114, 114], interpolation: 'bilinear', normalize: true, mean: [0, 0, 0], std: [255, 255, 255], rgb_order: true, ai_sample_width: 0, ai_sample_height: 0 },
      postprocess: { conf_threshold: 0.3, iou_threshold: 0.5, max_detections: 200 },
      result_buffer: { max_frames: 20 },
      publish: { enabled: out !== null, mode: 'passthrough_sei', rtmp_base: 'rtmp://10.0.0.5:1935/', target_url: out, watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 }, sei: { max_payload_bytes: 1024, match_window_ms: 0, format: 'json' }, osd: { stale_ms: 800, box_thickness: 2, font_scale: 0.5, box_color: [0, 255, 0, 255], text_color: [255, 255, 255, 255], landmark_color: [255, 0, 0, 255], landmark_radius: 3, draw_confidence: true, bitrate_kbps: 4000, iframe_interval: 30 }, effective_target_url: out ?? '' },
      snapshot: { enabled: false, max_count: 10000, min_interval_ms: 0, jpeg_quality: 82, max_crop_dimension: 320, padding_ratio: 0.25, projection_mode: 'none', brightness_enabled: false, brightness_target: 128, face_enhance_model: 'none', face_enhance_blend: 0.5 },
    },
    stats: {
      state: 'running', elapsed_seconds: 100, frame_count: 3000, inference_count: 1500, dropped_count: 1500, consecutive_errors: 0, inference_fps_actual: 14.6,
      timing: { preprocess: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, inference: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, postprocess: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, total: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 40.9 } },
      result_buffer_size: 5,
      ...statsOverrides,
    },
  }
}

const existing = makeAi('door', 'rtmp://127.0.0.1:1935/live/cam1', 'rtmp://127.0.0.1:1935/live/cam1_ai')

describe('findOutputConflict', () => {
  const form = (streamUrl: string, publishTargetUrl: string, publishEnabled = true) =>
    ({ streamUrl, publishTargetUrl, publishEnabled })

  it('不同源、不同输出:无冲突', () => {
    expect(findOutputConflict(form('rtmp://h/live/cam1', 'rtmp://h/live/cam1_face'), [existing], null)).toBeNull()
  })

  it('输出与其它 AI 通道的输出相同(忽略 host/端口)→ 冲突并点名', () => {
    const msg = findOutputConflict(form('rtmp://h/live/cam2', 'rtmp://192.168.100.183/live/cam1_ai'), [existing], null)
    expect(msg).toMatch(/door-名称/)
  })

  it('输出等于自己的源流 → 回环', () => {
    expect(findOutputConflict(form('rtmp://h/live/cam9', 'rtmp://localhost:1935/live/cam9'), [], null)).toMatch(/回环/)
  })

  it('输出推进别的 AI 通道的源流 → 冲突', () => {
    expect(findOutputConflict(form('rtmp://h/live/cam2', 'rtmp://h/live/cam1'), [existing], null)).not.toBeNull()
  })

  it('源流选了别的 AI 通道的输出流 → 冲突', () => {
    expect(findOutputConflict(form('rtmp://h/live/cam1_ai', '', false), [existing], null)).not.toBeNull()
  })

  it('编辑自己:自己现有的输出不算冲突', () => {
    expect(findOutputConflict(form('rtmp://h/live/cam1', 'rtmp://h/live/cam1_ai'), [existing], 'door')).toBeNull()
  })
})

describe('aiServiceRtmpBase', () => {
  it('没有 AI 通道时用 ai-service 默认的本机 SRS', () => {
    expect(aiServiceRtmpBase([])).toBe(DEFAULT_AI_RTMP_BASE)
    expect(DEFAULT_AI_RTMP_BASE).toBe('rtmp://127.0.0.1:1935')
  })
  it('沿用已有通道实际在用的 rtmp_base(去掉末尾斜杠)', () => {
    expect(aiServiceRtmpBase([existing])).toBe('rtmp://10.0.0.5:1935')
  })
})

function makeSrs(id: string, name: string, stream: string): ChannelWithStatus {
  return {
    id, name, description: '',
    upstream: { protocol: 'rtmp', app: 'live', stream },
    downstream: { protocols: ['webrtc', 'flv', 'hls', 'rtmp'], primary: 'webrtc' },
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    status: { channelId: id, online: true, viewerCount: 0, videoCodec: 'H264' },
  }
}

const srs = [
  makeSrs('ch-cam1', '大门口', 'cam1'),
  makeSrs('ch-cam1-ai', '大门口_AI输出', 'cam1_ai'),
  makeSrs('ch-cam2', '后门', 'cam2'),
  makeSrs('ch-out-new', '后门_AI输出', 'cam2_ai'),
]

function props(overrides: Partial<ComponentProps<typeof AiChannelWizard>> = {}) {
  return {
    open: true, mode: 'create' as const, initial: null, submitting: false,
    streams: [] as AiStreamOption[], streamsLoading: false, srsChannels: srs,
    aiChannels: [existing],
    onRefreshStreams: vi.fn(), onClose: vi.fn(), onSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

async function toStep3(user: ReturnType<typeof userEvent.setup>, source = 'ch-cam2') {
  await user.selectOptions(screen.getByTestId('wizard-stream-select'), source)
  await user.click(screen.getByRole('button', { name: '下一步 →' }))
  await user.click(screen.getByRole('button', { name: '下一步 →' }))
  await user.click(screen.getByTestId('wizard-publish-toggle'))
}

describe('AiChannelWizard 并行防冲突', () => {
  it('源流地址用 ai-service 视角的 SRS(而不是浏览器地址栏的主机名)', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...props()} />)
    await user.selectOptions(screen.getByTestId('wizard-stream-select'), 'ch-cam2')
    expect(screen.getByTestId('wizard-stream-url-display')).toHaveTextContent('rtmp://10.0.0.5:1935/live/cam2')
  })

  it('源流下拉里,别的 AI 通道的输出流不可选', () => {
    render(<AiChannelWizard {...props()} />)
    const opt = screen.getByRole('option', { name: /大门口_AI输出/ }) as HTMLOptionElement
    expect(opt.disabled).toBe(true)
  })

  it('输出下拉里,已被占用 / 是别人源流 / 是自己源流的选项都不可选并注明原因', async () => {
    const user = userEvent.setup()
    render(<AiChannelWizard {...props()} />)
    await toStep3(user)
    const select = screen.getByTestId('wizard-output-select') as HTMLSelectElement
    const byValue = (v: string) => Array.from(select.options).find((o) => o.value === v)!
    expect(byValue('ch-cam1-ai').disabled).toBe(true)   // door 通道在推
    expect(byValue('ch-cam1').disabled).toBe(true)      // door 通道的源流
    expect(byValue('ch-cam2').disabled).toBe(true)      // 自己的源流
    expect(byValue('ch-out-new').disabled).toBe(false)
    expect(byValue('ch-cam1-ai').textContent).toMatch(/door-名称/)
  })

  it('输出下拉里,正在被推流(摄像头在线)且不是 AI 输出的流不可选', async () => {
    const user = userEvent.setup()
    const streams: AiStreamOption[] = [{ app: 'live', name: 'cam2_ai', clients: 1, bitrateKbps: 2000, videoCodec: 'H264', h265: false }]
    render(<AiChannelWizard {...props({ streams })} />)
    await toStep3(user)
    const select = screen.getByTestId('wizard-output-select') as HTMLSelectElement
    expect(Array.from(select.options).find((o) => o.value === 'ch-out-new')!.disabled).toBe(true)
  })

  it('手动填了冲突的输出地址:提交被拦下并显示原因', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<AiChannelWizard {...props({ onSubmit })} />)
    await toStep3(user)
    await user.click(screen.getByText('手动输入地址'))
    await user.type(screen.getByTestId('wizard-publish-url'), 'rtmp://127.0.0.1:1935/live/cam1_ai')
    await user.click(screen.getByTestId('wizard-submit'))
    expect(await screen.findByText(/door-名称/)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('AiChannelCard 抽帧与过载', () => {
  const noop = () => {}
  const cardProps = { disabled: false, onStart: noop, onStop: noop, onEdit: noop, onDelete: noop, onViewResult: noop, onPreview: noop }

  it('正常抽帧不再显示成"丢帧",并标注源帧率→推理帧率', () => {
    const ch = makeAi('door', 'rtmp://h/live/cam1', null, {
      sampled_skip_count: 1500, overload_drop_count: 0, source_fps: 30, inference_fps_target: 15, under_capacity: false,
    })
    render(<AiChannelCard channel={ch} {...cardProps} />)
    expect(screen.queryByText(/丢帧：1500/)).not.toBeInTheDocument()
    expect(screen.getByTestId('ai-card-frames')).toHaveTextContent('抽帧 1500')
    expect(screen.getByTestId('ai-card-frames')).toHaveTextContent('过载丢帧 0')
    expect(screen.getByTestId('ai-card-frames')).toHaveTextContent('源 30 → 推理 15 FPS')
    expect(screen.queryByTestId('ai-card-under-capacity')).not.toBeInTheDocument()
  })

  it('通道出错时显示原因(如模型输入尺寸与配置不符)', () => {
    const ch = { ...makeAi('door', 'rtmp://h/live/cam1', null, {
      last_error: '初始化失败: model.input_size 配置为 [320, 320],但模型实际输入是 [640, 640]',
    }), state: 'error' as const }
    render(<AiChannelCard channel={ch} {...cardProps} />)
    expect(screen.getByTestId('ai-card-last-error')).toHaveTextContent('[640, 640]')
  })

  it('运行中不显示残留错误', () => {
    const ch = makeAi('door', 'rtmp://h/live/cam1', null, { last_error: null })
    render(<AiChannelCard channel={ch} {...cardProps} />)
    expect(screen.queryByTestId('ai-card-last-error')).not.toBeInTheDocument()
  })

  it('处理速度不足时提示检查耗时，不臆测 GPU 已满载', () => {
    const ch = makeAi('door', 'rtmp://h/live/cam1', null, {
      inference_fps_actual: 9.1, sampled_skip_count: 1500, overload_drop_count: 800,
      source_fps: 30, inference_fps_target: 15, under_capacity: true,
    })
    render(<AiChannelCard channel={ch} {...cardProps} />)
    expect(screen.getByTestId('ai-card-under-capacity')).toHaveTextContent('处理速度未达到目标')
    expect(screen.getByTestId('ai-card-under-capacity')).toHaveTextContent('帧映射')
    expect(screen.getByTestId('ai-card-under-capacity')).not.toHaveTextContent('GPU 已跑满')
    expect(screen.getByTestId('ai-card-under-capacity')).toHaveTextContent('9.1')
  })

  it('旧版后端没有拆分字段时回退显示总跳帧数', () => {
    const ch = makeAi('door', 'rtmp://h/live/cam1', null)
    render(<AiChannelCard channel={ch} {...cardProps} />)
    expect(screen.getByTestId('ai-card-frames')).toHaveTextContent('跳帧 1500')
  })
})

describe('推理帧率下限(与 ai-service 校验一致)', () => {
  it('0 = 跟随源流合法,0 < fps < 0.1 拒绝(停通道要等 1/fps 秒)', () => {
    expect(validateStep2({ ...DEFAULT_WIZARD_VALUE, inferenceFps: 0 }).inferenceFps).toBeUndefined()
    expect(validateStep2({ ...DEFAULT_WIZARD_VALUE, inferenceFps: 0.1 }).inferenceFps).toBeUndefined()
    expect(validateStep2({ ...DEFAULT_WIZARD_VALUE, inferenceFps: 0.05 }).inferenceFps).toMatch(/0\.1/)
  })
})

describe('AiChannelCard H.265（设计 §8.4③）', () => {
  const noop = () => {}
  const cardProps = { disabled: false, onStart: noop, onStop: noop, onEdit: noop, onDelete: noop, onViewResult: noop, onPreview: noop }

  it('显示 ai-service 实测的源编码；H.264 与旧版（无字段）不出输入异常告警', () => {
    const { rerender } = render(<AiChannelCard channel={makeAi('a', 'rtmp://h/live/c', null, { video_codec: 'h265' })} {...cardProps} />)
    expect(screen.getByTestId('ai-card-codec')).toHaveTextContent('H.265')
    rerender(<AiChannelCard channel={makeAi('a', 'rtmp://h/live/c', null, { video_codec: 'h264' })} {...cardProps} />)
    expect(screen.getByTestId('ai-card-codec')).toHaveTextContent('H.264')
    rerender(<AiChannelCard channel={makeAi('a', 'rtmp://h/live/c', null)} {...cardProps} />)
    expect(screen.queryByTestId('ai-card-codec')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ai-card-demux')).not.toBeInTheDocument()
  })

  it('H.265 解封装丢帧/重同步、源含 B 帧时给出可操作的提示', () => {
    render(<AiChannelCard channel={makeAi('a', 'rtmp://h/live/c', null, {
      video_codec: 'h265', demux_dropped_frames: 12, demux_resyncs: 2, source_bframes: true,
    })} {...cardProps} />)
    expect(screen.getByTestId('ai-card-demux')).toHaveTextContent('已丢弃 12 帧、重同步 2 次')
    expect(screen.getByTestId('ai-card-bframes')).toHaveTextContent('关闭 B 帧')
  })
})
