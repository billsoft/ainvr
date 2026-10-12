import { describe, expect, it } from 'vitest'
import { AI_MODEL_PRESETS, DEFAULT_AI_MODEL_PRESET, SELECTABLE_AI_MODEL_PRESET_KEYS } from '@/types/aiChannel'
import { DEFAULT_WIZARD_VALUE, fromChannel, toCreatePatch, toUpdatePatch } from '@/features/aiChannelForm'
import type { AiChannel } from '@/types/aiChannel'

describe('S100P 模型配置', () => {
  it('新配置仅提供两种封闭检测，未完成 BPU 接入的开放模型不可选', () => {
    expect(SELECTABLE_AI_MODEL_PRESET_KEYS).toEqual(['yolo26x', 'yolo26x-face'])
    expect(DEFAULT_AI_MODEL_PRESET).toBe('yolo26x')
    const patch = toCreatePatch(DEFAULT_WIZARD_VALUE)
    expect(patch.model?.name).toBe('yolo26x')
    expect(patch.model?.path).toBe('models/derived/s100p/yolo26x.hbm')
  })
  it('所有部署预设只生成 BPU/HBM 配置，不宣称文件已经编译完成', () => {
    for (const preset of Object.keys(AI_MODEL_PRESETS) as (keyof typeof AI_MODEL_PRESETS)[]) {
      const patch = toCreatePatch({ ...DEFAULT_WIZARD_VALUE, modelPreset: preset })
      expect(patch.model?.provider).toBe('bpu')
      expect(patch.model?.adapter).toMatch(/_bpu$/)
      expect(patch.model?.path).toMatch(/^models\/derived\/s100p\/.*\.hbm$/)
      expect(patch.model?.engine_cache).toBe('')
    }
  })

  it('编辑输出通道不能覆盖自定义 BPU 模型路径或归一化参数', () => {
    const created = toCreatePatch({ ...DEFAULT_WIZARD_VALUE, id: 'door',
      streamUrl: 'rtmp://127.0.0.1:1935/live/xm' })
    const original = { id: 'door', name: 'door', state: 'idle', stats: {}, config: {
      ...created, name: 'door',
      model: { ...created.model, path: 'models/validated/custom-yolo.hbm' },
      preprocess: { ...created.preprocess, mean: [1,2,3] },
    }} as unknown as AiChannel
    const value = { ...fromChannel(original), publishEnabled: true,
      publishTargetUrl: 'rtmp://127.0.0.1:1935/live/ai-n2q08c' }
    const patch = toUpdatePatch(value, original)
    expect(patch.model).toBeUndefined()
    expect(patch.preprocess).toBeUndefined()
    expect(patch.publish?.target_url).toBe(value.publishTargetUrl)
  })
})
