import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { AuthImage } from '@/components/common/AuthImage'
import { formatRelativeTime } from '@/utils/format'
import { SnapshotLightbox } from './SnapshotLightbox'
import type { SnapshotItem } from '@/types/snapshot'
import { getAiModelDisplayNameByName } from '@/types/aiChannel'
import type { SnapshotFrameGroup } from '@/utils/snapshotGrouping'

interface Props {
  channelId: string
  group: SnapshotFrameGroup
  onDeleteOne: (imageId: string) => void
}

/** 一句话摘要——单个目标直接给类别+置信度；多个目标给"这一刻识别到N个"，
 * 跟 AiResultModal.tsx 的 summarize() 是同一套文案思路。 */
function summarize(items: SnapshotFrameGroup['items']): string {
  const [first, ...rest] = items
  if (!first) return '未检测到目标'
  if (rest.length === 0) {
    return `${first.class_name} · ${first.confidence === null ? '未提供置信度' : `置信度 ${(first.confidence * 100).toFixed(0)}%`}`
  }
  const parts = items.map((i) => i.confidence === null ? '未提供' : `${(i.confidence * 100).toFixed(0)}%`).join('、')
  return `检测到 ${items.length} 个目标（置信度 ${parts}）`
}

export function SnapshotGroupCard({ channelId, group, onDeleteOne }: Props) {
  const [showRaw, setShowRaw] = useState(false)
  const [viewingItem, setViewingItem] = useState<SnapshotItem | null>(null)

  return (
    <div className="rounded-panel border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-ink">
          {new Date(group.timestamp * 1000).toLocaleString('zh-CN')}
        </p>
        <p className="text-xs text-ink-faint">
          {formatRelativeTime(group.timestamp)} · {getAiModelDisplayNameByName(group.items[0]?.model_name)}
        </p>
      </div>

      <p className="mt-2 text-sm text-ink-subtle">{summarize(group.items)}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {group.items.map((item) => (
          <button
            key={item.image_id}
            type="button"
            onClick={() => setViewingItem(item)}
            className="relative h-20 w-20 shrink-0 overflow-hidden rounded-base border border-line"
            aria-label={`放大查看：${item.class_name}`}
          >
            <AuthImage channelId={channelId} imageId={item.image_id} alt={item.class_name} className="h-full w-full" />
            {item.enhanced && (
              <span className="absolute left-0 top-0 rounded-br bg-primary/90 px-1 py-px text-[9px] leading-tight text-white">
                增强
              </span>
            )}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        className="mt-3 flex items-center gap-1 text-xs text-primary hover:underline"
      >
        {showRaw ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        原始 JSON
      </button>
      {showRaw && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-base bg-surface-page p-3 text-[11px] leading-relaxed text-ink-subtle">
          {JSON.stringify(group.items, null, 2)}
        </pre>
      )}

      <SnapshotLightbox
        channelId={channelId}
        item={viewingItem}
        onClose={() => setViewingItem(null)}
        onDelete={(imageId) => {
          onDeleteOne(imageId)
          setViewingItem(null)
        }}
      />
    </div>
  )
}
