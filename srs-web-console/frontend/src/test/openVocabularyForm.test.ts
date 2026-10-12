import { describe, expect, it } from 'vitest'
import { DEFAULT_WIZARD_VALUE, applyModelPreset, fromChannel, toCreatePatch, toUpdatePatch, validateStep2, validateStep3 } from '@/features/aiChannelForm'
import { createMockAiChannelService } from '@/api/aiChannelService'
import { parseSeiJson } from '@/components/player/seiDetections'

describe('开放词汇通道契约', () => {
  it('拒绝控制字符和超过执行器范围的目标数', () => {
    const value = { ...applyModelPreset(DEFAULT_WIZARD_VALUE, 'yoloe-26x'),
      description: 'bus', labelId: 'bus', labelName: '车辆' }
    expect(validateStep2({ ...value, description: 'bus\u0000stop' })).toHaveProperty('description')
    expect(validateStep3({ ...value, maxDetections: 301 })).toHaveProperty('maxDetections')
    expect(validateStep3({ ...value, maxDetections: 300 })).not.toHaveProperty('maxDetections')
  })
  it('新建开放词汇通道没有预设识别对象，必须由用户填写', () => {
    for (const preset of ['yoloe-26x', 'locateanything-3b'] as const) {
      const value = applyModelPreset(DEFAULT_WIZARD_VALUE, preset)
      expect(value.description ?? '').toBe('')
      expect(value.labelId ?? '').toBe('')
      expect(value.labelName ?? '').toBe('')
      expect(validateStep2(value)).toHaveProperty('description')
    }
  })
  it('高速模型允许自定义描述和标签，发送匹配描述的类别', () => {
    const value = { ...applyModelPreset(DEFAULT_WIZARD_VALUE, 'yoloe-26x'),
      description: 'backpack', labelId: 'bag', labelName: '行囊' }
    expect(validateStep2(value)).toEqual({})
    const patch = toCreatePatch(value)
    expect(patch.model?.description).toBe('backpack')
    expect(patch.model?.class_names).toBeNull()
    expect(patch.model?.label_id).toBe('bag')
    expect(patch.model?.label_name).toBe('行囊')
    expect(validateStep2({ ...value, description: '' })).toHaveProperty('description')
    expect(validateStep2({ ...value, labelId: '../bad' })).toHaveProperty('labelId')
    expect(validateStep2({ ...value, labelName: '' })).toHaveProperty('labelName')
  })
  it('切换开放词汇模型保留用户定义的识别描述和标签', () => {
    const advanced = { ...applyModelPreset(DEFAULT_WIZARD_VALUE, 'locateanything-3b'),
      description: 'person', labelId: 'person', labelName: '人员' }
    const fast = applyModelPreset(advanced, 'yoloe-26x')
    expect(fast.description).toBe('person')
    expect(fast.labelName).toBe('人员')
    expect(fast.inferenceFps).toBe(3)
  })
  it('识别描述和检索标签独立，默认每十五秒识别一次', () => {
    const value = { ...applyModelPreset(DEFAULT_WIZARD_VALUE, 'locateanything-3b'),
      description: 'adult woman', labelId: 'woman', labelName: '成年女性' }
    expect(validateStep2(value)).toEqual({})
    const patch = toCreatePatch(value)
    expect(patch.inference_fps).toBeCloseTo(1 / 15)
    expect(patch.model?.description).toBe('adult woman')
    expect(patch.model?.label_id).toBe('woman')
    expect(patch.model?.label_name).toBe('成年女性')
  })
  it('不允许空提示词或跟随源帧率', () => {
    const value = applyModelPreset(DEFAULT_WIZARD_VALUE, 'locateanything-3b')
    expect(validateStep2({ ...value, description: '', inferenceFps: 0 })).toHaveProperty('description')
    expect(validateStep2({ ...value, inferenceFps: 0 })).toHaveProperty('inferenceFps')
  })
  it('SEI 的未知置信度保留为 null，而不是伪造零分', () => {
    const result = parseSeiJson(JSON.stringify({ det: [{ c: 0, n: '成年女性', p: null, l: 'woman', b: [1, 2, 3, 4] }] }))
    expect(result?.detections[0]?.confidence).toBeNull()
    expect(result?.detections[0]?.label_id).toBe('woman')
  })
  it('服务端字段顺序不同，改描述仍只发送热更新字段', async () => {
    const v = { ...applyModelPreset(DEFAULT_WIZARD_VALUE, 'locateanything-3b'),
      description: 'adult woman', labelId: 'woman', labelName: '成年女性',
      id: 'open', name: 'open', streamUrl: 'rtmp://localhost/live/cam' }
    const patch = toCreatePatch(v)
    const original = await createMockAiChannelService().create(patch)
    original.config.model = Object.fromEntries(Object.entries(original.config.model).sort()) as typeof original.config.model
    const edit = fromChannel(original)
    const update = toUpdatePatch({ ...edit, description: 'woman carrying a bag' }, original)
    expect(update.model).toEqual({ description: 'woman carrying a bag', label_id: 'woman', label_name: '成年女性' })
    // 编辑描述不重写已安装模型的生成参数、路径或硬件后端。
    expect(original.config.model.max_new_tokens).toBe(64)
  })
})
