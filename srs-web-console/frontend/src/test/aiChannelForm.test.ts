import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WIZARD_VALUE, applyModelPreset, fromChannel, generateChannelId,
  needsIouThreshold, toCreatePatch, toUpdatePatch, validatePublishRequiresRtmp,
  validateStep1, validateStep2, validateStep3,
  type AiWizardFormValue,
} from '@/features/aiChannelForm'
import type { AiChannel } from '@/types/aiChannel'
import { AI_MODEL_PRESETS, isOpenVocabularyPreset } from '@/types/aiChannel'

describe('动态提示词的高速开放词汇模型', () => {
  it('分类、预处理和标签配置支持用户定义的识别对象', () => {
    const v = { ...applyModelPreset(DEFAULT_WIZARD_VALUE, 'yoloe-26x'),
      description: 'backpack', labelId: 'bag', labelName: '行囊' }
    expect(isOpenVocabularyPreset('yoloe-26x')).toBe(true)
    expect(isOpenVocabularyPreset('locateanything-3b')).toBe(true)
    expect(isOpenVocabularyPreset('yolo26m')).toBe(false)
    expect(v.inferenceFps).toBe(5)
    expect(validateStep2(v)).toEqual({})
    const patch = toCreatePatch({ ...v, id: 'fast', streamUrl: 'rtmp://x/live/y' })
    expect(patch.model).toMatchObject({ adapter: 'yoloe_bpu', input_size: [640, 640],
      description: 'backpack', label_id: 'bag', label_name: '行囊',
      class_names: null })
    expect(patch.preprocess).toMatchObject({ letterbox: true, rgb_order: true,
      mean: [0, 0, 0], std: [255, 255, 255] })
    expect(AI_MODEL_PRESETS['yoloe-26x'].needsIouThreshold).toBe(true)
    expect(validateStep2({ ...v, description: 'red car' })).toEqual({})
  })
})


function makeChannel(overrides: Partial<AiChannel['config']> = {}): AiChannel {
  return {
    id: 'cam01',
    name: '大门摄像头',
    state: 'idle',
    config: {
      name: '大门摄像头', enabled: true,
      stream: { url: 'rtmp://127.0.0.1/live/cam01', protocol: 'rtmp', watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 } },
      inference_fps: 5, max_consecutive_failures: 10,
      model: { name: 'yolo26m', adapter: 'yolo26_trt', path: 'models/yolo26m_fp16.engine', input_size: [640, 640], stride: 32, provider: 'tensorrt', engine_cache: 'trt_engine_cache/', class_names: null },
      preprocess: { letterbox: true, padding_color: [114, 114, 114], interpolation: 'bilinear', normalize: true, mean: [0, 0, 0], std: [255, 255, 255], rgb_order: true, ai_sample_width: 0, ai_sample_height: 0 },
      postprocess: { conf_threshold: 0.3, iou_threshold: 0.5, max_detections: 200 },
      result_buffer: { max_frames: 20 },
      publish: { enabled: true, mode: 'passthrough_sei', rtmp_base: 'rtmp://127.0.0.1', target_url: 'rtmp://127.0.0.1/live/cam01-ai', watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 }, sei: { max_payload_bytes: 1024, match_window_ms: 0, format: 'json' }, osd: { stale_ms: 800, box_thickness: 2, font_scale: 0.5, box_color: [0, 255, 0, 255], text_color: [255, 255, 255, 255], landmark_color: [255, 0, 0, 255], landmark_radius: 3, draw_confidence: true, bitrate_kbps: 4000, iframe_interval: 30 }, effective_target_url: 'rtmp://127.0.0.1/live/cam01-ai' },
      snapshot: { enabled: false, max_count: 10000, min_interval_ms: 0, jpeg_quality: 82, max_crop_dimension: 320, padding_ratio: 0.25, projection_mode: 'none', brightness_enabled: false, brightness_target: 128, face_enhance_model: 'none', face_enhance_blend: 0.5 },
      ...overrides,
    },
    stats: {
      state: 'idle', elapsed_seconds: 0, frame_count: 0, inference_count: 0, dropped_count: 0, consecutive_errors: 0, inference_fps_actual: 0,
      timing: { preprocess: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, inference: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, postprocess: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 }, total: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 } },
      result_buffer_size: 0,
    },
  }
}

describe('generateChannelId', () => {
  it('从流名生成 slug + 随机后缀', () => {
    const id = generateChannelId('大门 Camera_01')
    expect(id).toMatch(/^camera_01-[a-z0-9]{4}$/)
  })

  it('slug 为空时回退 ch-xxxx', () => {
    const id = generateChannelId('摄像头')
    expect(id).toMatch(/^ch-[a-z0-9]{4}$/)
  })
})

describe('validateStep1', () => {
  const base: AiWizardFormValue = { ...DEFAULT_WIZARD_VALUE, id: 'cam01', streamUrl: 'rtmp://x/live/y' }

  it('创建模式下 id 不合法报错', () => {
    const errors = validateStep1({ ...base, id: '带 空格' }, true)
    expect(errors.id).toBeTruthy()
  })

  it('编辑模式下不校验 id（创建后不可改）', () => {
    const errors = validateStep1({ ...base, id: '带 空格' }, false)
    expect(errors.id).toBeUndefined()
  })

  it('名称超过 64 字报错', () => {
    const errors = validateStep1({ ...base, name: 'x'.repeat(65) }, true)
    expect(errors.name).toBeTruthy()
  })

  it('源流地址为空报错', () => {
    const errors = validateStep1({ ...base, streamUrl: '' }, true)
    expect(errors.streamUrl).toBeTruthy()
  })

  it('源流地址 scheme 不合法报错', () => {
    const errors = validateStep1({ ...base, streamUrl: 'ftp://x/y' }, true)
    expect(errors.streamUrl).toBeTruthy()
  })

  it('合法输入无错误', () => {
    const errors = validateStep1(base, true)
    expect(Object.keys(errors)).toHaveLength(0)
  })
})

describe('validateStep2（回归：此前第②③步完全没有前端数值校验）', () => {
  it('推理帧率超出 0-30 范围报错', () => {
    expect(validateStep2({ ...DEFAULT_WIZARD_VALUE, inferenceFps: -1 }).inferenceFps).toBeTruthy()
    expect(validateStep2({ ...DEFAULT_WIZARD_VALUE, inferenceFps: 31 }).inferenceFps).toBeTruthy()
  })

  it('合法范围内无错误', () => {
    expect(validateStep2({ ...DEFAULT_WIZARD_VALUE, inferenceFps: 0 })).toEqual({})
    expect(validateStep2({ ...DEFAULT_WIZARD_VALUE, inferenceFps: 30 })).toEqual({})
  })
})

describe('validateStep3（回归：此前第②③步完全没有前端数值校验）', () => {
  it('置信度阈值超出 0.01-0.95 范围报错', () => {
    expect(validateStep3({ ...DEFAULT_WIZARD_VALUE, confThreshold: 0 }).confThreshold).toBeTruthy()
    expect(validateStep3({ ...DEFAULT_WIZARD_VALUE, confThreshold: 1 }).confThreshold).toBeTruthy()
  })

  it('IoU 阈值只在需要外部 NMS 的模型（scrfd）上校验', () => {
    const badIou = { ...DEFAULT_WIZARD_VALUE, iouThreshold: 5 }
    expect(validateStep3({ ...badIou, modelPreset: 'yolo26m' }).iouThreshold).toBeUndefined()
    expect(validateStep3({ ...badIou, modelPreset: 'scrfd' }).iouThreshold).toBeTruthy()
  })

  it('最大检测数/结果缓冲帧数必须是范围内整数', () => {
    expect(validateStep3({ ...DEFAULT_WIZARD_VALUE, maxDetections: 0 }).maxDetections).toBeTruthy()
    expect(validateStep3({ ...DEFAULT_WIZARD_VALUE, maxDetections: 1.5 }).maxDetections).toBeTruthy()
    expect(validateStep3({ ...DEFAULT_WIZARD_VALUE, resultBufferMaxFrames: 301 }).resultBufferMaxFrames).toBeTruthy()
  })

  it('合法值无错误', () => {
    expect(validateStep3({ ...DEFAULT_WIZARD_VALUE, modelPreset: 'yolo26m' })).toEqual({})
  })
})

describe('validatePublishRequiresRtmp', () => {
  it('推流开启但源流非 rtmp:// 时报错', () => {
    const v: AiWizardFormValue = { ...DEFAULT_WIZARD_VALUE, publishEnabled: true, streamUrl: 'http://x/y.flv' }
    expect(validatePublishRequiresRtmp(v)).toMatch(/仅 RTMP 源/)
  })

  it('推流开启且源流是 rtmp:// 时通过', () => {
    const v: AiWizardFormValue = { ...DEFAULT_WIZARD_VALUE, publishEnabled: true, streamUrl: 'rtmp://x/live/y' }
    expect(validatePublishRequiresRtmp(v)).toBeNull()
  })

  it('判据只看协议，不看开关是否已勾选——前置校验必须在用户勾选前就生效', () => {
    const v: AiWizardFormValue = { ...DEFAULT_WIZARD_VALUE, publishEnabled: false, streamUrl: 'http://x/y.flv' }
    expect(validatePublishRequiresRtmp(v)).toMatch(/仅 RTMP 源/)
  })
})

describe('needsIouThreshold', () => {
  it('scrfd 需要外部 NMS，展示 IoU 阈值', () => {
    expect(needsIouThreshold('scrfd')).toBe(true)
  })

  it('yolo26m（yolo26_trt，端到端 NMS 内嵌）不需要', () => {
    expect(needsIouThreshold('yolo26m')).toBe(false)
  })
})

describe('模型预设原子性（D6）', () => {
  it('applyModelPreset 切换预设只改 modelPreset 字段本身', () => {
    const v = applyModelPreset(DEFAULT_WIZARD_VALUE, 'scrfd')
    expect(v.modelPreset).toBe('scrfd')
  })

  it('toCreatePatch: yolo26m 预设产出正确的 adapter + 归一化参数', () => {
    const patch = toCreatePatch({ ...DEFAULT_WIZARD_VALUE, id: 'cam01', streamUrl: 'rtmp://x/live/y', modelPreset: 'yolo26m' })
    expect(patch.model?.adapter).toBe('yolo26_bpu')
    expect(patch.preprocess?.mean).toEqual([0, 0, 0])
    expect(patch.preprocess?.std).toEqual([255, 255, 255])
  })

  it('toCreatePatch: scrfd 预设产出正确的 adapter + 归一化参数（不会混用 yolo26m 的参数）', () => {
    const patch = toCreatePatch({ ...DEFAULT_WIZARD_VALUE, id: 'cam01', streamUrl: 'rtmp://x/live/y', modelPreset: 'scrfd' })
    expect(patch.model?.adapter).toBe('scrfd_bpu')
    expect(patch.model?.class_names).toEqual(['face'])
    expect(patch.preprocess?.mean).toEqual([127.5, 127.5, 127.5])
    expect(patch.preprocess?.std).toEqual([128, 128, 128])
  })

  it('toUpdatePatch 与 toCreatePatch 对同一预设产出一致的 model/preprocess 字段', () => {
    const v: AiWizardFormValue = { ...DEFAULT_WIZARD_VALUE, id: 'cam01', streamUrl: 'rtmp://x/live/y', modelPreset: 'scrfd' }
    const createPatch = toCreatePatch(v)
    const updatePatch = toUpdatePatch(v, null)  // original=null 时返回完整 patch
    expect(updatePatch.model).toEqual(createPatch.model)
    expect(updatePatch.preprocess).toEqual(createPatch.preprocess)
  })

  it('返回的 input_size/class_names 是独立拷贝，不共享底层数组引用（避免多次调用互相污染）', () => {
    const v: AiWizardFormValue = { ...DEFAULT_WIZARD_VALUE, id: 'cam01', streamUrl: 'rtmp://x/live/y', modelPreset: 'scrfd' }
    const a = toCreatePatch(v)
    const b = toCreatePatch(v)
    expect(a.model?.input_size).not.toBe(b.model?.input_size)
    expect(a.model?.class_names).not.toBe(b.model?.class_names)
  })
})

describe('toCreatePatch/toUpdatePatch 字段组装', () => {
  it('名称为空时回退用 id 兜底', () => {
    const patch = toCreatePatch({ ...DEFAULT_WIZARD_VALUE, id: 'cam01', name: '  ', streamUrl: 'rtmp://x/live/y' })
    expect(patch.name).toBe('cam01')
  })

  it('推流目标地址为空串时序列化为 null（走 ai-service 默认派生名）', () => {
    const patch = toCreatePatch({ ...DEFAULT_WIZARD_VALUE, id: 'cam01', streamUrl: 'rtmp://x/live/y', publishEnabled: true, publishTargetUrl: '  ' })
    expect(patch.publish?.target_url).toBeNull()
  })

  it('postprocess/result_buffer 字段正确透传', () => {
    const patch = toCreatePatch({ ...DEFAULT_WIZARD_VALUE, id: 'cam01', streamUrl: 'rtmp://x/live/y', confThreshold: 0.4, iouThreshold: 0.6, maxDetections: 150, resultBufferMaxFrames: 45 })
    expect(patch.postprocess).toEqual({ conf_threshold: 0.4, iou_threshold: 0.6, max_detections: 150 })
    expect(patch.result_buffer).toEqual({ max_frames: 45 })
  })

  it('publish.mode 不再由前端产出（osd_encode 已下线，只剩 passthrough_sei 一种实现）', () => {
    const patch = toCreatePatch({ ...DEFAULT_WIZARD_VALUE, id: 'cam01', streamUrl: 'rtmp://x/live/y', publishEnabled: true })
    expect(patch.publish?.mode).toBeUndefined()
  })

})

describe('fromChannel 编辑回填往返', () => {
  it('yolo26_trt 通道回填出 yolo26m 预设', () => {
    const v = fromChannel(makeChannel())
    expect(v.modelPreset).toBe('yolo26m')
    expect(v.id).toBe('cam01')
    expect(v.streamUrl).toBe('rtmp://127.0.0.1/live/cam01')
    expect(v.streamProtocol).toBe('rtmp')
    expect(v.confThreshold).toBe(0.3)
    expect(v.iouThreshold).toBe(0.5)
    expect(v.maxDetections).toBe(200)
    expect(v.resultBufferMaxFrames).toBe(20)
    expect(v.publishEnabled).toBe(true)
    expect(v.publishTargetUrl).toBe('rtmp://127.0.0.1/live/cam01-ai')
  })

  it('scrfd_trt 通道回填出 scrfd 预设', () => {
    const ch = makeChannel({ model: { name: 'scrfd_10g_kps', adapter: 'scrfd_trt', path: 'models/scrfd_10g_kps.onnx', input_size: [640, 640], stride: 32, provider: 'tensorrt', engine_cache: 'trt_engine_cache/', class_names: ['face'] } })
    const v = fromChannel(ch)
    expect(v.modelPreset).toBe('scrfd')
  })

  it('回归：向导不认识的 adapter（yolo26_traditional）编辑时不碰模型也不能被保存改写', () => {
    const ch = makeChannel({
      model: { name: 'legacy', adapter: 'yolo26_traditional', path: 'models/legacy.onnx', input_size: [640, 640], stride: 32, provider: 'cpu', engine_cache: '', class_names: ['a', 'b'] },
    })
    const v = fromChannel(ch)
    expect(v.originalAdapter).toBe('yolo26_traditional')
    expect(v.modelPresetTouched).toBe(false)

    // 只改名字，完全不碰模型这一步
    const patch = toUpdatePatch({ ...v, name: '改个名字' }, ch)
    expect('model' in patch).toBe(false)
    expect('preprocess' in patch).toBe(false)
    expect(patch.name).toBe('改个名字')
    // 同时验证：stream/publish/postprocess/result_buffer 值没变也不发
    expect('stream' in patch).toBe(false)
    expect('publish' in patch).toBe(false)
    expect('postprocess' in patch).toBe(false)
    expect('result_buffer' in patch).toBe(false)
  })

  it('回归：向导不认识的 adapter，但用户这次显式点了模型卡片，则按用户选择走', () => {
    const ch = makeChannel({
      model: { name: 'legacy', adapter: 'yolo26_traditional', path: 'models/legacy.onnx', input_size: [640, 640], stride: 32, provider: 'cpu', engine_cache: '', class_names: ['a', 'b'] },
    })
    const v = applyModelPreset(fromChannel(ch), 'scrfd')
    expect(v.modelPresetTouched).toBe(true)

    const patch = toUpdatePatch(v, ch)
    expect(patch.model?.adapter).toBe('scrfd_bpu')
  })

  it('yolo26_trt/scrfd_trt 通道（向导本来就管的两种）编辑不碰模型且值没变时，不发 model/preprocess（diff 优化，避免误重启）', () => {
    const ch = makeChannel()
    const v = fromChannel(ch) // 默认 adapter: yolo26_trt
    const patch = toUpdatePatch(v, ch)
    // 值没变就不发，避免触发不必要的 restart
    expect('model' in patch).toBe(false)
    expect('preprocess' in patch).toBe(false)
  })

  it('target_url 为 null 时回填为空串（供输入框展示占位符）', () => {
    const ch = makeChannel({ publish: { enabled: false, mode: 'passthrough_sei', rtmp_base: 'rtmp://x', target_url: null, watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 }, sei: { max_payload_bytes: 1024, match_window_ms: 0, format: 'json' }, osd: { stale_ms: 800, box_thickness: 2, font_scale: 0.5, box_color: [0, 255, 0, 255], text_color: [255, 255, 255, 255], landmark_color: [255, 0, 0, 255], landmark_radius: 3, draw_confidence: true, bitrate_kbps: 4000, iframe_interval: 30 }, effective_target_url: 'rtmp://x/live/cam01-ai' } })
    const v = fromChannel(ch)
    expect(v.publishTargetUrl).toBe('')
    expect(v.publishEnabled).toBe(false)
  })

  it('publish 值没变时不发 publish（diff 优化，mode 不参与比较——前端已不产出这个字段）', () => {
    const ch = makeChannel({
      publish: {
        enabled: true, mode: 'passthrough_sei', rtmp_base: 'rtmp://127.0.0.1',
        target_url: 'rtmp://127.0.0.1/live/cam01-ai', watchdog_timeout_seconds: 5,
        reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 },
        sei: { max_payload_bytes: 1024, match_window_ms: 0, format: 'json' },
        osd: { stale_ms: 800, box_thickness: 2, font_scale: 0.5, box_color: [0, 255, 0, 255], text_color: [255, 255, 255, 255], landmark_color: [255, 0, 0, 255], landmark_radius: 3, draw_confidence: true, bitrate_kbps: 4000, iframe_interval: 30 },
        effective_target_url: 'rtmp://127.0.0.1/live/cam01-ai',
      },
    })
    const v = fromChannel(ch)
    // 值没变 → 不发 publish，避免误触发 restart
    const patch = toUpdatePatch(v, ch)
    expect('publish' in patch).toBe(false)
  })

  it('diff：只改 inference_fps 时只发 inference_fps（hot，不触发 restart）', () => {
    const ch = makeChannel()
    const v = fromChannel(ch)
    const patch = toUpdatePatch({ ...v, inferenceFps: 8 }, ch)
    // 只发变化的字段
    expect(Object.keys(patch).sort()).toEqual(['inference_fps'])
    expect(patch.inference_fps).toBe(8)
    // 确认 restart 级字段都没发
    expect('stream' in patch).toBe(false)
    expect('model' in patch).toBe(false)
    expect('publish' in patch).toBe(false)
    expect('name' in patch).toBe(false)
  })

  it('往返：fromChannel 再走 toUpdatePatch，值不变的字段不出现在 patch 里（diff 优化）', () => {
    const ch = makeChannel()
    const v = fromChannel(ch)
    const patch = toUpdatePatch(v, ch)
    // 所有字段都没变 → patch 应该为空（或只有 includeModelFields 导致的 model/preprocess，但值没变也应过滤）
    // 验证关键 restart 级字段确实没有
    expect('stream' in patch).toBe(false)
    expect('publish' in patch).toBe(false)
    expect('name' in patch).toBe(false)
  })
})

describe('H.265 源（设计 §8.4③）', () => {
  const withPublish = (extra: Record<string, unknown>) => {
    const ch = makeChannel()
    ch.config.publish = { ...ch.config.publish, ...extra }
    return ch
  }

  it('编辑回填：按 ai-service 实测的源编码判定 H.265，不再固定为 false', () => {
    const ch = makeChannel()
    ch.stats.video_codec = 'h265'
    expect(fromChannel(ch).h265).toBe(true)
    ch.stats.video_codec = 'h264'
    expect(fromChannel(ch).h265).toBe(false)
    delete ch.stats.video_codec // 旧版 ai-service
    expect(fromChannel(ch).h265).toBe(false)
  })

  it('输出封装默认 codec12，新建时不发该字段（兼容不认它的旧版 ai-service）', () => {
    const v = fromChannel(makeChannel())
    expect(v.publishFlvFormat).toBe('codec12')
    expect(toCreatePatch({ ...v, id: 'x' }).publish).not.toHaveProperty('flv_format')
    expect(toCreatePatch({ ...v, id: 'x', publishFlvFormat: 'enhanced' }).publish).toMatchObject({ flv_format: 'enhanced' })
  })

  it('只改输出封装也会下发 publish', () => {
    const ch = makeChannel()
    const patch = toUpdatePatch({ ...fromChannel(ch), publishFlvFormat: 'enhanced' }, ch)
    expect(patch.publish).toMatchObject({ flv_format: 'enhanced', enabled: true })
  })

  it('原来是 enhanced：改别的 publish 字段时带上原封装，不被整体替换冲回默认', () => {
    const ch = withPublish({ flv_format: 'enhanced' })
    const v = fromChannel(ch)
    expect(v.publishFlvFormat).toBe('enhanced')
    const patch = toUpdatePatch({ ...v, publishTargetUrl: 'rtmp://127.0.0.1/live/other' }, ch)
    expect(patch.publish).toMatchObject({ flv_format: 'enhanced', target_url: 'rtmp://127.0.0.1/live/other' })
  })

  it('什么都没改 → 不发 publish（不引发重启）', () => {
    const ch = withPublish({ flv_format: 'codec12' })
    expect(toUpdatePatch(fromChannel(ch), ch)).not.toHaveProperty('publish')
  })
})
