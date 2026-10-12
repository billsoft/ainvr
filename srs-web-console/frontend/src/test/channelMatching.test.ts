import { describe, expect, it } from 'vitest'
import { buildAiOutputChannelIdMap } from '@/utils/channelMatching'
import type { AiChannel } from '@/types/aiChannel'

function makeAiChannel(overrides: Partial<AiChannel> = {}): AiChannel {
  return {
    id: 'ai01',
    name: '测试通道',
    state: 'running',
    config: {
      name: '测试通道',
      enabled: true,
      stream: { url: 'rtmp://127.0.0.1:1935/live/src', protocol: 'rtmp' },
      inference_fps: 5,
      max_consecutive_failures: 10,
      model: {
        name: 'yolo26m', adapter: 'yolo26_trt', path: '', input_size: [640, 640],
        stride: 32, provider: 'tensorrt', engine_cache: '', class_names: ['face'],
      },
      preprocess: {
        letterbox: true, padding_color: [114, 114, 114], interpolation: 'bilinear',
        normalize: true, mean: [0, 0, 0], std: [255, 255, 255], rgb_order: true,
        gpu_direct: true, ai_sample_width: 0, ai_sample_height: 0,
      },
      postprocess: { conf_threshold: 0.15, iou_threshold: 0.45, max_detections: 300 },
      result_buffer: { max_frames: 30 },
      publish: {
        enabled: true, mode: 'passthrough_sei', rtmp_base: 'rtmp://127.0.0.1:1935',
        target_url: 'rtmp://127.0.0.1:1935/live/src_ai',
        effective_target_url: 'rtmp://127.0.0.1:1935/live/src_ai',
      },
    },
    stats: {} as AiChannel['stats'],
    ...overrides,
  } as AiChannel
}

describe('buildAiOutputChannelIdMap', () => {
  it('把 AI 通道的输出流 app/stream 映射到通道 id', () => {
    const map = buildAiOutputChannelIdMap([makeAiChannel({ id: 'ai01' })])
    expect(map.get('live/src_ai')).toBe('ai01')
  })

  it('publish 未启用的通道不产出映射（没有识别结果可显示）', () => {
    const ch = makeAiChannel({
      id: 'ai02',
      config: {
        ...makeAiChannel().config,
        publish: { ...makeAiChannel().config.publish, enabled: false },
      },
    })
    const map = buildAiOutputChannelIdMap([ch])
    expect(map.size).toBe(0)
  })

  it('多个通道各自独立映射', () => {
    const a = makeAiChannel({
      id: 'ai01',
      config: {
        ...makeAiChannel().config,
        publish: {
          ...makeAiChannel().config.publish,
          effective_target_url: 'rtmp://127.0.0.1:1935/live/a_ai',
        },
      },
    })
    const b = makeAiChannel({
      id: 'ai02',
      config: {
        ...makeAiChannel().config,
        publish: {
          ...makeAiChannel().config.publish,
          effective_target_url: 'rtmp://127.0.0.1:1935/live/b_ai',
        },
      },
    })
    const map = buildAiOutputChannelIdMap([a, b])
    expect(map.get('live/a_ai')).toBe('ai01')
    expect(map.get('live/b_ai')).toBe('ai02')
  })
})
