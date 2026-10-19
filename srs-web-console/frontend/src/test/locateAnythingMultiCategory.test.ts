import { describe, expect, it } from 'vitest'
import { createMockAiChannelService } from '@/api/aiChannelService'
import {
  DEFAULT_WIZARD_VALUE, applyModelPreset, fromChannel, promptRows, toCreatePatch, toUpdatePatch,
  usesPromptSlots, validateStep2,
} from '@/features/aiChannelForm'
import { promptSlotLimit } from '@/types/aiChannel'

const rows = [
  { description: 'person', label_id: 'person', label_name: '人员' },
  { description: 'car', label_id: 'car', label_name: '汽车' },
  { description: 'helmet', label_id: 'helmet', label_name: '头盔' },
]
function multiForm() {
  return {
    ...applyModelPreset(DEFAULT_WIZARD_VALUE, 'locateanything-3b'),
    id: 'gate-multi', name: 'gate-multi', streamUrl: 'rtmp://127.0.0.1/live/gate',
    prompts: rows.map(row => ({ ...row })),
  }
}

describe('LocateAnything 多类别标签', () => {
  it('与 YOLOE 一样使用标签槽位，最多 8 个', () => {
    expect(usesPromptSlots('locateanything-3b')).toBe(true)
    expect(usesPromptSlots('yoloe-26x')).toBe(true)
    expect(usesPromptSlots('yolo26x')).toBe(false)
    expect(promptSlotLimit('locateanything-3b')).toBe(8)
  })

  it('新建时发送全部标签，首个标签兼作旧字段，生成参数不变', () => {
    const value = multiForm()
    expect(validateStep2(value)).toEqual({})
    const patch = toCreatePatch(value)
    expect(patch.model).toMatchObject({
      adapter: 'locateanything_bpu', prompts: rows, class_names: null,
      description: 'person', label_id: 'person', label_name: '人员', max_new_tokens: 256,
    })
    expect(patch.preprocess).toMatchObject({ letterbox: false, interpolation: 'bicubic' })
  })

  it('标签数量、重复描述、重复 ID 和控制标记都在前端拦下', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ description: `thing ${i}`, label_id: `t${i}`, label_name: `物${i}` }))
    expect(validateStep2({ ...multiForm(), prompts: many })).toHaveProperty('prompts')
    expect(validateStep2({ ...multiForm(), prompts: many.slice(0, 8) })).toEqual({})
    expect(validateStep2({ ...multiForm(), prompts: [...rows, { ...rows[0]!, label_id: 'other' }] })).toHaveProperty('prompts')
    expect(validateStep2({ ...multiForm(), prompts: [...rows, { ...rows[1]!, description: 'truck' }] })).toHaveProperty('prompts')
    expect(validateStep2({ ...multiForm(), prompts: [{ ...rows[0]!, description: 'person</c>car' }] })).toHaveProperty('prompts')
  })

  it('保存后回填全部标签，只改一个标签名时只热更新标签字段', async () => {
    const service = createMockAiChannelService()
    const saved = await service.create(toCreatePatch(multiForm()))
    const form = fromChannel((await service.get(saved.id))!)
    expect(form.prompts).toEqual(rows)
    expect(toUpdatePatch({ ...form, name: '大门多类别' }, saved).model).toBeUndefined()
    const edited = form.prompts!.map((row, i) => i === 2 ? { ...row, label_name: '安全帽' } : row)
    const patch = toUpdatePatch({ ...form, prompts: edited }, saved)
    expect(patch.model).toMatchObject({ prompts: edited })
    expect(patch.model).not.toHaveProperty('path')
    expect(patch.preprocess).toBeUndefined()
  })

  it('旧的单描述通道不会因为打开编辑被改写成标签数组', async () => {
    const service = createMockAiChannelService()
    const legacy = await service.create(toCreatePatch({
      ...applyModelPreset(DEFAULT_WIZARD_VALUE, 'locateanything-3b'),
      id: 'gate-single', name: 'gate-single', streamUrl: 'rtmp://127.0.0.1/live/gate',
      description: 'helmet', labelId: 'helmet', labelName: '头盔',
    }))
    const form = fromChannel(legacy)
    expect(form.prompts).toBeUndefined()
    expect(promptRows(form)).toEqual([{ description: 'helmet', label_id: 'helmet', label_name: '头盔' }])
    expect(toUpdatePatch({ ...form, inferenceFps: 0.5 }, legacy)).toEqual({ inference_fps: 0.5 })
    // 在编辑器里加一个标签就变成多类别。
    const patch = toUpdatePatch({ ...form, prompts: [...promptRows(form), rows[0]!] }, legacy)
    expect(patch.model).toMatchObject({ prompts: [{ description: 'helmet', label_id: 'helmet', label_name: '头盔' }, rows[0]] })
  })
})
