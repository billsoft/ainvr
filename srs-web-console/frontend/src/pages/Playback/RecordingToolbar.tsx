import type { Dispatch, SetStateAction, RefObject, MouseEventHandler } from 'react'
import { Camera, Download, Pause, Play, Scan, Volume2, VolumeX, ChevronUp } from 'lucide-react'
import type { RecordingSegment } from '@/types/recording'
import { formatClockAt, formatDurationClock } from '@/utils/recording'
import { PlayerViewControls, type usePlayerView } from '@/components/player/PlayerViewControls'
import type { PlayerChannelMeta } from './RecordingPlayer'
const SPEEDS = [0.5, 1, 2, 4, 8]
interface Props {
  duration: number
  currentTime: number
  bufferedPct: number
  progressPct: number
  speed: number
  dragging: boolean
  playing: boolean
  speedMenuOpen: boolean
  muted: boolean
  showDetections: boolean
  error: boolean
  hoverPct: number | null
  hoverTime: number | null
  absTs: number | null
  checking: boolean | undefined
  segment: RecordingSegment | null
  channelMeta: PlayerChannelMeta | undefined
  downloadUrl: string | null
  videoEl: HTMLVideoElement | null
  view: ReturnType<typeof usePlayerView>
  progressRef: RefObject<HTMLDivElement | null>
  speedMenuRef: RefObject<HTMLDivElement | null>
  onProgressMouseDown: MouseEventHandler<HTMLDivElement>
  onProgressMouseMove: MouseEventHandler<HTMLDivElement>
  setHoverTime: Dispatch<SetStateAction<number | null>>
  setSpeed: Dispatch<SetStateAction<number>>
  setSpeedMenuOpen: Dispatch<SetStateAction<boolean>>
  setMuted: Dispatch<SetStateAction<boolean>>
  setShowDetections: Dispatch<SetStateAction<boolean>>
  userPause: () => void
  userPlay: () => void
  snapshot: () => void
  volume: number
}
export function RecordingToolbar({
  duration,
  currentTime,
  bufferedPct,
  progressPct,
  speed,
  dragging,
  playing,
  speedMenuOpen,
  muted,
  showDetections,
  error,
  hoverPct,
  hoverTime,
  absTs,
  checking,
  segment,
  channelMeta,
  downloadUrl,
  videoEl,
  view,
  progressRef,
  speedMenuRef,
  onProgressMouseDown,
  onProgressMouseMove,
  setHoverTime,
  setSpeed,
  setSpeedMenuOpen,
  setMuted,
  setShowDetections,
  userPause,
  userPlay,
  snapshot,
  volume,
}: Props) {
  const VolIcon = muted || volume === 0 ? VolumeX : Volume2
  return (
      <div className="absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-4 pb-2 pt-8">
        {/* 进度条（细条，hover/拖拽变粗，可拖拽 seek，带缓冲指示） */}
        <div
          ref={progressRef}
          className="group relative h-5 cursor-pointer select-none"
          onMouseDown={onProgressMouseDown}
          onMouseMove={onProgressMouseMove}
          onMouseLeave={() => setHoverTime(null)}
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
        >
          {/* 轨道背景（hover 变粗） */}
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/25 transition-all duration-150 group-hover:h-1.5" />
          {/* 缓冲进度 */}
          <div
            className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/35 transition-all duration-150 group-hover:h-1.5"
            style={{ width: `${bufferedPct}%` }}
          />
          {/* 已播放进度 */}
          <div
            className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-danger transition-all duration-150 group-hover:h-1.5"
            style={{ width: `${progressPct}%` }}
          />
          {/* 播放头 */}
          <div
            className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-danger opacity-0 shadow transition-opacity group-hover:opacity-100"
            style={{ left: `${progressPct}%` }}
          />
          {/* hover 指示线 */}
          {hoverPct != null && !dragging && (
            <div
              className="pointer-events-none absolute top-1/2 h-3.5 w-px -translate-y-1/2 bg-white/70"
              style={{ left: `${hoverPct}%` }}
            />
          )}
          {/* hover 时间气泡（绝对时钟） */}
          {hoverTime != null && segment && (
            <div
              className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-ink px-1.5 py-0.5 font-mono text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100"
              style={{ left: `${hoverPct ?? 0}%` }}
            >
              {formatClockAt(segment.startTs + hoverTime * 1000)}
            </div>
          )}
        </div>

        {/* 按钮行 */}
        <div className="mt-1 flex items-center gap-1 text-white">
          {/* 播放/暂停 */}
          <button
            type="button"
            onClick={() => {
              if (playing) userPause()
              else userPlay()
            }}
            disabled={!segment}
            className="rounded-base p-2 transition-colors hover:bg-white/10 disabled:opacity-30"
            title={playing ? '暂停 (空格)' : '播放 (空格)'}
            aria-label={playing ? '暂停' : '播放'}
          >
            {playing ? <Pause size={20} fill="white" /> : <Play size={20} fill="white" />}
          </button>

          {/* 时间：绝对时钟 / 段长 */}
          <div className="mx-2 flex items-center gap-1 font-mono text-xs tabular-nums">
            <span data-testid="player-clock">{absTs != null ? formatClockAt(absTs) : '--:--:--'}</span>
            <span className="text-white/50">/</span>
            <span className="text-white/70">{segment ? formatDurationClock(segment.durationMs) : '--:--'}</span>
          </div>

          <div className="ml-auto flex items-center gap-0.5">
            {/* 抓拍 */}
            <button
              type="button"
              onClick={snapshot}
              disabled={!segment}
              className="rounded-base p-2 transition-colors hover:bg-white/10 disabled:opacity-30"
              title="抓拍当前帧"
              aria-label="抓拍"
            >
              <Camera size={17} />
            </button>
            {/* 下载 */}
            {segment && downloadUrl && (
              <a
                href={downloadUrl}
                download
                className="rounded-base p-2 transition-colors hover:bg-white/10"
                title="下载本段录像"
                aria-label="下载"
              >
                <Download size={17} />
              </a>
            )}

            {/* 倍速菜单（右下角点击弹出，YouTube 同款交互） */}
            <div className="relative" ref={speedMenuRef}>
              <button
                type="button"
                onClick={() => setSpeedMenuOpen((o) => !o)}
                disabled={!segment}
                className="flex items-center gap-0.5 rounded-base px-2 py-1.5 text-xs font-medium transition-colors hover:bg-white/10 disabled:opacity-30"
                title="播放倍速"
                aria-haspopup="menu"
                aria-expanded={speedMenuOpen}
              >
                倍速 {speed}×
                <ChevronUp size={12} className="opacity-70" />
              </button>
              {speedMenuOpen && (
                <div
                  className="absolute bottom-10 right-0 min-w-[7rem] overflow-hidden rounded-base bg-black/90 py-1 text-sm shadow-xl backdrop-blur"
                  role="menu"
                  aria-label="倍速选项"
                >
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="menuitemradio"
                      aria-checked={speed === s}
                      onClick={() => { setSpeed(s); setSpeedMenuOpen(false) }}
                      className={[
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/10',
                        speed === s ? 'text-danger' : 'text-white/85',
                      ].join(' ')}
                    >
                      {s === 1 ? '正常 (1×)' : `${s}×`}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 音量 */}
            <button
              type="button"
              className="rounded-base p-2 transition-colors hover:bg-white/10 disabled:opacity-30"
              onClick={() => setMuted((m) => !m)}
              disabled={!segment}
              title={muted ? '取消静音' : '静音'}
              aria-label={muted ? '取消静音' : '静音'}
            >
              <VolIcon size={17} />
            </button>

            {(segment?.seiPresent || channelMeta?.kind === 'ai') && <button
              type="button"
              title={showDetections ? '隐藏识别框' : '显示识别框'}
              aria-label={showDetections ? '隐藏识别框' : '显示识别框'}
              aria-pressed={showDetections}
              disabled={!videoEl}
              className={`min-h-8 min-w-8 rounded-base p-2 transition-colors hover:bg-white/10 disabled:opacity-30 ${showDetections ? 'text-primary-300' : 'text-white/60'}`}
              onClick={() => setShowDetections(v => !v)}
            ><Scan size={17} /></button>}
            <PlayerViewControls view={view} disabled={!videoEl || checking || error} />
          </div>
        </div>
      </div>
  )
}
