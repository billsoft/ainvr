import { describe, expect, it } from 'vitest'
import { createMockAiChannelService } from '@/api/aiChannelService'
import {
  DEFAULT_WIZARD_VALUE, applyModelPreset, fromChannel, toCreatePatch, toUpdatePatch,
} from '@/features/aiChannelForm'
import { SELECTABLE_AI_MODEL_PRESET_KEYS } from '@/types/aiChannel'

function locateForm() {
  return {
    ...applyModelPreset(DEFAULT_WIZARD_VALUE, 'locateanything-3b'),
    id: 'grounding-input', streamUrl: 'rtmp://127.0.0.1/live/camera',
    description: 'point at the person', labelId: 'person-point', labelName: '人物位置',
  }
}

describe('LocateAnything model-owned input contract', () => {
  it('creation supplies full-frame224x448 bicubic RGB normalization explicitly', () => {
    const patch = toCreatePatch(locateForm())
    expect(patch.model).toMatchObject({
      adapter: 'locateanything_bpu', input_size: [224, 448],
      description: 'point at the person', label_id: 'person-point',
      max_new_tokens: 256,
    })
    expect(patch.preprocess).toMatchObject({
      letterbox: false, interpolation: 'bicubic', normalize: true, rgb_order: true,
      mean: [127.5, 127.5, 127.5], std: [127.5, 127.5, 127.5],
    })
  })

  it('save/readback preserves the input profile and untouched edits preserve the installed model', async () => {
    const service = createMockAiChannelService()
    const saved = await service.create(toCreatePatch(locateForm()))
    const loaded = await service.get(saved.id)
    expect(loaded?.config.inference_fps).toBeCloseTo(1 / 120)
    expect(fromChannel(loaded!).inferenceFps).toBeCloseTo(1 / 120)
    expect(loaded?.config.preprocess).toMatchObject({
      letterbox: false, interpolation: 'bicubic', normalize: true,
    })
    const form = fromChannel(loaded!)
    const patch = toUpdatePatch({ ...form, name: '改名' }, loaded)
    expect(patch.name).toBe('改名')
    expect(patch.model).toBeUndefined()
    expect(patch.preprocess).toBeUndefined()
  })

  it('description-only edits preserve an existing saved cadence', async () => {
    const service = createMockAiChannelService()
    for (const seconds of [15, 60, 120]) {
      const saved = await service.create(toCreatePatch({
        ...locateForm(), id: `cadence-${seconds}`, inferenceFps: 1 / seconds,
      }))
      const loaded = await service.get(saved.id)
      const form = fromChannel(loaded!)
      expect(form.inferenceFps).toBeCloseTo(1 / seconds)
      const patch = toUpdatePatch({ ...form, description: 'point at the car' }, loaded)
      expect(patch.inference_fps).toBeUndefined()
      await service.update(saved.id, patch)
      expect((await service.get(saved.id))?.config.inference_fps).toBeCloseTo(1 / seconds)
    }
  })

  it('explicit reselection repairs resize fields even when normalization numbers already match', async () => {
    const service = createMockAiChannelService()
    const channel = await service.create(toCreatePatch(locateForm()))
    channel.config.preprocess.letterbox = true
    channel.config.preprocess.interpolation = 'bilinear'
    const selected = applyModelPreset(fromChannel(channel), 'locateanything-3b')
    const patch = toUpdatePatch(selected, channel)
    expect(patch.preprocess).toMatchObject({
      letterbox: false, interpolation: 'bicubic', normalize: true,
    })
  })

  it('switching back to a detector resets its resize and normalization together', async () => {
    const service = createMockAiChannelService()
    const channel = await service.create(toCreatePatch(locateForm()))
    channel.config.preprocess.letterbox = false
    channel.config.preprocess.interpolation = 'bicubic'
    channel.config.preprocess.normalize = false
    const selected = applyModelPreset(fromChannel(channel), 'yoloe-26x')
    const patch = toUpdatePatch(selected, channel)
    expect(patch.model?.adapter).toBe('yoloe_bpu')
    expect(patch.preprocess).toMatchObject({
      letterbox: true, interpolation: 'bilinear', normalize: true,
      mean: [0, 0, 0], std: [255, 255, 255],
    })
  })

  it('exposes the explicitly accepted trial and preserves both YOLOE models', () => {
    expect(SELECTABLE_AI_MODEL_PRESET_KEYS).toContain('locateanything-3b')
    expect(SELECTABLE_AI_MODEL_PRESET_KEYS).toContain('yoloe-26x')
    expect(SELECTABLE_AI_MODEL_PRESET_KEYS).toContain('yoloe-26x-32')
  })
})
