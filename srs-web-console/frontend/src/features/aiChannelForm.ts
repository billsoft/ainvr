import { trackingUnavailableReason } from './trackingPolicy'
import { notificationError } from './analyticsNotification'
import { ruleError } from './analyticsRules'
import { ANALYTICS_PHASE } from './analyticsPhase'
import {
  AI_MODEL_PRESETS, DEFAULT_AI_MODEL_PRESET, isOpenVocabularyPreset, isYoloePreset, promptSlotLimit, type AiPromptLabel, type AiModelPresetKey, type AiModelAdapter, type AiChannel,
  type AiChannelCreatePatch, type AiChannelUpdatePatch, type AiAnalyticsConfig,
} from '@/types/aiChannel'
import { streamKey } from '@/utils/channelMatching'
import { isH265 } from '@/utils/codec'

/** 向导支持当前生产适配器；yolo26_end2end/yolo26_traditional 是
 * ai-service 里存在、但从未在向导里暴露过的"legacy/benchmark 专用"适配器
 * （只能靠绕开向导的 API 调用产生）。 */

/** AI 通道向导表单统一值结构（创建与编辑共用） */
export interface AiWizardFormValue {
  analytics?: AiAnalyticsConfig
  /** 创建后只读（ai-service 侧 `建后不可改`） */
  id: string
  name: string
  streamUrl: string
  streamProtocol: 'rtmp' | 'flv' | 'auto'
  /** 源流是否 H.265：新建时按第①步所选流（SRS 实测编码）算出；编辑时取 ai-service
   * 实测的源编码（stats.video_codec）。决定 H.265 提示与输出封装选项是否出现。 */
  h265: boolean
  modelPreset: AiModelPresetKey
  /** 回填时这个通道真实的 adapter——用来判断"没碰模型这一步的情况下能不能
   * 直接按 modelPreset 重新生成 model/preprocess"，不是展示用字段。
   * 创建模式下恒为 null（没有"原值"这个概念）。 */
  originalAdapter: AiModelAdapter | null
  /** 用户在本次编辑会话里是否显式点过某张模型卡片。区别于"modelPreset
   * 有没有变化"——即使点的卡片跟猜出来的初始值一样，也算"touched"，
   * 这样语义更简单：只要用户在这一步动过手，就按他的选择走。 */
  modelPresetTouched: boolean
  inferenceFps: number
  prompts?: AiPromptLabel[]
  description?: string
  labelId?: string
  labelName?: string
  confThreshold: number
  iouThreshold: number
  maxDetections: number
  resultBufferMaxFrames: number
  publishEnabled: boolean
  /** 空串 = 用 ai-service 默认派生名 rtmp://{rtmp_base}/live/{id}-ai */
  publishTargetUrl: string
  /** H.265 源时 AI 输出的 FLV 写法（高级项），默认 codec12 */
  publishFlvFormat: 'codec12' | 'enhanced'
}

export const DEFAULT_WIZARD_VALUE: AiWizardFormValue = {
  id: '',
  name: '',
  streamUrl: '',
  streamProtocol: 'auto',
  h265: false,
  modelPreset: DEFAULT_AI_MODEL_PRESET,
  originalAdapter: null,
  modelPresetTouched: false,
  inferenceFps: 5,
  confThreshold: 0.25,
  iouThreshold: 0.45,
  maxDetections: 300,
  resultBufferMaxFrames: 30,
  publishEnabled: false,
  publishTargetUrl: '',
  publishFlvFormat: 'codec12',
}

export type FieldErrors = Partial<Record<
  'id' | 'name' | 'streamUrl' | 'inferenceFps' | 'prompts' | 'description' | 'labelId' | 'labelName'
  | 'analytics' | 'coastSeconds' | 'confThreshold' | 'iouThreshold' | 'maxDetections' | 'resultBufferMaxFrames',
  string
>>

const ID_RE = /^[a-zA-Z0-9_-]{1,32}$/
const URL_SCHEME_RE = /^(rtmp|http|https):\/\//i

/** 需要外部 NMS 的适配器——端到端模型（yolo26_trt/yolo26_end2end）NMS
 * 内嵌在模型里，postprocess 的 iou_threshold 对它们不生效，向导第③步
 * 只对这两种模型展示 IoU 阈值控件。 */
export function needsIouThreshold(preset: AiModelPresetKey): boolean {
  return AI_MODEL_PRESETS[preset].needsIouThreshold
}

/** ai-service 默认的 publish.rtmp_base（config.hpp PublishConfig）——AI 服务
 * 与 SRS 同机部署时它拉流/推流走本机回环。 */
export const DEFAULT_AI_RTMP_BASE = 'rtmp://127.0.0.1:1935'

/** 向导拼源流/输出地址用的 SRS 前缀：必须是 **ai-service 视角**能连到的
 * SRS，不能用浏览器地址栏的主机名——经 NAT/端口转发/域名访问控制台时，
 * 那个地址 AI 服务那台机器未必连得上。沿用已有 AI 通道实际在用的
 * rtmp_base（分布式部署时就是运维配过的那个），没有时退回服务默认值。 */
export function aiServiceRtmpBase(aiChannels: AiChannel[]): string {
  const base = aiChannels.find((c) => c.config.publish.rtmp_base)?.config.publish.rtmp_base
  return (base || DEFAULT_AI_RTMP_BASE).replace(/\/+$/, '')
}

/** 多通道并行的输出流冲突检查，规则与 ai-service 写入入口一致（后端是
 * 最终裁决，这里前置提示 + 禁用下拉选项）：
 *   - 输出 = 自己的源流：自己拉自己推，回环；
 *   - 输出 = 别的 AI 通道的输出：两路推同一个流名会互相挤掉；
 *   - 输出 = 别的 AI 通道的源流：会覆盖它的原始画面；
 *   - 源流 = 别的 AI 通道的输出：应选原始源流。
 * selfId：编辑模式下自己的 id（自己现有的输出不算冲突）。 */
export function findOutputConflict(
  v: Pick<AiWizardFormValue, 'streamUrl' | 'publishEnabled' | 'publishTargetUrl'>,
  aiChannels: AiChannel[],
  selfId: string | null,
): string | null {
  const input = streamKey(v.streamUrl)
  const output = v.publishEnabled && v.publishTargetUrl.trim() ? streamKey(v.publishTargetUrl) : null
  if (output && output === input) return `输出流 ${output} 与源流相同，自己拉自己推会形成回环`
  for (const other of aiChannels) {
    if (other.id === selfId) continue
    const otherIn = streamKey(other.config.stream.url)
    const otherOut = other.config.publish.enabled && other.config.publish.target_url
      ? streamKey(other.config.publish.target_url)
      : null
    if (output && output === otherOut) return `输出流 ${output} 已被 AI 通道「${other.name}」使用，两路推同一个流名会互相挤掉`
    if (output && output === otherIn) return `输出流 ${output} 是 AI 通道「${other.name}」的源流，推进去会覆盖它的原始画面`
    if (input && input === otherOut) return `源流 ${input} 是 AI 通道「${other.name}」的输出流，请选择原始源流`
  }
  return null
}

/** 从流名生成通道 id（slug，创建后只读） */
export function generateChannelId(streamName: string): string {
  const slug = streamName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const rand = Math.random().toString(36).slice(2, 6)
  return slug ? `${slug}-${rand}` : `ch-${rand}`
}

/** 第①步：基本信息 + 源流 */
export function validateStep1(v: AiWizardFormValue, isCreate: boolean): FieldErrors {
  const errors: FieldErrors = {}
  if (isCreate && !ID_RE.test(v.id)) {
    errors.id = 'ID 只能包含字母、数字、下划线、短横线（1-32 位）'
  }
  if (v.name.trim().length > 64) errors.name = '名称不能超过 64 字'
  if (!v.streamUrl.trim()) {
    errors.streamUrl = '请选择或输入源流地址'
  } else if (!URL_SCHEME_RE.test(v.streamUrl.trim())) {
    errors.streamUrl = '源流地址必须以 rtmp:// / http:// / https:// 开头'
  }
  return errors
}

/** 第②步：模型与推理——数值范围校验，此前这两步完全没有前端校验，
 * 非法值（负帧率、超范围阈值）全靠后端 422 兜底，用户看到的是一段
 * 结构化英文报错而不知道具体哪个字段错了（审计发现）。范围与输入框
 * 自身的 min/max 属性保持一致，但 min/max 只是浏览器提示，不会阻止
 * React 状态里存进非法值，必须显式校验。 */
export function validateStep2(v: AiWizardFormValue): FieldErrors {
  const errors: FieldErrors = {}
  if (!Number.isFinite(v.inferenceFps) || v.inferenceFps < 0 || v.inferenceFps > 30) {
    errors.inferenceFps = '推理帧率必须在 0-30 之间（0 表示跟随源流帧率）'
  } else if (v.modelPreset === 'locateanything-3b') {
    if (v.inferenceFps < 1 / 3600 || v.inferenceFps > 1)
      errors.inferenceFps = '此模型采集间隔须为 1-3600 秒'
  } else if (v.inferenceFps > 0 && v.inferenceFps < 0.1) {
    // 与 ai-service 校验一致：推理线程按 1/fps 节拍睡眠，过小会让停止通道等很久
    errors.inferenceFps = '推理帧率不能低于 0.1（0 表示跟随源流帧率）'
  }
  if (usesPromptSlots(v.modelPreset) && v.prompts !== undefined) {
    errors.prompts = validatePromptRows(v.prompts, promptSlotLimit(v.modelPreset))
    if (!errors.prompts) delete errors.prompts
  } else if (isOpenVocabularyPreset(v.modelPreset)) {
    if (!v.description?.trim() || v.description.length > 160 || /[<>\u0000-\u001f\u007f]/.test(v.description))
      errors.description = '请输入 1-160 字的单行识别描述，不允许控制标记'
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(v.labelId ?? '')) errors.labelId = '标签 ID 须为 1-64 位字母、数字、下划线或短横线'
    if (!v.labelName?.trim() || v.labelName.length > 64) errors.labelName = '请输入 1-64 字的标签名称'
  }
  return errors
}

/** 第③步：输出与推流——数值范围校验 */
export function validateStep3(v: AiWizardFormValue): FieldErrors {
  const errors: FieldErrors = {}
  if (!Number.isFinite(v.confThreshold) || v.confThreshold < 0.01 || v.confThreshold > 0.95) {
    errors.confThreshold = '置信度阈值必须在 0.01-0.95 之间'
  }
  if (
    needsIouThreshold(v.modelPreset)
    && (!Number.isFinite(v.iouThreshold) || v.iouThreshold < 0.1 || v.iouThreshold > 0.9)
  ) {
    errors.iouThreshold = 'IoU 阈值必须在 0.1-0.9 之间'
  }
  const maxDetections = isYoloePreset(v.modelPreset) ? 300 : 1000
  if (!Number.isInteger(v.maxDetections) || v.maxDetections < 1 || v.maxDetections > maxDetections) {
    errors.maxDetections = `最大检测数必须为 1-${maxDetections} 之间的整数`
  }
  if (!Number.isInteger(v.resultBufferMaxFrames) || v.resultBufferMaxFrames < 1 || v.resultBufferMaxFrames > 300) {
    errors.resultBufferMaxFrames = '结果缓冲帧数必须在 1-300 之间的整数'
  }
  Object.assign(errors, validateVisibleAnalytics(v))
  return errors
}

/** Independent tracking/rules step; also checked at final submission. */
/** 只校验当前阶段界面上能看到的分析设置；未开放功能的旧配置（可能不完整）
 * 原样保留，不得阻止保存跟踪开关。 */
export function validateVisibleAnalytics(v: AiWizardFormValue): FieldErrors {
  const errors: FieldErrors = ANALYTICS_PHASE.rulesAndEvents || ANALYTICS_PHASE.review || ANALYTICS_PHASE.notification
    ? validateAnalyticsStep(v) : {}
  const trackingReason = trackingUnavailableReason(v.modelPreset, v.inferenceFps)
  if (v.analytics?.enabled && trackingReason) errors.analytics = trackingReason
  const coast = v.analytics?.coast_seconds
  if (v.analytics?.enabled && coast !== undefined && (!Number.isFinite(coast) || coast < 0 || coast > 2))
    errors.coastSeconds = '推算显示时长须为 0–2 秒（0 表示不推算）'
  return errors
}

export function validateAnalyticsStep(v: AiWizardFormValue): FieldErrors {
  const errors: FieldErrors = {}
  if(v.analytics?.enabled) {
    const days=v.analytics.retention_days??30
    if(!Number.isInteger(days)||days<1||days>365) errors.analytics='事件保留天数必须为1至365'

    const review=v.analytics.review
    if(review?.enabled) {
      if(v.analytics.save_events===false) errors.analytics='目标复核需要保存区域事件'
      else if(!review.description.trim()||review.description.length>4096) errors.analytics='请填写复核目标描述（最多4096个字符）'
      else if(!review.model_path.trim()) errors.analytics='请选择复核模型'
      else if(!Number.isInteger(review.timeout_seconds??60)||(review.timeout_seconds??60)<5||(review.timeout_seconds??60)>300) errors.analytics='复核最长等待时间必须为5至300秒'
    }
    const notificationProblem=notificationError(v.analytics)
    if(notificationProblem)errors.analytics=notificationProblem
    const rules=v.analytics.rules??[]
    const error=rules.map(ruleError).find(Boolean)
    if(error || new Set(rules.map(r=>r.id)).size!==rules.length || rules.length>64)
      errors.analytics=error || '规则名称不能重复，最多64条规则'
  }
  return errors
}

/** 第③步：跨步校验——推流叠加只支持 RTMP 源，第①步选的流不是 rtmp://
 * 时直接在这里禁用/报错，不要等提交时才收到 422（架构方案要求前置）。
 * ⚠️ 判据只看协议，不看 `publishEnabled` 当前是否已勾选——这是"前置"二字
 * 的关键：若绑定 `publishEnabled &&`，用户在勾选开关之前永远看不到禁用态
 * 和提示，等于跨步校验形同虚设（仍要等到勾上才生效，本质没有前置）。 */
export function validatePublishRequiresRtmp(v: AiWizardFormValue): string | null {
  if (!v.streamUrl.trim().startsWith('rtmp://')) {
    return '仅 RTMP 源支持推流叠加，请在第①步改用 RTMP 地址或关闭推流开关'
  }
  return null
}

/** 模型卡片切换时要写入的整组原子字段（不能只切 model.*，否则推理会用
 * 错误的归一化参数产出垃圾结果且不报错，见架构方案 D6） */
export function applyModelPreset(v: AiWizardFormValue, preset: AiModelPresetKey): AiWizardFormValue {
  return { ...v, modelPreset: preset, modelPresetTouched: true,
    ...(isYoloePreset(preset) ? { inferenceFps: 5,
      description: v.description ?? '', labelId: v.labelId ?? '', labelName: v.labelName ?? '' } : {}),
    ...(preset === 'locateanything-3b' ? { inferenceFps: 1 / 120,
      description: v.description ?? '', labelId: v.labelId ?? '', labelName: v.labelName ?? '' }
      : !isOpenVocabularyPreset(preset) && isOpenVocabularyPreset(v.modelPreset) ? { inferenceFps: 5 } : {}) }
}

function buildModelAndPreprocess(preset: AiModelPresetKey, v: AiWizardFormValue) {
  const p = AI_MODEL_PRESETS[preset]
  return {
    // AI_MODEL_PRESETS 用 `as const` 声明，class_names/input_size/mean/std
    // 在类型层面是 readonly 元组——这里要产出可写的 AiModelConfig，显式
    // 拷贝成普通数组，不是偷懒 as any 绕过去。
    model: {
      ...p.model,
      ...(usesPromptSlots(preset) ? {} : {prompts:null}),
      input_size: [...p.model.input_size] as [number, number],
      class_names: p.model.class_names ? [...p.model.class_names] : null,
      ...(preset === 'locateanything-3b' || isYoloePreset(preset)
        ? { ...promptPatch(v), max_new_tokens: preset === 'locateanything-3b' ? 256 : 64 } : {}),
    },
    preprocess: {
      // Explicit model selection replaces the whole input profile, including
      // resize settings inherited from another model or a historical channel.
      letterbox: preset !== 'locateanything-3b',
      interpolation: preset === 'locateanything-3b' ? 'bicubic' as const : 'bilinear' as const,
      normalize: true,
      ...p.preprocess,
      mean: [...p.preprocess.mean] as [number, number, number],
      std: [...p.preprocess.std] as [number, number, number],
    },
  }
}

/** 组装创建 patch */
export function toCreatePatch(v: AiWizardFormValue): AiChannelCreatePatch {
  const { model, preprocess } = buildModelAndPreprocess(v.modelPreset, v)
  return {
    id: v.id,
    name: v.name.trim() || v.id,
    stream: { url: v.streamUrl.trim(), protocol: v.streamProtocol },
    inference_fps: v.inferenceFps,
    ...(v.analytics ? { analytics: structuredClone(v.analytics) } : {}),
    model,
    preprocess,
    postprocess: {
      conf_threshold: v.confThreshold,
      iou_threshold: v.iouThreshold,
      max_detections: v.maxDetections,
    },
    result_buffer: { max_frames: v.resultBufferMaxFrames },
    publish: {
      enabled: v.publishEnabled,
      // mode 不再由前端选择——ai-service 只剩 passthrough_sei 一种实现
      // （osd_encode 已下线），不发这个字段让后端用它自己的默认值。
      target_url: v.publishTargetUrl.trim() || null,
      sei: {},
      // 默认值不发：不认这个字段的旧版 ai-service 也能照常创建
      ...(v.publishFlvFormat !== 'codec12' ? { flv_format: v.publishFlvFormat } : {}),
    },
  }
}

/** 组装编辑 patch——与 original 对比只发送真正变化的字段。
 *
 * ⚠️ 必须做 diff，不能全量发：后端 classify_channel_patch 按顶层字段
 * 分档（stream/publish/name/model/preprocess 都是 restart 级），如果用户
 * 只改了推理 FPS，但 patch 里带了 stream/publish 等值没变的字段，后端会
 * 误以为这些也变了，触发不必要的重启——重启 10s 超时还可能失败，
 * 表现为"改个 FPS 通道就挂了"。
 *
 * model/preprocess 的判定：includeModelFields 只是"允许修改"的门槛，
 * 真正发不发还要看值是否真的变了——用户点了模型卡片但选的是同一个预设，
 * 也不应该触发重启。 */
export function toUpdatePatch(
  v: AiWizardFormValue,
  original: AiChannel | null,
): AiChannelUpdatePatch {
  const includeModelFields =
    v.originalAdapter === null || v.modelPresetTouched

  // 先组装"目标状态"的完整 patch，再跟 original 做 diff。
  const target: AiChannelUpdatePatch = {
    name: v.name.trim() || v.id,
    stream: { url: v.streamUrl.trim(), protocol: v.streamProtocol },
    inference_fps: v.inferenceFps,
    ...(v.analytics ? { analytics: structuredClone(v.analytics) } : {}),
    ...(includeModelFields
      ? (() => {
          const { model, preprocess } = buildModelAndPreprocess(v.modelPreset, v)
          return { model, preprocess }
        })()
      : {}),
    postprocess: {
      conf_threshold: v.confThreshold,
      iou_threshold: v.iouThreshold,
      max_detections: v.maxDetections,
    },
    result_buffer: { max_frames: v.resultBufferMaxFrames },
    publish: {
      enabled: v.publishEnabled,
      target_url: v.publishTargetUrl.trim() || null,
      sei: {},
      // 原配置里有这个字段、或用户选了非默认值才发——publish 整体下发，漏发会把
      // 原来的 enhanced 冲回默认；原来没有且仍是默认就不发（兼容旧版 ai-service）
      ...(v.publishFlvFormat !== 'codec12' || original?.config.publish.flv_format !== undefined
        ? { flv_format: v.publishFlvFormat }
        : {}),
    },
  }

  if (!original) return target

  const patch: Record<string, unknown> = {}
  const oc = original.config

  // 顶层标量字段
  if (target.name !== oc.name) patch.name = target.name
  if (target.inference_fps !== oc.inference_fps) patch.inference_fps = target.inference_fps

  // stream：整体比较（url + protocol 任一变了就发整个对象）
  if (
    target.stream?.url !== oc.stream.url ||
    target.stream?.protocol !== oc.stream.protocol
  ) {
    patch.stream = target.stream
  }

  // model/preprocess：只有 includeModelFields 且值真的变了才发
  if (includeModelFields && target.model && target.preprocess) {
    const om = oc.model
    const modelChanged = (
      target.model.adapter !== om.adapter ||
      target.model.path !== om.path ||
      target.model.name !== om.name ||
      JSON.stringify(target.model.input_size) !== JSON.stringify(om.input_size) ||
      target.model.stride !== om.stride ||
      target.model.provider !== om.provider ||
      target.model.engine_cache !== om.engine_cache ||
      JSON.stringify(target.model.class_names) !== JSON.stringify(om.class_names ?? null) ||
      JSON.stringify(target.model.prompts) !== JSON.stringify(om.prompts) ||
      target.model.description !== om.description || target.model.label_id !== om.label_id ||
      target.model.label_name !== om.label_name || target.model.max_new_tokens !== om.max_new_tokens
    )
    const op = oc.preprocess
    const preprocessChanged = (
      target.preprocess.letterbox !== op.letterbox ||
      target.preprocess.interpolation !== op.interpolation ||
      target.preprocess.normalize !== op.normalize ||
      JSON.stringify(target.preprocess.mean) !== JSON.stringify(op.mean) ||
      JSON.stringify(target.preprocess.std) !== JSON.stringify(op.std) ||
      target.preprocess.rgb_order !== op.rgb_order
    )
    if (modelChanged) {
      const { description, label_id, label_name, max_new_tokens, prompts, ...structure } = target.model
      const { description: _description, label_id: _labelId, label_name: _labelName,
        max_new_tokens: _tokens, prompts: _prompts, ...oldStructure } = om
      patch.model = isOpenVocabularyPreset(v.modelPreset)
        && (Object.keys(structure) as (keyof typeof structure)[]).every((key) =>
          JSON.stringify(structure[key]) === JSON.stringify(oldStructure[key]))
        ? { description, label_id, label_name, max_new_tokens, prompts } : target.model
    }
    if (preprocessChanged) patch.preprocess = target.preprocess
  }
  // 修改输出、帧率或描述时保留本机已验证的模型路径和硬件后端。
  // 只有用户主动切换模型，才重新生成部署预设。
  if (!includeModelFields && isOpenVocabularyPreset(v.modelPreset)) {
    const query = {
      ...promptPatch(v),
    }
    if (Object.entries(query).some(([key, val]) => JSON.stringify(val) !== JSON.stringify(oc.model[key as keyof typeof oc.model]))) {
      patch.model = query
    }
  }
  // 模型这一步用户没碰过时（else 分支）以前还要单独 diff/发 ai_sample_width/
  // height——2026-09-11 起这两个字段前端不再提供编辑入口、恒为 0，没有
  // "只改了这两个字段"的场景了，不需要这条分支。

  // postprocess：逐项比较，任一变化就整体发
  const op = oc.postprocess
  if (
    target.postprocess?.conf_threshold !== op.conf_threshold ||
    target.postprocess?.iou_threshold !== op.iou_threshold ||
    target.postprocess?.max_detections !== op.max_detections
  ) {
    patch.postprocess = target.postprocess
  }

  // result_buffer
  if (target.result_buffer?.max_frames !== oc.result_buffer.max_frames) {
    patch.result_buffer = target.result_buffer
  }

  // publish：逐项比较，任一变化就整体发（后端 publish 原子更新）。
  // mode 不再参与比较——前端已经不产出这个字段，且它对 GET 回来的通道
  // 恒为 passthrough_sei（osd_encode 已下线，后端加载时会自动改写）。
  const opub = oc.publish
  if (
    target.publish?.enabled !== opub.enabled ||
    target.publish?.target_url !== (opub.target_url ?? null) ||
    (target.publish?.flv_format ?? 'codec12') !== (opub.flv_format ?? 'codec12')
  ) {
    patch.publish = target.publish
  }

  if (target.analytics && JSON.stringify(target.analytics) !== JSON.stringify(oc.analytics)) {
    patch.analytics = target.analytics
  }
  return patch as AiChannelUpdatePatch
}

/** 编辑回填：从 AiChannel（GET 详情/列表拿到的完整视图）还原表单值。
 * modelPreset 只是给模型卡片一个"看起来最接近"的初始高亮，真正决定要不要
 * 用它重新生成 model/preprocess 的是 originalAdapter + modelPresetTouched
 * （见 toUpdatePatch 的注释）。 */
export function fromChannel(ch: AiChannel): AiWizardFormValue {
  const adapter = ch.config.model.adapter
  const modelName = ch.config.model.name
  // 数据驱动查找：优先按 model.name 精确匹配预设，找不到再按 adapter 找第一个匹配项
  let preset: AiModelPresetKey | undefined
  for (const [key, preset_] of Object.entries(AI_MODEL_PRESETS)) {
    if (preset_.model.name === modelName) {
      preset = key as AiModelPresetKey
      break
    }
  }
  if (!preset) {
    for (const [key, preset_] of Object.entries(AI_MODEL_PRESETS)) {
      if (preset_.model.adapter === adapter) {
        preset = key as AiModelPresetKey
        break
      }
    }
  }
  if (!preset) preset = DEFAULT_AI_MODEL_PRESET // 兜底
  return {
    id: ch.id,
    name: ch.name,
    streamUrl: ch.config.stream.url,
    streamProtocol: ch.config.stream.protocol,
    h265: isH265(ch.stats?.video_codec),
    modelPreset: preset,
    originalAdapter: adapter,
    modelPresetTouched: false,
    inferenceFps: ch.config.inference_fps,
    // 只有已保存为多标签的 LocateAnything 通道才回填 prompts；旧的单描述通道
    // 保持原字段，未改动时不会被改写成标签数组。
    ...(adapter === 'locateanything_bpu' && ch.config.model.prompts?.length
      ? { prompts: ch.config.model.prompts.map(row => ({...row})) } : {}),
    ...(adapter === 'yoloe_bpu' ? { prompts: ch.config.model.prompts?.map(row => ({...row})) ??
      (ch.config.model.class_names?.length ? ch.config.model.class_names.map((description, i, all) => ({
        description, label_id: (ch.config.model.label_id ?? 'label') + (all.length > 1 ? `:${i}` : ''),
        label_name: all.length === 1 ? (ch.config.model.label_name ?? description) : description,
      })) : [{description: ch.config.model.description ?? '', label_id: ch.config.model.label_id ?? '', label_name: ch.config.model.label_name ?? ''}]) } : {}),
    description: ch.config.model.description,
    labelId: ch.config.model.label_id,
    labelName: ch.config.model.label_name,
    ...(ch.config.analytics ? { analytics: structuredClone(ch.config.analytics) } : {}),
    confThreshold: ch.config.postprocess.conf_threshold,
    iouThreshold: ch.config.postprocess.iou_threshold,
    maxDetections: ch.config.postprocess.max_detections,
    resultBufferMaxFrames: ch.config.result_buffer.max_frames,
    publishEnabled: ch.config.publish.enabled,
    publishTargetUrl: ch.config.publish.target_url ?? '',
    publishFlvFormat: ch.config.publish.flv_format ?? 'codec12',
  }
}

export function promptRows(v: AiWizardFormValue): AiPromptLabel[] {
  return v.prompts ?? [{description: v.description ?? '', label_id: v.labelId ?? '', label_name: v.labelName ?? ''}]
}
export function validatePromptRows(rows: AiPromptLabel[], limit: number): string | undefined {
  if (!rows.length || rows.length > limit) return `请保留 1-${limit} 个标签，切换小容量模型前请主动删除多余项`
  const ids = new Set<string>(), phrases = new Set<string>()
  for (let i=0; i<rows.length; i++) {
    const row=rows[i]!, prefix=`第 ${i+1} 项：`
    if (!row.description.trim() || row.description.length>160 || /[<>\u0000-\u001f\u007f]/.test(row.description)) return prefix+'请输入 1-160 字的单行识别描述'
    if (!/^[a-zA-Z0-9_:-]{1,64}$/.test(row.label_id)) return prefix+'标签 ID 须为 1-64 位字母、数字、下划线、冒号或短横线'
    if (ids.has(row.label_id)) return prefix+'标签 ID 不能重复'
    if (!row.label_name.trim() || row.label_name.length>64 || /[<>\u0000-\u001f\u007f]/.test(row.label_name)) return prefix+'请输入有效的标签名称'
    const phrase=row.description.trim().toLowerCase()
    if (phrases.has(phrase)) return prefix+'识别描述不能重复'
    ids.add(row.label_id); phrases.add(phrase)
  }
}
/** 可添加多个识别标签的模型：YOLOE 各槽位并行匹配；LocateAnything 每帧一次
 * 查询所有类别，类别越多单帧越慢（由用户决定是否接受）。 */
export function usesPromptSlots(preset: AiModelPresetKey): boolean {
  return isYoloePreset(preset) || preset === 'locateanything-3b'
}
function promptPatch(v: AiWizardFormValue) {
  if (usesPromptSlots(v.modelPreset) && v.prompts !== undefined) {
    const rows=v.prompts.map(row=>({description:row.description.trim(),label_id:row.label_id.trim(),label_name:row.label_name.trim()}))
    return {prompts:rows,description:rows[0]?.description ?? '',label_id:rows[0]?.label_id ?? '',label_name:rows[0]?.label_name ?? '',class_names:null}
  }
  return {description:v.description?.trim(),label_id:v.labelId?.trim(),label_name:v.labelName?.trim()}
}
