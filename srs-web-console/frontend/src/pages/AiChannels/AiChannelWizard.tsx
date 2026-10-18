import { PromptLabelEditor } from './PromptLabelEditor'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, RefreshCw, X } from 'lucide-react'
import {
  DEFAULT_WIZARD_VALUE, aiServiceRtmpBase, applyModelPreset, findOutputConflict, fromChannel,
  generateChannelId, needsIouThreshold, promptRows,
  toCreatePatch, toUpdatePatch, validateStep1, validateStep2, validateStep3, validatePublishRequiresRtmp,
  type AiWizardFormValue, type FieldErrors,
} from '@/features/aiChannelForm'
import { AI_MODEL_PRESETS, DEFAULT_AI_MODEL_PRESET, SELECTABLE_AI_MODEL_PRESET_KEYS, isOpenVocabularyPreset, isYoloePreset, promptSlotLimit, type AiChannel, type AiChannelCreatePatch, type AiChannelUpdatePatch, type AiStreamOption } from '@/types/aiChannel'
import type { ChannelWithStatus } from '@/types/channel'
import { parseStreamPath, streamKey } from '@/utils/channelMatching'
import type { AiServiceCapabilities } from '@/hooks/useAiServiceCapabilities'

const STEPS = ['基本信息', '模型与推理', '输出与推流'] as const

const inputCls =
  'w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none transition-colors focus:border-primary'

interface LockedSourceInfo {
  url: string
  displayLabel: string
  online?: boolean
  h265?: boolean
}

interface Props {
  open: boolean
  mode: 'create' | 'edit'
  initial?: AiChannel | null
  submitting?: boolean
  streams: AiStreamOption[]
  streamsLoading?: boolean
  streamsReady?: boolean
  streamsError?: string | null
  srsChannels?: ChannelWithStatus[]
  /** 现有 AI 通道：输出流防冲突 + 推导 ai-service 视角的 SRS 地址 */
  aiChannels?: AiChannel[]
  /** 锁定第①步源流为指定地址（只读），用于从通道详情页发起创建等场景 */
  lockedSource?: LockedSourceInfo
  onRefreshStreams: () => void
  onClose: () => void
  onSubmit: (patch: AiChannelCreatePatch | AiChannelUpdatePatch) => Promise<void> | void
  /** ai-service 能力（/health 的 capabilities）；null = 还没取到/AI 服务不可达 */
  aiCapabilities?: AiServiceCapabilities | null
}

/** 源是 H.265 时的提示：按 ai-service 实际能力说话（设计 §8.4③），不做无依据的猜测 */
function H265SourceNote({ caps }: { caps: AiServiceCapabilities | null | undefined }) {
  if (caps?.h265) {
    return (
      <p className="mt-1.5 rounded-base border border-line bg-surface-page px-2 py-1 text-xs text-ink-subtle" data-testid="wizard-h265-note">
        H.265 源 · AI 输出同为 H.265（FLV codec12，可在第③步高级项更改）
      </p>
    )
  }
  if (caps && !caps.h265) {
    return (
      <p className="mt-1.5 rounded-base border border-warning-200 bg-warning-50 px-2 py-1 text-xs text-warning-700" data-testid="wizard-h265-note">
        ⚠ 当前 AI 服务版本不支持 H.265 源，请升级 AI 服务或改用 H.264 源
      </p>
    )
  }
  return (
    <p className="mt-1.5 rounded-base border border-line bg-surface-page px-2 py-1 text-xs text-ink-faint" data-testid="wizard-h265-note">
      H.265 源（尚未读取到 AI 服务能力，能否处理以 AI 服务为准）
    </p>
  )
}

export function AiChannelWizard({
  open, mode, initial, submitting = false,
  streams, streamsLoading = false, streamsReady = true, streamsError = null,
  srsChannels = [],
  aiChannels = [],
  lockedSource,
  onRefreshStreams,
  onClose, onSubmit,
  aiCapabilities,
}: Props) {
  const [step, setStep] = useState(0)
  const [value, setValue] = useState<AiWizardFormValue>(DEFAULT_WIZARD_VALUE)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const initializedDraft = useRef<string | null>(null)
  useEffect(() => {
    if (open) onRefreshStreams()
    // Refresh on opening/selection, not on periodic status-object replacement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, initial?.id])
  // 将 AI 服务 listStreams 的在线流按 app/name 建索引，
  // 用于标记 SRS 通道是否在线、是否 H.265（SRS 实测编码）。
  const onlineStreamMap = useMemo(() => {
    const m = new Map<string, AiStreamOption>()
    for (const s of streams) {
      m.set(`${s.app}/${s.name}`, s)
    }
    return m
  }, [streams])

  // 源流/输出地址的 SRS 前缀取 ai-service 视角（不是浏览器地址栏主机名），
  // 见 aiServiceRtmpBase 头注。
  const rtmpBase = useMemo(() => aiServiceRtmpBase(aiChannels), [aiChannels])
  const selfId = mode === 'edit' ? initial?.id ?? null : null
  const srsUrl = (ch: ChannelWithStatus) => `${rtmpBase}/${ch.upstream.app}/${ch.upstream.stream}`

  // 源流下拉：别的 AI 通道的输出流不能再当源流（应选原始源流）
  function sourceOptionBlockReason(ch: ChannelWithStatus): string | null {
    return findOutputConflict(
      { streamUrl: srsUrl(ch), publishEnabled: false, publishTargetUrl: '' }, aiChannels, selfId,
    )
  }

  // 输出下拉：与 AI 通道冲突的，以及正被别人推流（在线、又不是本通道当前输出——
  // 多半是摄像头）的流都不能选，推进去会把对方挤掉。
  function outputOptionBlockReason(ch: ChannelWithStatus): string | null {
    const conflict = findOutputConflict(
      { streamUrl: value.streamUrl, publishEnabled: true, publishTargetUrl: srsUrl(ch) }, aiChannels, selfId,
    )
    if (conflict) return conflict
    const key = `${ch.upstream.app}/${ch.upstream.stream}`
    const ownOutput = initial?.config.publish.target_url ? streamKey(initial.config.publish.target_url) : null
    if (onlineStreamMap.has(key) && key !== ownOutput) return '该流正在被推流（可能是摄像头），推进去会把它挤掉'
    return null
  }

  // Step 1 选中的 SRS 通道 id（用于下拉显示选中值）
  const selectedInputChannelId = useMemo(() => {
    if (!value.streamUrl) return ''
    const parsed = parseStreamPath(value.streamUrl)
    if (!parsed) return ''
    const ch = srsChannels.find(
      (c) => c.upstream.app === parsed.app && c.upstream.stream === parsed.stream,
    )
    return ch?.id ?? ''
  }, [value.streamUrl, srsChannels])

  // Step 3 选中的输出 SRS 通道 id
  const selectedOutputChannelId = useMemo(() => {
    if (!value.publishEnabled) return ''
    // 未指定地址时显示占位项；编辑和新建都必须明确选择输出通道。
    if (!value.publishTargetUrl) return ''
    const parsed = parseStreamPath(value.publishTargetUrl)
    if (!parsed) return ''
    const ch = srsChannels.find(
      (c) => c.upstream.app === parsed.app && c.upstream.stream === parsed.stream,
    )
    return ch?.id ?? ''
  }, [value.publishEnabled, value.publishTargetUrl, srsChannels])


  // AI 处理器只绑定接入管理已有通道；旧地址保留显示，用户明确重选后才变更。
  useEffect(() => {
    if (!open) {
      initializedDraft.current = null
      return
    }
    if (mode === 'edit' && !initial) return
    const draftKey = mode === 'edit' ? `edit:${initial!.id}` : 'create'
    // 同一通道的状态轮询可能返回新对象；只在打开或切换通道时初始化，
    // 避免清掉正在编辑的输出地址、步骤和其他未保存的字段。
    if (initializedDraft.current === draftKey) return
    initializedDraft.current = draftKey
    if (open && mode === 'edit' && initial) {
      const v = fromChannel(initial)
      setValue({ ...v, publishEnabled: true })
      setStep(0)
      setErrors({})
      setSubmitError(null)
    } else if (open && mode === 'create') {
      const base: AiWizardFormValue = { ...DEFAULT_WIZARD_VALUE, publishEnabled: true }
      // 如果传了 lockedSource，预填源流 URL 和默认名称
      if (lockedSource) {
        base.streamUrl = lockedSource.url
        base.h265 = lockedSource.h265 ?? false
        const parsed = parseStreamPath(lockedSource.url)
        if (parsed) {
          base.id = generateChannelId(parsed.stream)
          base.name = `${lockedSource.displayLabel}_AI输出`
        }
      }
      setValue(base)
      setStep(0)
      setErrors({})
      setSubmitError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, initial])

  // 源编码以 SRS 当前实测为准：流列表到达/刷新、或手动改了地址时重新判定（编辑模式
  // 初值来自 ai-service 的 stats.video_codec，通道停着时可能是旧值）
  useEffect(() => {
    if (!open) return
    const parsed = parseStreamPath(value.streamUrl)
    const online = parsed ? onlineStreamMap.get(`${parsed.app}/${parsed.stream}`) : undefined
    if (online && online.h265 !== value.h265) setValue((prev) => ({ ...prev, h265: online.h265 }))
  }, [open, onlineStreamMap, value.streamUrl, value.h265])

  if (!open) return null

  const set = <K extends keyof AiWizardFormValue>(key: K, v: AiWizardFormValue[K]) => {
    setSubmitError(null)
    setValue((prev) => ({ ...prev, [key]: v }))
  }

  function selectSrsChannel(ch: ChannelWithStatus) {
    const key = `${ch.upstream.app}/${ch.upstream.stream}`
    const online = onlineStreamMap.get(key)
    setSubmitError(null)
    setValue((prev) => ({
      ...prev,
      streamUrl: srsUrl(ch),
      streamProtocol: 'rtmp',
      h265: online?.h265 ?? false,
      id: prev.id || generateChannelId(ch.upstream.stream),
    }))
  }

  function selectOutputChannel(ch: ChannelWithStatus) {
    set('publishTargetUrl', srsUrl(ch))
  }

  function selectModel(key: keyof typeof AI_MODEL_PRESETS) {
    setValue((prev) => applyModelPreset(prev, key))
  }

  function handleNext() {
    if (step === 0) {
      const e = validateStep1(value, mode === 'create')
      if (!selectedInputChannelId) e.streamUrl = '请选择接入管理中的输入 SRS 通道'
      const sourceConflict = findOutputConflict(
        { streamUrl: value.streamUrl, publishEnabled: false, publishTargetUrl: '' }, aiChannels, selfId,
      )
      if (!e.streamUrl && sourceConflict) e.streamUrl = sourceConflict
      setErrors(e)
      if (Object.keys(e).length > 0) return
    } else if (step === 1) {
      const e = validateStep2(value)
      setErrors(e)
      if (Object.keys(e).length > 0) return
    }
    setErrors({})
    setStep((s) => s + 1)
  }

  async function handleSubmit() {
    const e = validateStep3(value)
    setErrors(e)
    if (Object.keys(e).length > 0) return

    const input = srsChannels.find((ch) => ch.id === selectedInputChannelId)
    const output = srsChannels.find((ch) => ch.id === selectedOutputChannelId)
    if (!input || !output) {
      setSubmitError('请选择接入管理中的输入和输出 SRS 通道；请先在接入管理中配置缺少的通道')
      return
    }
    const outputBlocked = outputOptionBlockReason(output)
    if (outputBlocked) { setSubmitError(outputBlocked); return }

    const resolved = { ...value, streamUrl: srsUrl(input), streamProtocol: 'rtmp' as const,
      publishEnabled: true, publishTargetUrl: srsUrl(output) }
    const conflict = findOutputConflict(resolved, aiChannels, selfId)
    if (conflict) {
      setSubmitError(conflict)
      return
    }

    setSubmitError(null)
    try {
      await onSubmit(mode === 'create' ? toCreatePatch(resolved) : toUpdatePatch(resolved, initial ?? null))
    } catch (e: any) {
      setSubmitError(e?.message || '保存失败')
    }
  }

  const publishBlockedByProtocol = selectedInputChannelId ? null : validatePublishRequiresRtmp(value)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog" aria-modal="true"
      aria-label={mode === 'create' ? '新建 AI 通道' : '编辑 AI 通道'}
    >
      <div className="flex max-h-[90vh] w-full max-w-[880px] flex-col rounded-panel bg-surface shadow-modal">
        <div className="border-b border-line px-6 pb-4 pt-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-ink">
              {mode === 'create' ? '新建 AI 通道' : `编辑 AI 通道${initial ? ` · ${initial.name}` : ''}`}
            </h3>
            <button type="button" onClick={onClose} className="rounded-base p-1 text-ink-faint hover:bg-surface-page hover:text-ink" aria-label="关闭">
              <X size={18} />
            </button>
          </div>
          <ol className="mt-3 flex items-center gap-2">
            {STEPS.map((label, i) => (
              <li key={label} className="flex items-center gap-2">
                <span className={[
                  'flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                  i < step ? 'bg-success text-white' : i === step ? 'bg-primary text-white' : 'bg-surface-page text-ink-faint',
                ].join(' ')}>
                  {i < step ? <Check size={13} /> : i + 1}
                </span>
                <span className={['text-xs', i === step ? 'font-medium text-ink' : 'text-ink-faint'].join(' ')}>{label}</span>
                {i < STEPS.length - 1 && <span aria-hidden className="mx-1 h-px w-8 bg-line" />}
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-ink-subtle">AI 处理器：输入 SRS 通道 → 模型推理 → 输出 SRS 通道。通道统一在接入管理中配置。</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === 0 && (
            <div className="flex flex-col gap-4">
              <div>
                <label className="text-sm font-medium text-ink">通道 ID {mode === 'create' && <span className="text-danger">*</span>}</label>
                <input
                  value={value.id}
                  disabled={mode === 'edit'}
                  onChange={(e) => set('id', e.target.value)}
                  placeholder="从流名自动生成，可改"
                  className={`mt-1.5 ${inputCls} disabled:bg-surface-page disabled:text-ink-faint`}
                  data-testid="wizard-id"
                />
                {errors.id && <p className="mt-1 text-xs text-danger">{errors.id}</p>}
                {mode === 'edit' && <p className="mt-1 text-xs text-ink-faint">创建后不可修改</p>}
              </div>

              <div>
                <label className="text-sm font-medium text-ink">名称</label>
                <input
                  value={value.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="如：大门人脸识别"
                  className={`mt-1.5 ${inputCls}`}
                  data-testid="wizard-name"
                />
                {errors.name && <p className="mt-1 text-xs text-danger">{errors.name}</p>}
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-ink">源流</label>
                  {!lockedSource && (
                    <button type="button" onClick={onRefreshStreams} className="flex items-center gap-1 text-xs text-primary hover:underline">
                      <RefreshCw size={12} className={streamsLoading ? 'animate-spin' : ''} aria-hidden /> 刷新在线状态
                    </button>
                  )}
                </div>
                {streamsError && !lockedSource && <p role="status" className="mt-1 text-xs text-warning-700" data-testid="wizard-streams-error">{streamsError}</p>}
                {lockedSource ? (
                  <div className="mt-1.5 rounded-base border border-line bg-surface-page px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Check size={14} className="text-success" aria-hidden />
                      <span className="text-sm font-medium text-ink">{lockedSource.displayLabel}</span>
                      <span className={`text-xs ${lockedSource.online ? 'text-success' : 'text-ink-faint'}`}>
                        · {lockedSource.online ? '在线' : '离线'}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-ink-faint" data-testid="wizard-stream-url-display">
                      {lockedSource.url}
                    </p>
                    {lockedSource.h265 && <H265SourceNote caps={aiCapabilities} />}
                  </div>
                ) : (
                  <>
                    {srsChannels.length === 0 ? (
                      <p className="mt-1.5 rounded-base border border-line bg-surface-page px-3 py-2 text-xs text-ink-faint">
                        暂无接入通道，请先在接入管理中添加视频源
                      </p>
                    ) : (
                      <select
                        value={selectedInputChannelId}
                        onChange={(e) => {
                          const ch = srsChannels.find((c) => c.id === e.target.value)
                          if (ch) selectSrsChannel(ch)
                        }}
                        className={`mt-1.5 ${inputCls}`}
                        data-testid="wizard-stream-select"
                      >
                        <option value="" disabled>选择接入通道…</option>
                        {srsChannels.map((ch) => {
                          const key = `${ch.upstream.app}/${ch.upstream.stream}`
                          const online = onlineStreamMap.get(key)
                          const isOnline = !!online
                          const blocked = sourceOptionBlockReason(ch)
                          return (
                            <option key={ch.id} value={ch.id} disabled={!!blocked} title={blocked ?? undefined}>
                              {ch.name}（{ch.upstream.app}/{ch.upstream.stream}） · {!streamsReady ? streamsLoading ? '状态加载中' : '状态未知' : isOnline ? '在线' : '离线'}
                              {online?.h265 ? ' · H.265' : ''}
                              {blocked ? ' · 不可用：是 AI 输出流' : ''}
                            </option>
                          )
                        })}
                      </select>
                    )}
                    {value.streamUrl && !selectedInputChannelId && (
                      <p className="mt-1.5 text-xs text-warning-700">当前输入地址未登记，请先到接入管理配置，再从列表选择。</p>
                    )}
                    <p className="mt-1.5 text-xs text-ink-faint">输入 SRS 通道统一在接入管理配置。</p>
                  </>
                )}
                {!lockedSource && value.streamUrl && (
                  <p className="mt-1.5 truncate text-xs text-ink-faint" data-testid="wizard-stream-url-display">
                    {value.streamUrl}
                  </p>
                )}
                {!lockedSource && value.h265 && <H265SourceNote caps={aiCapabilities} />}
                {errors.streamUrl && <p className="mt-1 text-xs text-danger">{errors.streamUrl}</p>}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="flex flex-col gap-4">
              <div>
                <label className="text-sm font-medium text-ink">模型</label>
                <select aria-label="模型类型" className={`mt-1.5 ${inputCls}`}
                  value={isOpenVocabularyPreset(value.modelPreset) ? 'open' : 'closed'}
                  onChange={(e) => selectModel(e.target.value === 'open' ? 'yoloe-26x' : DEFAULT_AI_MODEL_PRESET)}>
                  <option value="closed">固定类别</option>
                  <option value="open">开放词汇</option>
                </select>
                <p className="mt-1.5 text-xs text-ink-faint">固定类别提供 80 类目标检测和人脸检测；开放词汇可按描述检测目标。模型须完成安装与设备验证才能运行。</p>
                <select
                  value={value.modelPreset}
                  onChange={(e) => selectModel(e.target.value as keyof typeof AI_MODEL_PRESETS)}
                  className={`mt-1.5 ${inputCls}`}
                  data-testid="wizard-model-select"
                >
                  {!SELECTABLE_AI_MODEL_PRESET_KEYS.includes(value.modelPreset) && (
                    <option value={value.modelPreset} disabled>{AI_MODEL_PRESETS[value.modelPreset].label}（旧配置）</option>
                  )}
                  {SELECTABLE_AI_MODEL_PRESET_KEYS.filter((key) =>
                    isOpenVocabularyPreset(key) === isOpenVocabularyPreset(value.modelPreset)).map((key) => {
                    const preset = AI_MODEL_PRESETS[key]
                    return (
                      <option key={key} value={key}>
                        {preset.label} · {preset.description}
                      </option>
                    )
                  })}
                  {isOpenVocabularyPreset(value.modelPreset) && !SELECTABLE_AI_MODEL_PRESET_KEYS.includes('yoloe-26x-32') && <option value="yoloe-26x-32" disabled>开放词汇识别 · 32 槽（编译与验证中）</option>}
                </select>
              </div>

              {isYoloePreset(value.modelPreset) && <PromptLabelEditor rows={promptRows(value)} limit={promptSlotLimit(value.modelPreset)} error={errors.prompts} onChange={rows => set('prompts', rows)} />}
              {value.modelPreset === 'locateanything-3b' && <>
                <label className="text-sm">识别描述（必填，建议英文）
                  <input aria-label="识别描述" value={value.description ?? ''} maxLength={160}
                    onChange={(e) => set('description', e.target.value)} className={`mt-1.5 ${inputCls}`} />
                  {errors.description && <p className="text-danger">{errors.description}</p>}
                </label>
                <label className="text-sm">标签 ID
                  <input aria-label="标签 ID" value={value.labelId ?? ''} maxLength={64}
                    onChange={(e) => set('labelId', e.target.value)} className={`mt-1.5 ${inputCls}`} />
                  {errors.labelId && <p className="text-danger">{errors.labelId}</p>}
                </label>
                <label className="text-sm">标签名称
                  <input aria-label="标签名称" value={value.labelName ?? ''} maxLength={64}
                    onChange={(e) => set('labelName', e.target.value)} className={`mt-1.5 ${inputCls}`} />
                  {errors.labelName && <p className="text-danger">{errors.labelName}</p>}
                </label>
                <p className="text-xs text-ink-faint">{isYoloePreset(value.modelPreset)
                  ? '描述决定识别对象，标签用于检索与匹配。修改描述后会重新载入通道，无需重新编译模型；过长描述会提示缩短，实际效果请结合画面核对。'
                  : '描述决定识别对象，标签用于检索与匹配。此模型不提供置信度；此试用版本的 AI 输出画面延后约 95 秒以匹配识别原帧，原始录像不受此延迟影响，每个识别到的目标仍按归档配置保存。'}</p>
              </>}

              <div>
                <label className="text-sm font-medium text-ink">推理方式</label>
                <div className="mt-1.5 flex gap-2">
                  <span className="rounded-base border border-primary bg-primary-50 px-3 py-1.5 text-xs font-medium text-primary">
                    硬件加速
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-faint">{value.modelPreset === 'locateanything-3b'
                  ? '使用已安装的模型，首次载入需要等待。描述长度还受模型实际容量限制。目前每台设备仅允许一路开放词汇通道运行。'
                  : isYoloePreset(value.modelPreset)
                  ? '使用已安装的设备模型进行硬件加速推理。文字只在载入或修改描述时计算，逐帧识别复用本次结果。首次载入需要等待，运行帧率以实测为准。'
                  : '使用已安装并验证的设备模型进行硬件加速推理。模型未就绪时无法启动，页面不会自动编译模型。'}</p>
              </div>

              <div>
                <label className="text-sm font-medium text-ink">{value.modelPreset === 'locateanything-3b' ? '采集间隔（秒）' : '推理帧率（FPS）'}</label>
                <input
                  type="number" step="any" min={value.modelPreset === 'locateanything-3b' ? 1 : 0}
                  max={value.modelPreset === 'locateanything-3b' ? 3600 : 30}
                  value={Number.isFinite(value.inferenceFps) && (value.modelPreset !== 'locateanything-3b' || value.inferenceFps > 0)
                    ? (value.modelPreset === 'locateanything-3b' ? 1 / value.inferenceFps : value.inferenceFps) : ''}
                  onChange={(e) => set('inferenceFps', value.modelPreset === 'locateanything-3b'
                    ? (e.target.value && Number(e.target.value) > 0 ? 1 / Number(e.target.value) : Number.NaN)
                    : (e.target.value ? Number(e.target.value) : Number.NaN))}
                  className={`mt-1.5 ${inputCls}`}
                />
                <p className="mt-1 text-xs text-ink-faint">
                  {value.modelPreset === 'locateanything-3b' ? '支持 1–3600 秒。较短间隔会增加设备负载；实际采集间隔受推理和归档速度限制，可能长于设定值。每个完成识别的目标仍按归档配置保存。' : <>
                  0 = 跟随源流帧率。不同模型的单帧推理耗时差异很大（同一分辨率下，
                  人脸检测高精度模型可能比通用检测模型慢数倍），设得比所选模型
                  实际跑得动的速度高不会报错，但会长期贴着算力上限运行、几乎没有
                  缓冲余量——一旦叠加瞬时负载或降频等波动，更容易出现推流不稳定
                  （2026-09-09 生产环境实测过一次）。不确定上限时建议先按一个
                  明显留有余量的帧率验证稳定跑一段时间，再逐步调高。
                  </>}
                </p>
                {errors.inferenceFps && <p className="mt-1 text-xs text-danger">{errors.inferenceFps}</p>}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-4">
              {value.modelPreset !== 'locateanything-3b' && <div>
                <label className="text-sm font-medium text-ink">置信度阈值：{value.confThreshold.toFixed(2)}</label>
                <input
                  type="range" min={0.01} max={0.95} step={0.01}
                  value={value.confThreshold}
                  onChange={(e) => set('confThreshold', Number(e.target.value))}
                  className="mt-1.5 w-full"
                />
                {errors.confThreshold && <p className="mt-1 text-xs text-danger">{errors.confThreshold}</p>}
              </div>}

              {needsIouThreshold(value.modelPreset) && (
                <div>
                  <label className="text-sm font-medium text-ink">IoU 阈值：{value.iouThreshold.toFixed(2)}</label>
                  <input
                    type="range" min={0.1} max={0.9} step={0.01}
                    value={value.iouThreshold}
                    onChange={(e) => set('iouThreshold', Number(e.target.value))}
                    className="mt-1.5 w-full"
                  />
                  {errors.iouThreshold && <p className="mt-1 text-xs text-danger">{errors.iouThreshold}</p>}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-ink">最大检测数</label>
                  <input
                    type="number" min={1} max={isYoloePreset(value.modelPreset) ? 300 : 1000}
                    value={value.maxDetections}
                    onChange={(e) => set('maxDetections', Number(e.target.value))}
                    className={`mt-1.5 ${inputCls}`}
                  />
                  {errors.maxDetections && <p className="mt-1 text-xs text-danger">{errors.maxDetections}</p>}
                </div>
                <div>
                  <label className="text-sm font-medium text-ink">结果缓冲帧数</label>
                  <input
                    type="number" min={1} max={300}
                    value={value.resultBufferMaxFrames}
                    onChange={(e) => set('resultBufferMaxFrames', Number(e.target.value))}
                    className={`mt-1.5 ${inputCls}`}
                  />
                  {errors.resultBufferMaxFrames && <p className="mt-1 text-xs text-danger">{errors.resultBufferMaxFrames}</p>}
                </div>
              </div>

              <div className="rounded-base border border-line p-3">
                <p className="text-sm font-medium text-ink">输出 SRS 通道</p>
                {publishBlockedByProtocol && (
                  <p className="mt-1.5 text-xs text-warning-700">{publishBlockedByProtocol}</p>
                )}
                {!publishBlockedByProtocol && (
                  <>
                    <div className="mt-3">
                      <label className="text-xs text-ink-subtle">输出通道</label>
                          <select
                            value={selectedOutputChannelId}
                            onChange={(e) => {
                              const ch = srsChannels.find((c) => c.id === e.target.value)
                              if (ch) selectOutputChannel(ch)
                            }}
                            className={`mt-1 ${inputCls}`}
                            data-testid="wizard-output-select"
                          >
                            <option value="" disabled>
                              选择输出通道…
                            </option>
                            {srsChannels.map((ch) => {
                              const blocked = outputOptionBlockReason(ch)
                              return (
                                <option key={ch.id} value={ch.id} disabled={!!blocked} title={blocked ?? undefined}>
                                  {ch.name}（{ch.upstream.app}/{ch.upstream.stream}）
                                  {blocked ? ` · 不可用：${blocked}` : ''}
                                </option>
                              )
                            })}
                          </select>
                      <p className="mt-1.5 text-xs text-ink-faint">请先在接入管理中配置输出 SRS 通道，再从此处选择；AI 处理器不会创建 SRS 通道。</p>
                      {value.publishTargetUrl && !selectedOutputChannelId && (
                        <p className="mt-1.5 text-xs text-warning-700">当前输出地址未登记，请先到接入管理配置，再从列表选择。</p>
                      )}
                    </div>
                    {value.publishTargetUrl && (
                      <p className="mt-2 truncate text-xs text-ink-faint">
                        推流目标：{value.publishTargetUrl}
                      </p>
                    )}
                    {!value.publishTargetUrl && (
                      <p className="mt-2 text-xs text-ink-faint">
                        请选择接入管理中的输出 SRS 通道。
                      </p>
                    )}
                    <p className="mt-3 text-xs text-ink-faint">
                      AI 处理器读取所选输入通道，将原画面和 SEI 识别结果写入所选输出通道；
                      预览播放器会自动在画面上叠加检测框/关键点（浏览器端渲染，不占用设备编码资源）。
                    </p>
                    {(value.h265 || value.publishFlvFormat !== 'codec12') && (
                      <details className="mt-3 rounded-base border border-line px-3 py-2" data-testid="wizard-flv-format">
                        <summary className="cursor-pointer text-xs text-ink-subtle">高级：H.265 输出封装</summary>
                        <select
                          value={value.publishFlvFormat}
                          onChange={(e) => set('publishFlvFormat', e.target.value as AiWizardFormValue['publishFlvFormat'])}
                          className={`mt-2 ${inputCls}`}
                          aria-label="H.265 输出封装"
                        >
                          <option value="codec12">codec12（默认，兼容面最广）</option>
                          <option value="enhanced" disabled={aiCapabilities ? !aiCapabilities.enhanced : false}>
                            Enhanced RTMP（hvc1，较新的服务器/播放器）
                          </option>
                        </select>
                        <p className="mt-1 text-xs text-ink-faint">只影响 AI 输出流的 FLV 写法；画面与识别结果不变。修改后通道会重启。</p>
                      </details>
                    )}
                  </>
                )}
              </div>

              {submitError && (
                <p className="rounded-base border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">{submitError}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line px-6 py-4">
          <button
            type="button"
            onClick={step === 0 ? onClose : () => setStep((s) => s - 1)}
            className="rounded-base border border-line px-4 py-2 text-sm text-ink-subtle hover:bg-surface-page"
          >
            {step === 0 ? '取消' : '← 上一步'}
          </button>
          {step < STEPS.length - 1 ? (
            <button type="button" onClick={handleNext} className="rounded-base bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-primary-600" data-testid="wizard-next">
              下一步 →
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting}
              onClick={handleSubmit}
              className="rounded-base bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50"
              data-testid="wizard-submit"
            >
              {submitting ? '保存中…' : mode === 'create' ? '创建通道' : '保存修改'}
            </button>
          )}
        </div>
      </div>


    </div>
  )
}
