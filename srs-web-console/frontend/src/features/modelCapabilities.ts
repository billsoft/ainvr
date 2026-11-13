import { AI_MODEL_PRESETS, SELECTABLE_AI_MODEL_PRESET_KEYS, type AiModelConfig, type AiModelPresetKey } from '@/types/aiChannel'

// Installed capability catalog. Presence alone never authorizes saving.
export const CAPABILITY_MODEL_PRESET_KEYS = [
  'detect-coco-yolo26s', 'detect-coco-yolo26m',
  'face-det-scrfd-2g5', 'face-det-scrfd-500m',
  'helmet-head-yolo26s', 'helmet-face-yolo26s', 'fire-smoke-yolo26n',
  'human-pose-yolo26s',
] as const satisfies readonly AiModelPresetKey[]

// 190: contract + SDK load + three real JPEG JPU/RunFrame/postprocess iterations.
// Evidence: test/results/capabilities-20261112/russell-infer-final/hardware-summary.json.
// This accepts the hardware path, not scene accuracy; pose remains a trial.
export const HARDWARE_VERIFIED_MODEL_PRESET_KEYS: readonly AiModelPresetKey[] = [
  'detect-coco-yolo26s', 'detect-coco-yolo26m',
  'face-det-scrfd-2g5', 'face-det-scrfd-500m',
  'helmet-head-yolo26s', 'helmet-face-yolo26s', 'fire-smoke-yolo26n',
  'human-pose-yolo26s',
]
export const PREVIEW_MODEL_PRESET_KEYS: readonly AiModelPresetKey[] = CAPABILITY_MODEL_PRESET_KEYS
  .filter(key => !HARDWARE_VERIFIED_MODEL_PRESET_KEYS.includes(key))

export function isCapabilityModelPreset(key: AiModelPresetKey): boolean {
  return (CAPABILITY_MODEL_PRESET_KEYS as readonly AiModelPresetKey[]).includes(key)
}

export const MODEL_CAPABILITY_GROUPS = [
  { id: 'general', label: '通用目标检测', keys: ['yolo26x', 'detect-coco-yolo26s', 'detect-coco-yolo26m', 'yolo26m'] },
  { id: 'face', label: '人脸检测', keys: ['yolo26x-face', 'face-det-scrfd-2g5', 'face-det-scrfd-500m', 'scrfd', 'yolov12m-face'] },
  { id: 'helmet', label: '安全帽检测', keys: ['helmet-face-yolo26s', 'helmet-head-yolo26s'] },
  { id: 'fire', label: '烟雾 / 明火检测', keys: ['fire-smoke-yolo26n'] },
  { id: 'pose', label: '人体姿态（试用）', keys: ['human-pose-yolo26s'] },
  { id: 'plate', label: '车牌检测与识别', keys: ['plate-recognition'] },
  { id: 'open', label: '开放词汇', keys: ['yoloe-26x-1', 'yoloe-26x-2', 'yoloe-26x', 'yoloe-26x-32', 'locateanything-3b'] },
] satisfies { id: string; label: string; keys: AiModelPresetKey[] }[]

export const MODEL_PREVIEW_NOTICE = '识别效果取决于画面角度、距离和光照；启用后请先在实时监看中观察实际效果，再用于告警。'

export function isPreviewModelPreset(key: AiModelPresetKey): boolean {
  return (PREVIEW_MODEL_PRESET_KEYS as readonly AiModelPresetKey[]).includes(key)
}

export function modelPresetKey(model: Pick<AiModelConfig, 'name'>): AiModelPresetKey | undefined {
  return (Object.keys(AI_MODEL_PRESETS) as AiModelPresetKey[]).find(key => AI_MODEL_PRESETS[key].model.name === model.name)
}

export function modelCapabilityGroup(key: AiModelPresetKey) {
  return MODEL_CAPABILITY_GROUPS.find(group => (group.keys as AiModelPresetKey[]).includes(key))!
}

export function modelPresetOptionLabel(key: AiModelPresetKey): string {
  const name = key === 'yolo26x' ? '通用目标检测 · 高精度档' : AI_MODEL_PRESETS[key].displayName
  return name + (isPreviewModelPreset(key) ? ' · 暂不可用' : '')
}

export function modelPresetGroups(keys: readonly AiModelPresetKey[]) {
  return MODEL_CAPABILITY_GROUPS.map(group => ({
    ...group, keys: keys.filter(key => (group.keys as AiModelPresetKey[]).includes(key)),
  })).filter(group => group.keys.length > 0)
}

/** Default to one per family; explicit advanced selection preserves multi-model use.
 * Even in advanced mode the same preset cannot be added twice (existing behavior).
 * This is a UI preference only, never an extra field in a saved channel config.
 */
export function availableModelPresetKeys(others: readonly Pick<AiModelConfig, 'name'>[], allowSameCapability = false): AiModelPresetKey[] {
  const usedNames = new Set(others.map(model => model.name))
  const groups = new Set(others.flatMap(model => {
    const key = modelPresetKey(model)
    return key ? [modelCapabilityGroup(key).id] : []
  }))
  return MODEL_CAPABILITY_GROUPS.flatMap(group => !allowSameCapability && groups.has(group.id) ? [] : group.keys)
    .filter(key => SELECTABLE_AI_MODEL_PRESET_KEYS.includes(key) || isPreviewModelPreset(key))
    .filter(key => !usedNames.has(AI_MODEL_PRESETS[key].model.name))
}

/** Check both identity and artifact, including imported / renamed preview nodes. */
export function modelCapabilitySaveBlock(models: readonly Pick<AiModelConfig, 'name' | 'path'>[], verified: readonly AiModelPresetKey[] = HARDWARE_VERIFIED_MODEL_PRESET_KEYS): string | undefined {
  const blocked = CAPABILITY_MODEL_PRESET_KEYS.filter(key => !verified.includes(key) && models.some(model =>
    model.name === AI_MODEL_PRESETS[key].model.name ||
    model.path.replaceAll('\\', '/').split('/').at(-1) === AI_MODEL_PRESETS[key].model.path.split('/').at(-1),
  ))
  if (blocked.length) return `${blocked.map(key => AI_MODEL_PRESETS[key].displayName).join('、')}：尚未在本设备通过验证，暂不能保存；请移除或更换为其他模型。`
}
