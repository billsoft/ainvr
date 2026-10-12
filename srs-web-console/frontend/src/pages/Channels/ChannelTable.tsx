import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Copy, Eye, Pencil, Trash2 } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { ProtocolTag } from '@/components/common/ProtocolTag'
import { formatBitrate, formatDuration } from '@/utils/format'
import { UPSTREAM_LABEL, type ChannelWithStatus } from '@/types/channel'
import { useAiChannelsStore } from '@/store/aiChannels'
import { parseStreamPath } from '@/utils/channelMatching'
import { formatCodec, isH265 } from '@/utils/codec'

interface Props {
  rows: ChannelWithStatus[]
  pipeline: Record<string, ChannelPipelineStatus>
  host: string
  onPreview: (ch: ChannelWithStatus) => void
  onCopyPush: (ch: ChannelWithStatus) => void
  onEdit: (ch: ChannelWithStatus) => void
  onDelete: (ch: ChannelWithStatus) => void
}

export interface PipelineState {
  label: string
  tone: 'success' | 'warning' | 'danger' | 'muted'
  detail?: string
  to?: string
}
export interface ChannelPipelineStatus { recording: PipelineState; ai: PipelineState }

const badgeTone: Record<PipelineState['tone'], string> = {
  success: 'bg-success-50 text-success-700', warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-danger-50 text-danger-700', muted: 'bg-surface-page text-ink-subtle',
}
function PipelineBadge({ value }: { value: PipelineState }) {
  const badge = <span title={value.detail} className={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-xs ${badgeTone[value.tone]}`}>{value.label}</span>
  return value.to ? <Link to={value.to} className="rounded focus-visible:outline">{badge}</Link> : badge
}

/** 通道列表表格（DEV_PLAN 4.1 列设计） */
export function ChannelTable({ rows, pipeline, onPreview, onCopyPush, onEdit, onDelete }: Props) {
  const { channels: aiChannels } = useAiChannelsStore()

  // 构建 AI 输出流的 app/stream → AI 通道 ID 映射
  // 遍历所有 AI 通道，如果 publish.enabled 且有 effective_target_url，
  // 解析出 app/stream，与 SRS 通道的 upstream 匹配，即可识别哪些 SRS 通道是 AI 输出。
  const aiOutputMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const ai of aiChannels) {
      if (!ai.config.publish.enabled || !ai.config.publish.effective_target_url) continue
      const parsed = parseStreamPath(ai.config.publish.effective_target_url)
      if (!parsed) continue
      m.set(`${parsed.app}/${parsed.stream}`, ai.id)
    }
    return m
  }, [aiChannels])

  const aiChannelIdOf = (ch: ChannelWithStatus): string | undefined =>
    aiOutputMap.get(`${ch.upstream.app}/${ch.upstream.stream}`)

  return (
    <div role="region" aria-label="接入通道表格" tabIndex={0} className="overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="w-full min-w-[1020px] text-sm">
        <thead>
          <tr className="whitespace-nowrap border-b border-line bg-surface-page text-left text-xs text-ink-subtle">
            <th className="px-4 py-3 font-medium">状态</th>
            <th className="px-4 py-3 font-medium">录像</th>
            <th className="px-4 py-3 font-medium">AI 识别</th>
            <th className="px-4 py-3 font-medium">通道名称</th>
            <th className="px-4 py-3 font-medium">上行</th>
            <th className="px-4 py-3 font-medium">编码</th>
            <th className="px-4 py-3 font-medium">观看</th>
            <th className="px-4 py-3 font-medium">码率</th>
            <th className="px-4 py-3 font-medium">运行时长</th>
            <th className="px-4 py-3 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((ch) => {
            const aiId = aiChannelIdOf(ch)
            const flow = pipeline[ch.id]
            return (
              <tr
                key={ch.id}
                className="border-b border-line/60 transition-colors last:border-0 hover:bg-primary-50/50"
                data-testid={`channel-row-${ch.id}`}
              >
                <td className="px-4 py-3">
                  <StatusBadge online={ch.status.online} />
                </td>
                <td className="px-4 py-3"><PipelineBadge value={flow?.recording ?? { label: '读取中', tone: 'muted' }} /></td>
                <td className="px-4 py-3"><PipelineBadge value={flow?.ai ?? { label: '读取中', tone: 'muted' }} /></td>
                <td className="px-4 py-3">
                  <div className="flex items-start gap-2">
                    <a
                      href={`/channels/${ch.id}`}
                      onClick={(e) => {
                        e.preventDefault()
                        onPreview(ch)
                      }}
                      className="font-medium text-ink hover:text-primary"
                      title="查看详情"
                    >
                      {ch.name}
                    </a>
                    {aiId && (
                      <span
                        className="inline-flex shrink-0 items-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20"
                        data-testid={`ai-output-badge-${ch.id}`}
                      >
                        AI 输出
                      </span>
                    )}
                  </div>
                  {ch.description && (
                    <div className="mt-0.5 text-xs text-ink-faint">{ch.description}</div>
                  )}
                  <div className="mt-0.5 font-mono text-xs text-ink-faint">
                    {ch.upstream.app}/{ch.upstream.stream}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <ProtocolTag label={UPSTREAM_LABEL[ch.upstream.protocol]} />
                </td>
                <td className="px-4 py-3 font-mono text-xs" data-testid={`codec-${ch.id}`}>
                  {ch.status.online && ch.status.videoCodec ? (
                    <span className={isH265(ch.status.videoCodec)
                      ? 'rounded-base bg-primary-50 px-1.5 py-0.5 text-primary-600'
                      : 'text-ink-subtle'}
                    >
                      {formatCodec(ch.status.videoCodec)}
                    </span>
                  ) : <span className="text-ink-faint">-</span>}
                </td>
                <td className="px-4 py-3 font-mono text-ink-subtle">
                  {ch.status.online ? ch.status.viewerCount : '-'}
                </td>
                <td className="px-4 py-3 font-mono text-ink-subtle">
                  {ch.status.online ? formatBitrate(ch.status.bitrateKbps) : '-'}
                </td>
                <td className="px-4 py-3 text-ink-subtle">
                  {ch.status.online ? formatDuration(ch.status.durationSec) : '-'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col items-end gap-1">
                    {aiId && (
                      <Link
                        to="/ai-channels"
                        className="text-xs text-indigo-600 hover:text-indigo-800"
                        data-testid={`ai-channel-link-${ch.id}`}
                      >
                        查看 AI 通道
                      </Link>
                    )}
                    <div className="flex items-center justify-end gap-0.5">
                      <button
                        type="button"
                        onClick={() => onPreview(ch)}
                        title="预览"
                        className="rounded-base p-1.5 text-ink-subtle hover:bg-primary-100 hover:text-primary"
                      >
                        <Eye size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onCopyPush(ch)}
                        title="复制推流地址"
                        className="rounded-base p-1.5 text-ink-subtle hover:bg-primary-100 hover:text-primary"
                      >
                        <Copy size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onEdit(ch)}
                        title="编辑"
                        className="rounded-base p-1.5 text-ink-subtle hover:bg-primary-100 hover:text-primary"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(ch)}
                        title="删除"
                        className="rounded-base p-1.5 text-ink-subtle hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
