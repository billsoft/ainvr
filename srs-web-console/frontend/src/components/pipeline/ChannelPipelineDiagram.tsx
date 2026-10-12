import { AlertCircle, CheckCircle2, Circle, Play } from 'lucide-react'
import type { AiChannelState } from '@/types/aiChannel'

/**
 * T 型数据流图组件
 *
 * 可视化展示一路视频的处理链路：
 *   输入流 → [AI 处理 1] → 输出流 1
 *           → [AI 处理 2] → 输出流 2
 *           → ...
 *
 * 纯展示组件，所有状态由父组件传入，不自己发请求。
 *
 * ⚠️ SRS 通道 ↔ AI 通道的匹配策略（父组件负责）：
 * AI 通道的 stream.url 是完整 RTMP URL（host 可能是 127.0.0.1 /
 * localhost / 192.168.x.x 等），不能拿字符串直接比。匹配时要从 URL
 * 里解析出 app/stream 段，和 SRS 通道的 upstream.app/upstream.stream
 * 结构化对比，忽略 host 和协议前缀。
 */

export interface PipelineProcessNode {
  id: string
  label: string
  state: AiChannelState
  /** 推理 FPS（运行中才显示） */
  fps?: number
  /** 端到端延迟 p95，单位 ms（运维关键指标） */
  p95Ms?: number
  /** 原始源流 URL（供父组件匹配用，不展示） */
  streamUrl?: string
  /** 输出流名称，如 "live/phase6_test_ai" */
  outputStream?: string
  /** 点击输出流播放按钮的回调 */
  onPlayStream?: () => void
}

interface Props {
  /** 输入流名称，如 "live/phase6_test" */
  inputName: string
  /** 输入流是否在线 */
  inputOnline: boolean
  /** 源通道是否已被删除（AI 处理变成孤儿） */
  inputMissing?: boolean
  /** AI 处理节点列表 */
  processes: PipelineProcessNode[]
  /** 添加 AI 处理的回调，undefined 则不显示添加按钮 */
  onAddProcess?: () => void
  className?: string
}

/** 状态 → 图标（与 AiChannelStatusBadge 同一套语义分类：
 * running=成功绿 / idle+stopping=灰 / starting+reconnecting=过渡态 / error=红）
 * 配色与 AiChannelStatusBadge.tsx 保持一致，不造第二套。 */
const STATE_ICON = {
  running: CheckCircle2,
  idle: Circle,
  error: AlertCircle,
  starting: Circle,
  stopping: Circle,
  reconnecting: AlertCircle,
} as const

const STATE_COLOR = {
  running: 'text-success',
  idle: 'text-ink-faint',
  error: 'text-danger',
  starting: 'text-info',
  stopping: 'text-ink-faint',
  reconnecting: 'text-info',
} as const

const STATE_LABEL = {
  running: '运行中',
  idle: '已停止',
  error: '异常',
  starting: '启动中',
  stopping: '停止中',
  reconnecting: '重连中',
} as const

const STATE_BADGE_BG = {
  running: 'bg-success-100 text-success-700 border-success-200',
  idle: 'bg-ink-100 text-ink-500 border-ink-200',
  error: 'bg-danger-100 text-danger-700 border-danger-200',
  starting: 'bg-info-100 text-info-700 border-info-200',
  stopping: 'bg-ink-100 text-ink-500 border-ink-200',
  reconnecting: 'bg-info-100 text-info-700 border-info-200',
} as const

export function ChannelPipelineDiagram({
  inputName,
  inputOnline,
  inputMissing = false,
  processes,
  onAddProcess,
  className = '',
}: Props) {
  return (
    <div className={`rounded-panel border border-line bg-surface p-5 shadow-card ${className}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">数据流处理链路</h3>
        {onAddProcess && (
          <button
            type="button"
            onClick={onAddProcess}
            className="inline-flex items-center gap-1 rounded-base border border-line px-3 py-1.5 text-xs text-ink hover:bg-surface-page"
          >
            <Play size={12} /> 添加 AI 处理
          </button>
        )}
      </div>

      <div className="mt-4 flex items-stretch gap-2">
        {/* 输入流 */}
        <div className="flex flex-col items-center justify-center">
          <div
            className={`flex w-28 flex-col items-center gap-2 rounded-base border px-3 py-4 ${
              inputMissing
                ? 'border-warning-300 bg-warning-50'
                : inputOnline
                ? 'border-success-300 bg-success-50'
                : 'border-danger-300 bg-danger-50 opacity-70'
            }`}
          >
            {inputMissing ? (
              <AlertCircle size={20} className="text-warning" />
            ) : inputOnline ? (
              <CheckCircle2 size={20} className="text-success" />
            ) : (
              <AlertCircle size={20} className="text-danger" />
            )}
            <div className="w-full text-center">
              <p className="text-xs font-medium text-ink">输入流</p>
              <p
                className="mt-0.5 truncate font-mono text-[11px] text-ink-subtle"
                title={inputName}
              >
                {inputMissing ? '未配置源' : inputName}
              </p>
            </div>
          </div>
        </div>

        {/* 连接线 */}
        <div className="flex items-center">
          <div className="h-px w-4 bg-line" />
        </div>

        {/* AI 处理 + 输出流（多个并列） */}
        {processes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-base border border-dashed border-line bg-surface-page/50 px-6 py-6">
            <div className="text-center">
              <p className="text-xs text-ink-faint">尚未配置 AI 处理</p>
              {onAddProcess && (
                <button
                  type="button"
                  onClick={onAddProcess}
                  className="mt-2 text-xs font-medium text-primary hover:underline"
                >
                  现在添加
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-wrap gap-3">
            {processes.map((p) => {
              const StatusIcon = STATE_ICON[p.state] ?? Circle
              const statusColor = STATE_COLOR[p.state] ?? 'text-ink-faint'
              const badgeBg = STATE_BADGE_BG[p.state] ?? ''
              return (
                <div key={p.id} className="flex items-stretch gap-2">
                  {/* AI 处理节点 */}
                  <div className="flex w-40 flex-col gap-2 rounded-base border border-line bg-surface-page px-3 py-3">
                    <div className="flex items-center gap-2">
                      <StatusIcon size={16} className={`shrink-0 ${statusColor}`} />
                      <span
                        className={`inline-flex flex-1 items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-medium ${badgeBg} border`}
                      >
                        {STATE_LABEL[p.state] ?? p.state}
                      </span>
                    </div>
                    <p
                      className="truncate text-xs font-medium text-ink"
                      title={p.label}
                    >
                      {p.label}
                    </p>
                    {p.state === 'running' && (
                      <div className="flex items-center justify-between text-[10px] text-ink-faint">
                        <span>{p.fps?.toFixed(1) ?? '-'} FPS</span>
                        <span>p95 {p.p95Ms?.toFixed(0) ?? '-'}ms</span>
                      </div>
                    )}
                  </div>

                  {/* 输出流节点 */}
                  {p.outputStream && (
                    <>
                      <div className="flex items-center">
                        <div className="h-px w-3 bg-line" />
                      </div>
                      <div className="flex w-32 flex-col items-center justify-center gap-2 rounded-base border border-line/70 bg-surface px-2 py-3">
                        <Play size={14} className="text-ink-subtle" />
                        <div className="w-full text-center">
                          <p className="text-[10px] text-ink-faint">输出流</p>
                          <p
                            className="mt-0.5 truncate font-mono text-[10px] text-ink-subtle"
                            title={p.outputStream}
                          >
                            {p.outputStream.split('/').slice(-1)[0]}
                          </p>
                        </div>
                        {p.onPlayStream && (
                          <button
                            type="button"
                            onClick={p.onPlayStream}
                            className="text-[10px] font-medium text-primary hover:underline"
                          >
                            播放
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {processes.length > 0 && (
        <p className="mt-3 text-[11px] text-ink-faint">
          共 {processes.length} 个 AI 处理
          {inputMissing && ' · 源通道已删除，AI 处理保留'}
          {!inputMissing && !inputOnline && ' · 源流离线'}
          {processes.some((p) => p.state === 'error') && ' · 有处理异常'}
        </p>
      )}
    </div>
  )
}
