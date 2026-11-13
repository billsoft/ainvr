import { Crop, ImageUp, Trash2 } from 'lucide-react'
import { cropBackground, type SearchReference } from '@/features/searchReference'

const action = 'inline-flex min-h-9 [@media(pointer:coarse)]:min-h-11 items-center gap-1.5 rounded-base px-2 text-xs text-ink-subtle hover:bg-primary-50 hover:text-primary disabled:opacity-50'

/** The reference picture as it will be searched: the thumbnail shows only the selected part. */
export function ReferenceThumbnail({ reference, className = 'h-20 w-20' }: { reference: SearchReference; className?: string }) {
  const view = cropBackground(reference.crop)
  const aspect = reference.width / reference.height * view.aspect
  return <span role="img" aria-label={reference.crop ? '参考图片（已框选局部）' : '参考图片（整张）'}
    className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-slate-950 ${className}`}>
    <span className="block bg-no-repeat" style={{ width: `${Math.min(1, aspect) * 100}%`, height: `${Math.min(1, 1 / aspect) * 100}%`, backgroundImage: `url("${reference.url}")`, backgroundSize: view.backgroundSize, backgroundPosition: view.backgroundPosition }} />
  </span>
}

export function ReferenceImageStrip({ reference, disabled, onCrop, onReplace, onRemove }: {
  reference: SearchReference
  disabled?: boolean
  onCrop: () => void
  onReplace: () => void
  onRemove: () => void
}) {
  return <div aria-label="参考图片" role="group" className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-surface p-2">
    <button type="button" disabled={disabled} onClick={onCrop} aria-label="调整框选" className="shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <ReferenceThumbnail reference={reference} />
    </button>
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium text-ink">{reference.crop ? '仅搜索选区' : '使用整张图片'}{reference.origin === 'result' && <span className="ml-2 text-xs font-normal text-ink-subtle">来自搜索结果</span>}</p>
      <p className="mt-0.5 text-xs text-ink-subtle">按外观找相似的人、物品或画面；图片只用于本次搜索，不保存到设备。</p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <button type="button" className={action} disabled={disabled} onClick={onCrop}><Crop size={14} aria-hidden="true" />{reference.crop ? '调整选区' : '框选目标'}</button>
        <button type="button" className={action} disabled={disabled} onClick={onReplace}><ImageUp size={14} aria-hidden="true" />更换</button>
        <button type="button" className={action} disabled={disabled} onClick={onRemove}><Trash2 size={14} aria-hidden="true" />移除</button>
      </div>
    </div>
  </div>
}
