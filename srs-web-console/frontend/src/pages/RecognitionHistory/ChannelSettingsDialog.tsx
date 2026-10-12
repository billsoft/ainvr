import { useEffect, useState } from 'react'
import { Sun, Trash2 } from 'lucide-react'
import type { AiFaceEnhanceModel, AiSnapshotProjectionMode } from '@/types/aiChannel'
import { historyTrimLoss } from '@/features/saveImpact'

const PROJECTION_MODE_LABEL: Record<AiSnapshotProjectionMode, string> = {
  none: '不启用坐标转换',
  erp_equirect: 'ERP 全景图坐标展开',
}

/** 下拉选项与随选择变化的说明文案（简略）。画布尺寸/门槛必须与
 * ai-service output/face_enhancer.py::MODEL_SPECS 保持一致。 */
const FACE_MODEL_OPTIONS: { value: AiFaceEnhanceModel; label: string }[] = [
  { value: 'none', label: '不开启' },
  { value: 'gpen', label: 'GPEN256 人脸增强（256×256）' },
]

const FACE_MODEL_DESC: Record<AiFaceEnhanceModel, string> = {
  none: '不做人脸修复，截图原样保存。',
  gpen: '仅宽高都小于 256 的小脸修复为 256×256，等比缩放、灰边补齐不变形。',
  codeformer: '精细修复：宽高都小于 512 的人脸修复为 512×512，细节更好、速度较慢。',
}

/** 亮度滑块范围/步进，必须与 ai-service SnapshotConfig 校验器一致
 * （config.py::validate_brightness_target 的 [0,255]，全范围不设人为上下限）。 */
const BRIGHTNESS_MIN = 0
const BRIGHTNESS_MAX = 255
const BRIGHTNESS_DEFAULT = 128

export interface ChannelSettingsPatch {
  max_count?: number
  projection_mode?: AiSnapshotProjectionMode
  brightness_enabled?: boolean
  brightness_target?: number
  face_enhance_model?: AiFaceEnhanceModel
  face_enhance_blend?: number
}

interface Props {
  open: boolean
  channelName: string
  currentMax: number
  currentProjectionMode: AiSnapshotProjectionMode
  /** 截图亮度校正开关 + 目标亮度（80-180，128=中性），热更新不重启 */
  currentBrightnessEnabled: boolean
  currentBrightnessTarget: number
  /** 当前人脸修复模型（gpen=256 画布 / codeformer=512 画布 / none=不开） */
  currentFaceModel: AiFaceEnhanceModel
  /** 增强强度 0-1（1=全量，0.5=半强度） */
  currentFaceBlend: number
  /** 只有人脸识别通道才能选修复模型，目标检测通道整块置灰 */
  faceChannel: boolean
  hasRecords: boolean
  /** 当前记录条数：调低上限低于它时需确认淘汰条数 */
  currentCount?: number
  onSave: (patch: ChannelSettingsPatch) => void
  onRequestClear: () => void
  onClose: () => void
}

/** 通道识别历史设置——原来"改上限"和顶部"投影模式"下拉是两个分散入口，
 * 合并成一个弹窗：只读信息（数量/占用）留在页面上直接可见，这里只放
 * 需要编辑确认的字段。max_count / projection_mode / face_enhance_blend
 * 属于 ai-service 侧 SNAPSHOT_HOT_SUBFIELDS（config.py 头注），热生效；
 * face_enhance_model 是结构性字段（要加载/更换 TRT engine、门槛与输出
 * 尺寸也随模型变化），带它的 PATCH 会重启通道，提示文案里写清楚。
 * "清空"是破坏性操作，单独放危险区，点击后交给外层 ConfirmDialog 二次
 * 确认。 */
export function ChannelSettingsDialog({
  open, channelName, currentMax, currentProjectionMode,
  currentBrightnessEnabled, currentBrightnessTarget,
  currentFaceModel,
  currentFaceBlend, faceChannel,
  hasRecords, currentCount = 0,
  onSave, onRequestClear, onClose,
}: Props) {
  const [trimConfirm, setTrimConfirm] = useState(false)
  const [maxValue, setMaxValue] = useState(String(currentMax))
  const [projectionMode, setProjectionMode] = useState<AiSnapshotProjectionMode>(currentProjectionMode)
  const [brightnessOn, setBrightnessOn] = useState(currentBrightnessEnabled)
  const [brightnessTarget, setBrightnessTarget] = useState(currentBrightnessTarget)
  const [faceModel, setFaceModel] = useState<AiFaceEnhanceModel>(currentFaceModel)
  // 滑块用百分数展示（0-100），保存时换回 0-1 系数——外部一律 0-1，
  // 避免"0.5 被当成 50% 还是 0.5%"这类单位歧义
  const [blendPct, setBlendPct] = useState(Math.round(currentFaceBlend * 100))

  useEffect(() => {
    if (open) {
      setTrimConfirm(false)
      setMaxValue(String(currentMax))
      setProjectionMode(currentProjectionMode)
      setBrightnessOn(currentBrightnessEnabled)
      setBrightnessTarget(currentBrightnessTarget)
      setFaceModel(currentFaceModel)
      setBlendPct(Math.round(currentFaceBlend * 100))
    }
  }, [
    open, currentMax, currentProjectionMode,
    currentBrightnessEnabled, currentBrightnessTarget,
    currentFaceModel, currentFaceBlend,
  ])

  // 只能点「取消」或右上角关闭：点遮罩、误按 Esc 都不关闭，避免已填写的内容白输入

  if (!open) return null

  const parsedMax = Number(maxValue)
  const maxValid = Number.isInteger(parsedMax) && parsedMax > 0
  const trimLoss = maxValid && parsedMax < currentMax ? historyTrimLoss(currentCount, parsedMax) : 0

  function handleSave() {
    // 调低上限会立即淘汰最旧记录，不可恢复：先展示条数，再次点击才保存
    if (trimLoss > 0 && !trimConfirm) { setTrimConfirm(true); return }
    const patch: ChannelSettingsPatch = {}
    if (parsedMax !== currentMax) patch.max_count = parsedMax
    if (projectionMode !== currentProjectionMode) patch.projection_mode = projectionMode
    if (brightnessOn !== currentBrightnessEnabled) patch.brightness_enabled = brightnessOn
    // 关着的时候拖过滑块不产生无意义变更；开启状态下目标值变了才下发
    if (brightnessOn && brightnessTarget !== currentBrightnessTarget) {
      patch.brightness_target = brightnessTarget
    }
    if (faceModel !== currentFaceModel) patch.face_enhance_model = faceModel
    const blend = blendPct / 100
    if (Math.abs(blend - currentFaceBlend) > 0.001) patch.face_enhance_blend = blend
    if (Object.keys(patch).length > 0) onSave(patch)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={`「${channelName}」识别历史设置`}
    >
      <div className="w-[420px] rounded-panel bg-surface p-6 shadow-modal">
        <h3 className="text-base font-semibold text-ink">「{channelName}」识别历史设置</h3>
        <p className="mt-2 text-xs text-ink-subtle">逐帧保存识别目标截图；写入积压时识别会减速，优先保留待存截图。达到上限后滚动删除最旧记录。</p>

        <div className="mt-4">
          <label className="text-xs text-ink-subtle">保留条数上限</label>
          <input
            autoFocus
            type="number"
            min={1}
            step={1}
            value={maxValue}
            onChange={(e) => { setMaxValue(e.target.value); setTrimConfirm(false) }}
            className="mt-1.5 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
            data-testid="max-count-input"
          />
          {!maxValid && (
            <p className="mt-1 text-xs text-danger">请输入大于 0 的整数</p>
          )}
          <p className="mt-1 text-xs text-ink-faint">超出上限的最旧记录会被自动淘汰（按识别框计，不是按帧）</p>
          {trimConfirm && trimLoss > 0 && (
            <p role="alert" className="mt-2 rounded-base bg-danger-50 p-2 text-xs text-danger-700" data-testid="trim-warning">
              保存后将立即删除最旧的 {trimLoss.toLocaleString()} 条识别记录及截图，不可恢复。再次点击保存确认。
            </p>
          )}
        </div>

        <div className="mt-4">
          <label className="text-xs text-ink-subtle">截图变换</label>
          <select
            value={projectionMode}
            onChange={(e) => setProjectionMode(e.target.value as AiSnapshotProjectionMode)}
            className="mt-1.5 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
            data-testid="projection-mode-select"
          >
            <option value="none">{PROJECTION_MODE_LABEL.none}</option>
            <option value="erp_equirect">{PROJECTION_MODE_LABEL.erp_equirect}</option>
            <option value="__distortion_correction_soon" disabled>畸变矫正（即将推出）</option>
          </select>
          <p className="mt-1 text-xs text-ink-faint">全景相机截图变形时选 ERP 全景图坐标展开，普通相机保持不启用</p>
        </div>

        <div className="mt-4" data-testid="brightness-block">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1 text-xs text-ink-subtle" htmlFor="brightness-toggle">
              <Sun size={12} aria-hidden />截图亮度校正
            </label>
            <button
              id="brightness-toggle"
              type="button"
              role="switch"
              aria-checked={brightnessOn}
              onClick={() => setBrightnessOn((v) => !v)}
              className={`relative h-5 w-9 rounded-full transition-colors ${
                brightnessOn ? 'bg-primary' : 'bg-line'
              }`}
              data-testid="brightness-toggle"
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                  brightnessOn ? 'left-[18px]' : 'left-0.5'
                }`}
              />
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            保存前对截图做局部自适应曝光：暗景提亮、高光不顶爆，在人脸增强之前执行。
            纯图像处理、不占推理线程，不影响检测帧率。
          </p>
          <div className="mt-2" data-testid="brightness-slider-row">
            <div className="flex items-center justify-between">
              <label htmlFor="brightness-slider" className="text-xs text-ink-subtle">
                目标亮度
              </label>
              <span className="text-xs font-medium text-ink" data-testid="brightness-value">
                {brightnessTarget}
              </span>
            </div>
            <input
              id="brightness-slider"
              type="range"
              min={BRIGHTNESS_MIN}
              max={BRIGHTNESS_MAX}
              step={1}
              value={brightnessTarget}
              disabled={!brightnessOn}
              onChange={(e) => setBrightnessTarget(Number(e.target.value))}
              className="mt-1 w-full accent-primary disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="brightness-slider"
            />
            <div className="flex justify-between text-[10px] text-ink-faint">
              <span>偏暗 {BRIGHTNESS_MIN}</span>
              <span>中性 {BRIGHTNESS_DEFAULT}</span>
              <span>偏亮 {BRIGHTNESS_MAX}</span>
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              截图整体曝光会被拉向这个目标值，正常曝光的画面只做轻微修正。
              开关与滑块都即时生效，不需要重启。
            </p>
          </div>
        </div>

        <div className="mt-4">
          <label
            className="block text-xs text-ink-subtle"
            htmlFor="face-enhance-model"
          >
            人脸增强后保存
          </label>
          <select
            id="face-enhance-model"
            value={faceChannel ? faceModel : 'none'}
            disabled={!faceChannel}
            onChange={(e) => setFaceModel(e.target.value as AiFaceEnhanceModel)}
            className="mt-1.5 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="face-enhance-model"
          >
            {faceChannel && faceModel === 'codeformer' && (
              <option value="codeformer" disabled>旧增强模型（不再提供新配置）</option>
            )}
            {FACE_MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-faint" data-testid="face-enhance-desc">
            {FACE_MODEL_DESC[faceChannel ? faceModel : 'none']}
            {faceChannel && faceModel !== 'none' && '切换模型保存后通道重启生效。'}
          </p>
          {!faceChannel && (
            <p className="mt-0.5 text-xs text-warning-600">仅人脸识别通道支持</p>
          )}

          {faceChannel && (
            <div className="mt-2" data-testid="face-blend-row">
              <div className="flex items-center justify-between">
                <label htmlFor="face-blend-slider" className="text-xs text-ink-subtle">
                  增强强度
                </label>
                <span className="text-xs font-medium text-ink" data-testid="face-blend-value">
                  {blendPct}%
                </span>
              </div>
              <input
                id="face-blend-slider"
                type="range"
                min={0}
                max={100}
                step={5}
                value={blendPct}
                disabled={faceModel === 'none'}
                onChange={(e) => setBlendPct(Number(e.target.value))}
                className="mt-1 w-full accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="face-blend-slider"
              />
              <div className="flex justify-between text-[10px] text-ink-faint">
                <span>原图（只放大）</span>
                <span>半强度 50%</span>
                <span>全量 100%</span>
              </div>
              <p className="mt-1 text-xs text-ink-faint">
                强度是增强结果与原图的混合比例：过高容易出现"塑料脸"、五官轻微变形，
                觉得画面假就往小调。强度调整即时生效，不需要重启。
              </p>
            </div>
          )}
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <p className="text-xs font-medium text-danger">危险操作</p>
          <button
            type="button"
            disabled={!hasRecords}
            onClick={onRequestClear}
            className="mt-2 flex items-center gap-1.5 rounded-base border border-danger/30 px-3 py-1.5 text-xs text-danger hover:bg-danger-50 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="open-clear-confirm"
          >
            <Trash2 size={13} aria-hidden />清空识别历史
          </button>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-base border border-line px-4 py-2 text-sm text-ink-subtle hover:bg-surface-page"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!maxValid}
            onClick={handleSave}
            className="rounded-base bg-primary px-4 py-2 text-sm text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="settings-save"
          >
            {trimConfirm && trimLoss > 0 ? '确认删除并保存' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
