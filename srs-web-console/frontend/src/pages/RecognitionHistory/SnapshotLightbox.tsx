import { Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SnapshotImage } from './SnapshotImage'
import { formatRelativeTime } from '@/utils/format'
import type { SnapshotItem } from '@/types/snapshot'

interface Props {
  channelId: string
  item: SnapshotItem | null
  onClose: () => void
  onDelete: (imageId: string) => void
}

/**
 * 缩略图放大层——审计/回溯核查场景要看清人脸细节，时间轴里 80×80 的
 * 缩略图不够用，评审时判定为设计缺口（当初设计稿写了"点击放大"，落地时
 * 漏掉了）。
 *
 * 删除按钮放在这里常驻可见，不再依赖 hover——原来缩略图格子上的删除
 * 按钮是 `hidden group-hover:block`，触屏设备没有 hover 状态，根本碰不到；
 * 这个放大层是点击（不是 hover）打开的，天然触屏可达，顺带把这个缺口
 * 也堵上，不用在缩略图格子上另外维护一套触屏适配。
 */
export function SnapshotLightbox({ channelId, item, onClose, onDelete }: Props) {
  const [variant, setVariant] = useState<'processed' | 'original'>('processed')
  useEffect(() => { setVariant('processed') }, [item?.image_id])
  // 只能点「取消」或右上角关闭：点遮罩、误按 Esc 都不关闭，避免已填写的内容白输入

  if (!item) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="识别记录大图"
    >
      <div className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-panel bg-surface shadow-modal">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">
              {item.class_name} · {item.confidence === null ? '未提供置信度' : `置信度 ${(item.confidence * 100).toFixed(0)}%`}
            </p>
            <p className="text-xs text-ink-faint">{formatRelativeTime(item.timestamp)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onDelete(item.image_id)}
              className="rounded-base p-2 text-danger hover:bg-danger-50"
              aria-label="删除这条记录"
              data-testid="lightbox-delete"
            >
              <Trash2 size={16} aria-hidden />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-base p-2 text-ink-subtle hover:bg-surface-page"
              aria-label="关闭"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <button type="button" aria-pressed={variant === 'processed'} onClick={() => setVariant('processed')}
            className="rounded-base border border-line px-3 py-1 text-sm text-ink">
            {item.enhanced ? '增强图' : '保存图'}
          </button>
          <button type="button" aria-pressed={variant === 'original'} onClick={() => setVariant('original')}
            className="rounded-base border border-line px-3 py-1 text-sm text-ink">原图</button>
          <span className="text-xs text-ink-faint">{variant === 'original' ? '增强与亮度处理前' : item.enhanced ? '增强后的截图' : '归档截图'}</span>
        </div>
        <div className="h-[60vh] min-h-[240px] bg-surface-page">
          <SnapshotImage
            channelId={channelId}
            item={item}
            className="h-full w-full"
            objectFit="contain"
            variant={variant}
          />
        </div>
      </div>
    </div>
  )
}
