import { Loader2 } from 'lucide-react'
import type { AiChannelState } from '@/types/aiChannel'

// 不改现有 StatusBadge.tsx——它是 boolean online/offline 二态设计，
// AI 通道需要 运行中/已停止/启动中·重启中/错误/服务不可达 五态，
// 改它的 prop 类型会影响现有通道页。

type Bucket = 'running' | 'stopped' | 'transitioning' | 'error' | 'unreachable'

const BUCKET_STYLE: Record<Bucket, { label: string; className: string }> = {
  running: { label: '运行中', className: 'bg-success-50 text-success-700' },
  stopped: { label: '已停止', className: 'bg-surface-page text-ink-subtle' },
  transitioning: { label: '', className: 'bg-primary-50 text-primary-700' }, // label 动态填状态文字
  error: { label: '错误', className: 'bg-danger-50 text-danger-700' },
  unreachable: { label: '服务不可达', className: 'bg-surface-page text-ink-faint' },
}

function bucketOf(state: AiChannelState): Bucket {
  switch (state) {
    case 'running': return 'running'
    case 'idle': return 'stopped'
    case 'starting': case 'stopping': case 'reconnecting': return 'transitioning'
    case 'error': return 'error'
    default: return 'stopped'
  }
}

const TRANSITION_LABEL: Record<string, string> = {
  starting: '启动中', stopping: '停止中', reconnecting: '重连中',
}

export function AiChannelStatusBadge({
  state, unreachable = false,
}: { state: AiChannelState; unreachable?: boolean }) {
  const bucket: Bucket = unreachable ? 'unreachable' : bucketOf(state)
  const style = BUCKET_STYLE[bucket]
  const label = bucket === 'transitioning' ? (TRANSITION_LABEL[state] ?? '处理中') : style.label

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>
      {bucket === 'transitioning' && <Loader2 size={11} className="animate-spin" aria-hidden />}
      {label}
    </span>
  )
}
