import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { AnalysisPipelineEditor } from '@/pages/AiChannels/AnalysisPipelineEditor'
import { AiChannelWizard } from '@/pages/AiChannels/AiChannelWizard'
import { parseSeiJson } from '@/components/player/seiDetections'
import { drawDetections } from '@/components/player/detectionDrawing'
import { computeContainLayout } from '@/components/player/overlayGeometry'
import { parseRecordingSei } from '@/pages/Playback/recordingSei'
import { AI_MODEL_PRESETS, SELECTABLE_AI_MODEL_PRESET_KEYS, type AiChannel, type AiModelPresetKey } from '@/types/aiChannel'
import type { ChannelWithStatus } from '@/types/channel'
import { DEFAULT_WIZARD_VALUE, applyModelPreset, buildModelAndPreprocess, fromChannel, toCreatePatch, toUpdatePatch, updateWizardModelList, validateStep2, wizardModelList } from '@/features/aiChannelForm'
import { availableModelPresetKeys, modelCapabilitySaveBlock, HARDWARE_VERIFIED_MODEL_PRESET_KEYS } from '@/features/modelCapabilities'

function node(key: AiModelPresetKey, id = 'extra') {
  return { id, ...buildModelAndPreprocess(key, applyModelPreset(DEFAULT_WIZARD_VALUE, key)), postprocess: { conf_threshold: .25, iou_threshold: .45, max_detections: 200 } }
}

function channel(key: AiModelPresetKey = 'yolo26x'): AiChannel {
  const patch = toCreatePatch({ ...DEFAULT_WIZARD_VALUE, id: 'camera', name: 'Camera', streamUrl: 'rtmp://127.0.0.1:1935/live/input', publishEnabled: true, publishTargetUrl: 'rtmp://127.0.0.1:1935/live/output' })
  return { id: 'camera', name: 'Camera', state: 'idle', stats: {}, config: {
    ...patch, ...buildModelAndPreprocess(key, DEFAULT_WIZARD_VALUE),
    publish: { ...patch.publish, rtmp_base: 'rtmp://127.0.0.1:1935' },
  } } as unknown as AiChannel
}

describe('硬件验收状态与真实保存', () => {
  it.each(HARDWARE_VERIFIED_MODEL_PRESET_KEYS)('%s 实机通过后允许单模型、多模型、创建和更新', key => {
    expect(SELECTABLE_AI_MODEL_PRESET_KEYS).toContain(key)
    const single = applyModelPreset(DEFAULT_WIZARD_VALUE, key)
    const multi = updateWizardModelList(DEFAULT_WIZARD_VALUE, [...wizardModelList(DEFAULT_WIZARD_VALUE), node(key)])
    for (const value of [single, multi]) {
      expect(validateStep2(value)).toEqual({})
      expect(() => toCreatePatch(value)).not.toThrow()
      expect(() => toUpdatePatch(value, channel())).not.toThrow()
      expect(modelCapabilitySaveBlock(wizardModelList(value).map(n => n.model), [])).toMatch(/尚未在本设备通过验证/)
    }
  })

  it('未验收清单按名称和路径拦截；已验收模型保留绝对路径及自定义名称', () => {
    const original = channel('helmet-head-yolo26s')
    original.config.model.name = 'renamed'
    original.config.model.path = '/installed/helmet-head-yolo26s.hbm'
    const value = fromChannel(original)
    expect(validateStep2(value)).toEqual({})
    expect(() => toUpdatePatch({ ...value, name: 'renamed channel' }, original)).not.toThrow()
    expect(modelCapabilitySaveBlock([original.config.model], [])).toMatch(/尚未在本设备通过验证/)
    expect(modelCapabilitySaveBlock([{ name: 'custom', path: 'C:\\models\\fire-smoke-yolo26n.hbm' }], [])).toMatch(/尚未在本设备通过验证/)
  })

  it('head 不冒充 no_helmet，烟火顺序和 SCRFD 归一化沿用契约', () => {
    expect(node('helmet-head-yolo26s').model.class_names).toEqual(['head', 'helmet'])
    expect(node('helmet-face-yolo26s').model.class_names).toEqual(['helmet', 'no_helmet'])
    expect(node('fire-smoke-yolo26n').model.class_names).toEqual(['smoke', 'fire'])
    for (const key of ['face-det-scrfd-2g5', 'face-det-scrfd-500m'] as const) {
      expect(node(key)).toMatchObject({ model: { adapter: 'scrfd_bpu', class_names: ['face'], input_size: [640, 640] }, preprocess: { normalize: true, rgb_order: true, mean: [127.5, 127.5, 127.5], std: [128, 128, 128] } })
    }
    for (const key of ['detect-coco-yolo26s', 'detect-coco-yolo26m'] as const) {
      const built = node(key)
      expect(built.model.class_names).toHaveLength(80)
      expect(built.model.class_names?.slice(0, 4)).toEqual(['person', 'bicycle', 'car', 'motorcycle'])
      expect(built.model.class_names?.at(-1)).toBe('toothbrush')
      expect(built.preprocess).toMatchObject({ mean: [0, 0, 0], std: [255, 255, 255], rgb_order: true, normalize: true })
    }
  })

  it('姿态试用保留独立17点 adapter，硬件通过后可保存', () => {
    const built = node('human-pose-yolo26s')
    expect(built).toMatchObject({
      model: { name: 'human-pose-yolo26s', adapter: 'yolo26_pose_bpu', provider: 'bpu',
        path: 'models/derived/s100p/human-pose-yolo26s.hbm', input_size: [640, 640], class_names: ['person'] },
      preprocess: { normalize: true, rgb_order: true, mean: [0, 0, 0], std: [255, 255, 255],
        letterbox: true, padding_color: [114, 114, 114] },
    })
    expect(availableModelPresetKeys([AI_MODEL_PRESETS.yolo26x.model])).toContain('human-pose-yolo26s')
    expect(modelCapabilitySaveBlock([built.model])).toBeUndefined()
  })

  it.each(['yolo26m', 'scrfd', 'yolov12m-face', 'yolo26x'] as const)('旧 %s 回填、改名与自定义预处理仍可保存', key => {
    const original = channel(key)
    original.config.model.path = `models/old/${key}.hbm`
    original.config.preprocess.mean = [1, 2, 3]
    const value = fromChannel(original)
    expect(validateStep2(value)).toEqual({})
    expect(toUpdatePatch({ ...value, name: 'New name' }, original)).toEqual({ name: 'New name' })
    expect(wizardModelList(value)[0]!.model.path).toBe(original.config.model.path)
    expect(wizardModelList(value)[0]!.preprocess.mean).toEqual([1, 2, 3])
  })

  it('同类新增默认择一，不把旧重复模型强制改写', () => {
    expect(availableModelPresetKeys([AI_MODEL_PRESETS.yolo26m.model])).not.toContain('detect-coco-yolo26s')
    expect(availableModelPresetKeys([AI_MODEL_PRESETS.scrfd.model])).not.toContain('face-det-scrfd-2g5')
    expect(availableModelPresetKeys([AI_MODEL_PRESETS['helmet-head-yolo26s'].model])).not.toContain('helmet-face-yolo26s')
    const original = channel()
    original.config.analysis_pipeline = { execution: 'serial', nodes: [node('yolo26m')] }
    expect(toUpdatePatch({ ...fromChannel(original), name: 'Legacy duplicate' }, original)).toEqual({ name: 'Legacy duplicate' })
  })

  it('高级选择允许同类不同档位，但仍排除已使用的同一预设', () => {
    const used = [AI_MODEL_PRESETS['yoloe-26x'].model]
    expect(availableModelPresetKeys(used)).not.toContain('yoloe-26x-1')
    const advanced = availableModelPresetKeys(used, true)
    expect(advanced).toContain('yoloe-26x-1')
    expect(advanced).toContain('yoloe-26x-2')
    expect(advanced).not.toContain('yoloe-26x')
    expect(availableModelPresetKeys([AI_MODEL_PRESETS.yolo26x.model], true)).toContain('detect-coco-yolo26s')
  })
})

describe('统一能力列表交互', () => {
  it('显式高级添加保留开放词汇多模型功能，关闭高级选项后仍可保存、排序与删除', () => {
    const initial = { ...applyModelPreset(DEFAULT_WIZARD_VALUE, 'yoloe-26x-1'),
      prompts: [{ description: 'person', label_id: 'person', label_name: '人员' }],
    }
    let latest: typeof DEFAULT_WIZARD_VALUE = initial
    function Harness() {
      const [value, setValue] = useState<typeof DEFAULT_WIZARD_VALUE>(initial)
      latest = value
      return <AnalysisPipelineEditor value={value} onChange={setValue} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByText('模型组合与高级添加选项'))
    const advanced = screen.getByRole('checkbox', { name: '高级：允许同类多模型' })
    expect(advanced).not.toBeChecked()
    expect(within(screen.getByLabelText('待添加模型')).queryByRole('option', { name: /开放词汇/ })).not.toBeInTheDocument()
    fireEvent.click(advanced)
    fireEvent.change(screen.getByLabelText('待添加模型'), { target: { value: 'yoloe-26x-2' } })
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }))
    expect(screen.queryByLabelText('识别描述 1')).not.toBeInTheDocument()
    expect(validateStep2(latest).analysisPipeline).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `配置 ${AI_MODEL_PRESETS['yoloe-26x-2'].displayName}` }))
    fireEvent.change(screen.getByLabelText('识别描述 1'), { target: { value: 'car' } })
    fireEvent.change(screen.getByLabelText('标签 ID 1'), { target: { value: 'car' } })
    fireEvent.change(screen.getByLabelText('标签名称 1'), { target: { value: '车辆' } })
    fireEvent.click(screen.getByRole('button', { name: '应用到通道草稿' }))
    const secondTitle = AI_MODEL_PRESETS['yoloe-26x-2'].displayName
    fireEvent.click(advanced)
    expect(wizardModelList(latest).map(n => n.model.name)).toEqual(['yoloe-26x-1', 'yoloe-26x-2'])
    fireEvent.click(screen.getByRole('button', { name: `配置 ${secondTitle}` }))
    expect(screen.getByLabelText(`${secondTitle} 模型`)).toHaveValue('yoloe-26x-2')
    fireEvent.click(screen.getByRole('button', { name: '应用到通道草稿' }))
    expect(validateStep2(latest)).toEqual({})
    const patch = toCreatePatch(latest)
    expect(patch.model?.prompts?.[0]?.description).toBe('person')
    expect(patch.analysis_pipeline?.nodes[0]?.model.prompts?.[0]?.description).toBe('car')
    expect(JSON.stringify(patch)).not.toContain('allowSameCapability')
    fireEvent.click(screen.getByRole('button', { name: `上移 ${secondTitle}` }))
    expect(wizardModelList(latest)[0]!.model.name).toBe('yoloe-26x-2')
    fireEvent.click(screen.getByRole('button', { name: `移除 ${secondTitle}` }))
    expect(wizardModelList(latest)).toHaveLength(1)
    expect(validateStep2(latest)).toEqual({})
  })

  it('新增能力可上下移、换同类方案、移除，恢复后旧配置可保存', () => {
    let latest = DEFAULT_WIZARD_VALUE
    function Harness() {
      const [value, setValue] = useState(DEFAULT_WIZARD_VALUE)
      latest = value
      return <AnalysisPipelineEditor value={value} onChange={setValue} />
    }
    render(<Harness />)
    const addSelect = screen.getByLabelText('待添加模型')
    expect(within(addSelect).queryByRole('option', { name: /通用目标检测/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('模型组合与高级添加选项'))
    expect(screen.getByText(/同一用途默认只选一个模型/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /姿态|人脸比对/ })).not.toBeInTheDocument()
    fireEvent.change(addSelect, { target: { value: 'helmet-head-yolo26s' } })
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }))
    fireEvent.click(screen.getByRole('button', { name: `配置 ${AI_MODEL_PRESETS['helmet-head-yolo26s'].displayName}` }))
    expect(screen.getByText(/不能用于“未戴安全帽”告警/)).toBeInTheDocument()
    expect(screen.queryByText(/技术详情|契约模型|mean|硬件已验证/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '应用到通道草稿' }))
    const title = AI_MODEL_PRESETS['helmet-head-yolo26s'].displayName
    fireEvent.click(screen.getByRole('button', { name: `上移 ${title}` }))
    expect(wizardModelList(latest)[0]!.model.name).toBe('helmet-head-yolo26s')
    fireEvent.click(screen.getByRole('button', { name: `下移 ${title}` }))
    expect(wizardModelList(latest)[1]!.model.name).toBe('helmet-head-yolo26s')
    fireEvent.click(screen.getByRole('button', { name: `配置 ${title}` }))
    fireEvent.change(screen.getByLabelText(`${title} 模型`), { target: { value: 'helmet-face-yolo26s' } })
    fireEvent.click(screen.getByRole('button', { name: '应用到通道草稿' }))
    expect(wizardModelList(latest)[1]!.model.class_names).toEqual(['helmet', 'no_helmet'])
    fireEvent.click(screen.getByRole('checkbox', { name: '高级：允许同类多模型' }))
    expect(() => toCreatePatch(latest)).not.toThrow()
    fireEvent.click(screen.getByRole('button', { name: `移除 ${AI_MODEL_PRESETS['helmet-face-yolo26s'].displayName}` }))
    expect(validateStep2(latest)).toEqual({})
    expect(toCreatePatch(latest).model?.name).toBe('yolo26x')
  })

  it('模型行更换档位原子更新，删除原节点仍可保存已验收模型', () => {
    const initial = updateWizardModelList(DEFAULT_WIZARD_VALUE, [...wizardModelList(DEFAULT_WIZARD_VALUE), node('helmet-head-yolo26s')])
    const remaining = updateWizardModelList(initial, [wizardModelList(initial)[1]!])
    expect(remaining.modelPreset).toBe('helmet-head-yolo26s')
    expect(toCreatePatch(remaining).model?.name).toBe('helmet-head-yolo26s')
    const replacement = { ...node('face-det-scrfd-500m'), id: wizardModelList(remaining)[0]!.id }
    const changed = updateWizardModelList(remaining, [replacement])
    expect(changed.modelPreset).toBe('face-det-scrfd-500m')
    expect(wizardModelList(changed)[0]!.preprocess.std).toEqual([128, 128, 128])
  })
})

const srsChannels = ['input', 'output'].map(id => ({
  id, name: id, description: '', upstream: { protocol: 'rtmp', app: 'live', stream: id },
  downstream: { protocols: ['rtmp'], primary: 'rtmp' }, createdAt: '', updatedAt: '',
  status: { channelId: id, online: false, viewerCount: 0 },
})) as ChannelWithStatus[]

it('画外点 score0 visible0 在实时与回放仍保留17点，绘制跳过无效点', () => {
  const pose = { schema_version: '1.0', type: 'keypoints', status: 'observed', layout: 'coco17',
    coordinate_space: 'original_image', image_size: [1280, 720], visibility_threshold: .5,
    source_model_sha256: 'a'.repeat(64),
    points: Array.from({ length: 17 }, (_, i) => ({ x: i ? 200 + i : -12, y: 200,
      score: i ? .9 : 0, visible: i ? 1 : 0 })),
  }
  const payload = { pts: 1000000000, det: [{ c: 0, n: 'person', p: .9, b: [100, 100, 400, 400], a: { pose } }] }
  const live = parseSeiJson(JSON.stringify(payload))!
  const replay = parseRecordingSei({ frames: [{ timeMs: 1000, payload }] })[0]!.result
  expect(live.detections).toEqual(replay.detections)
  const ctx = Object.fromEntries(['setLineDash', 'strokeRect', 'fillRect', 'fillText', 'beginPath', 'moveTo',
    'lineTo', 'stroke', 'arc', 'fill'].map(k => [k, vi.fn()])) as unknown as CanvasRenderingContext2D
  ctx.measureText = () => ({ width: 10 }) as TextMetrics
  for (const result of [live, replay]) {
    const attribute = result.detections[0]!.model_extra!.attributes!.pose
    expect(attribute).toMatchObject({ points: pose.points.map(({ x, y, score }) => ({ x, y, score })) })
    drawDetections(ctx, result.detections, computeContainLayout(1280, 720, 640, 360), 1280, 720)
  }
  expect(ctx.arc).toHaveBeenCalledTimes(32)
})

it('真实向导允许已验收档位走保存回调，未保存之前不调用API', () => {
  const onSubmit = vi.fn()
  render(<AiChannelWizard open mode="edit" initial={channel()} streams={[]} srsChannels={srsChannels} onRefreshStreams={vi.fn()} onClose={vi.fn()} onSubmit={onSubmit} />)
  fireEvent.click(screen.getByRole('button', { name: '下一步 →' }))
  fireEvent.click(screen.getByRole('button', { name: /^配置 / }))
  fireEvent.change(screen.getByTestId('wizard-model-select'), { target: { value: 'detect-coco-yolo26m' } })
  expect(onSubmit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '应用到通道草稿' }))
  fireEvent.click(screen.getByRole('button', { name: '下一步 →' }))
  expect(onSubmit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '下一步 →' }))
  fireEvent.click(screen.getByTestId('wizard-submit'))
  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit.mock.calls[0]![0].model?.name).toBe('detect-coco-yolo26m')
})
