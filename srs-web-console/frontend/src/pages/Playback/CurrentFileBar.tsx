import { Download, FileVideo } from 'lucide-react'
import type { RecordingSegment } from '@/types/recording'
import { formatBytes } from '@/utils/format'

const stamp = (ts: number) => new Date(ts).toLocaleString('zh-CN', {
  hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})
const clock = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })

/** The recording file under the timeline pointer, named by the time it covers, with its download.
 *  While the pointer is dragged it follows the pointer; otherwise it is the file being played. */
export function CurrentFileBar({ segment, pointerSet, playingId, downloadUrl, unplayableReason }: {
  segment: RecordingSegment | null
  /** False until something is playing or the pointer has been placed: nothing to name yet. */
  pointerSet: boolean
  /** The file the player has loaded; differs from `segment` only while the pointer is being dragged elsewhere. */
  playingId: string | null
  downloadUrl: string | null
  unplayableReason: string
}) {
  if (!segment) {
    return <div data-testid="current-file-bar" className="flex min-h-11 items-center gap-2 rounded-base border border-line bg-surface px-3 text-xs text-ink-faint">
      <FileVideo size={15} aria-hidden className="shrink-0" />{pointerSet ? '指针所在的时刻没有录像文件' : '尚未开始播放'}
    </div>
  }
  const detail = [`${Math.round(segment.durationMs / 1000)} 秒`, formatBytes(segment.sizeBytes), segment.codec === 'h265' ? 'H.265' : 'H.264',
    segment.width && segment.height ? `${segment.width}×${segment.height}` : null].filter(Boolean).join(' · ')
  const downloadable = segment.playable && !!downloadUrl
  return <div data-testid="current-file-bar" className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-base border border-line bg-surface px-3 py-1.5 text-sm">
    <FileVideo size={16} aria-hidden className="shrink-0 text-ink-faint" />
    <div className="min-w-0 flex-1">
      <p className="truncate font-medium tabular-nums text-ink" title={`${stamp(segment.startTs)} – ${clock(segment.endTs)}`}>
        <span className="mr-2 text-xs font-normal text-ink-subtle">{segment.id === playingId ? '正在播放' : '指针所在'}</span>
        {stamp(segment.startTs)} – {clock(segment.endTs)}
      </p>
      <p className="truncate text-xs text-ink-subtle">{detail}{segment.id !== playingId && '（松开后跳到这里播放）'}</p>
    </div>
    {downloadable
      ? <a data-testid="current-file-download" href={downloadUrl!} download
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-base border border-primary px-3 text-sm text-primary hover:bg-primary-50"><Download size={15} aria-hidden />下载此文件</a>
      : <span data-testid="current-file-download" aria-disabled="true" title={unplayableReason}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-base border border-line px-3 text-sm text-ink-faint"><Download size={15} aria-hidden />无法下载</span>}
  </div>
}
