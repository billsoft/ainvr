import { describe, expect, it } from 'vitest'
import { AI_MODEL_PRESETS, getAiModelDisplayName, isOpenVocabularyPreset, isYoloePreset, promptSlotLimit, SELECTABLE_AI_MODEL_PRESET_KEYS } from '@/types/aiChannel'
import { DEFAULT_WIZARD_VALUE, toCreatePatch } from '@/features/aiChannelForm'

describe('开放词汇 1 槽选项', () => {
  it('1 槽预设可选、属于开放词汇、容量为 1', () => {
    expect(SELECTABLE_AI_MODEL_PRESET_KEYS).toContain('yoloe-26x-1')
    expect(isOpenVocabularyPreset('yoloe-26x-1')).toBe(true)
    expect(isYoloePreset('yoloe-26x-1')).toBe(true)
    expect(promptSlotLimit('yoloe-26x-1')).toBe(1)
    expect(promptSlotLimit('yoloe-26x-2')).toBe(2)
    expect(SELECTABLE_AI_MODEL_PRESET_KEYS).toContain('yoloe-26x-2')
    expect(promptSlotLimit('yoloe-26x')).toBe(8)
    expect(promptSlotLimit('yoloe-26x-32')).toBe(32)
  })
  it('1 槽生成独立的模型名与文件路径，且不与其他预设共用流标识', () => {
    const patch = toCreatePatch({ ...DEFAULT_WIZARD_VALUE, modelPreset: 'yoloe-26x-1' })
    expect(patch.model?.name).toBe('yoloe-26x-1')
    expect(patch.model?.path).toBe('models/derived/s100p/yoloe-26x-1.hbm')
    expect(patch.model?.adapter).toBe('yoloe_bpu')
    const slugs = Object.values(AI_MODEL_PRESETS).map((p) => p.streamSlug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
  it('界面文字只用任务名，不暴露模型名，也不宣称省内存', () => {
    const preset = AI_MODEL_PRESETS['yoloe-26x-1']
    const text = [preset.displayName, preset.label, preset.description, getAiModelDisplayName(preset.model)].join('|')
    expect(text).toContain('1 槽')
    expect(text).not.toMatch(/yoloe|yolo|clip|bpu|hbm|内存/i)
  })
})

describe("开放词汇双槽",()=>{it("容量、名称、模型文件及开放词汇类型一致",()=>{expect(promptSlotLimit("yoloe-26x-2")).toBe(2);expect(isYoloePreset("yoloe-26x-2")).toBe(true);expect(SELECTABLE_AI_MODEL_PRESET_KEYS).toContain("yoloe-26x-2");const p=toCreatePatch({...DEFAULT_WIZARD_VALUE,modelPreset:"yoloe-26x-2"});expect(p.model?.name).toBe("yoloe-26x-2");expect(p.model?.path).toBe("models/derived/s100p/yoloe-26x-2.hbm");})})
