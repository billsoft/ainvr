import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import {
  dateKey, formatClockAt, intersectMarksWithBlocks, mergeContiguous, recordingDisplayBlocks,
  PLAYBACK_RANGE_PRESETS, subtractRangeUnit,
} from '@/utils/recording'
import { DateTimeRangePicker } from '@/components/ui/DateTimeRangePicker'
import { formatRangeShort, parseDatetimeLocalValue, toDatetimeLocalValue, type RangePreset } from '@/utils/timeRange'
import { timelineTicks } from './model'
import type { RecordingDrop, RecordingSegment } from '@/types/recording'

interface Props {
  win: { from: number; to: number }
  selectedPreset?: string | null
  segments: RecordingSegment[]
  playheadTs: number | null
  aiMarks?: { start: number; end: number }[]
  /** 存储写入不足时按完整画面组丢弃的区间（琥珀色） */
  drops?: RecordingDrop[]
  onSeek(ts: number): void
  onChangeRange(from: number, to: number, preset: string | null): void
}
function pad2(n: number) { return String(n).padStart(2, '0') }

/** Controlled range, read-only coverage, explicit drag preview. */
export function RecordingTimeline({ win, segments, playheadTs, aiMarks = [], drops = [], selectedPreset = null, onSeek, onChangeRange }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  // 拖拽中的预览播放头（仅视觉跟随，抬起时才真正 seek）
  const [dragTs, setDragTs] = useState<number | null>(null)
  useEffect(() => { setDragTs(null) }, [win.from, win.to])
  const pointerIdRef = useRef<number | null>(null)

  const effectivePlayhead = dragTs != null ? dragTs : playheadTs
  // 轨道像素宽：时间气泡在边缘处要按像素 clamp，保证不溢出又始终贴着指针
  const [trackWidth, setTrackWidth] = useState(0)
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const update = () => setTrackWidth(track.clientWidth)
    update()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(update)
      ro.observe(track)
      return () => ro.disconnect()
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const [pickerOpen, setPickerOpen] = useState(false)
  const spanMs = Math.max(1, win.to - win.from)
  // All ranges fit one viewport; tick granularity adapts to available width.
  const actualBlocks = useMemo(() => mergeContiguous(segments.filter(s => s.playable), 0), [segments])
  const blocks = useMemo(() => recordingDisplayBlocks(segments, drops), [segments, drops])
  // 红条与可播放录像块求交：仅在可播放录像内绘制已验证的 SEI
  const visibleAiMarks = useMemo(() => intersectMarksWithBlocks(aiMarks, actualBlocks), [aiMarks, actualBlocks])

  const tickList = useMemo(() => timelineTicks(win.from, win.to, trackWidth), [win.from, win.to, trackWidth])

  const seiPath = useMemo(() => visibleAiMarks.map(mark => {
    const left = Math.max(0, (mark.start - win.from) / spanMs * 100)
    const right = Math.min(100, (mark.end - win.from) / spanMs * 100)
    return right > left ? `M${left} 0H${right}V24H${left}Z` : ''
  }).join(''), [visibleAiMarks, win.from, spanMs])

  const pct = (ts: number) => ((ts - win.from) / spanMs) * 100
  const now = Date.now()
  const showNowLine = now >= win.from && now <= win.to

  function tsFromPointer(clientX: number): number {
    const track = trackRef.current
    if (!track) return win.from
    const rect = track.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return win.from + frac * spanMs
  }

  // Pointer Events：点击/拖拽统一定位，拖拽中只更新预览，抬起才真正 seek
  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    pointerIdRef.current = e.pointerId
    const ts = tsFromPointer(e.clientX)
    setDragTs(ts)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return
    setDragTs(tsFromPointer(e.clientX))
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return
    const ts = tsFromPointer(e.clientX)
    setDragTs(null)
    pointerIdRef.current = null
    try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId) } catch { /* noop */ }
    onSeek(ts)
  }

  // 唯一一条"范围变了"的路径——预设按钮点击、弹窗确定都只准调这个，
  // 不允许各自直接 onChangeRange（跟识别历史页 applyRange 同一个模式，
  // 见 pages/RecognitionHistory/index.tsx 头注）。参数用毫秒时间戳，不是
  // datetime-local 字符串——win 是数值唯一真源这个既有架构不因为换了
  // 弹窗组件而改变，字符串只在跟 DateTimeRangePicker 的入参/出参边界上
  // 临时转换一次。
  function applyRange(from: number, to: number, presetLabel: string | null) {
    onChangeRange(from, to, presetLabel)
  }

  function applyPreset(preset: RangePreset) {
    const nowTs = Date.now()
    const from = subtractRangeUnit(new Date(nowTs), preset.unit, preset.n).getTime()
    applyRange(from, nowTs, preset.label)
  }

  return (
    <div className="rounded-panel border border-line bg-surface p-3" data-testid="recording-timeline">
      <div
        className="timeline-scroll overflow-x-auto overflow-y-hidden"
        data-testid="timeline-scroll"
      >
        <div
          ref={trackRef}
          // touch-none：触屏拖动指针时不被横向滚动抢走；轨道内容全部
          // pointer-events-none + select-none，除指针外均为只读、不可选中
          className="relative h-24 cursor-pointer touch-none select-none rounded-base bg-surface-page active:cursor-ew-resize"
          style={{ width: '100%' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => { setDragTs(null); pointerIdRef.current = null }}
          tabIndex={0}
          onKeyDown={e => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
            e.preventDefault(); e.stopPropagation()
            const ts = e.key === 'Home' ? win.from : e.key === 'End' ? win.to - 1 : (playheadTs ?? win.from) + (e.key === 'ArrowLeft' ? -1 : 1) * Math.min(60000, spanMs / 100)
            onSeek(Math.max(win.from, Math.min(win.to - 1, ts)))
          }}
          aria-valuemin={win.from}
          aria-valuemax={win.to}
          aria-valuenow={effectivePlayhead ?? win.from}
          role="slider"
          aria-label="录像时间轴"
          aria-valuetext={effectivePlayhead != null ? new Date(effectivePlayhead).toLocaleString('zh-CN') : undefined}
        >
          {/* 录像覆盖（绿色条高 40px；红色条高 24px） */}
          {blocks.map((b, i) => {
            const left = Math.max(0, pct(b.startTs))
            const width = Math.min(100, pct(b.endTs)) - left
            if (width <= 0) return null
            return (
              <div
                key={i}
                className={[
                  'pointer-events-none absolute top-8 h-10 rounded-sm',
                  b.playable ? 'bg-success/70' : 'bg-ink-faint/40',
                ].join(' ')}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={b.playable ? `${new Date(b.startTs).toLocaleString('zh-CN')} 起有录像` : '录像文件不可读'}
              />
            )
          })}

          {/* 写入不足丢弃区间：与录像条同一行，落在录像缺口处（琥珀色） */}
          {drops.map((d, i) => {
            const left = Math.max(0, pct(d.startTs))
            const width = Math.min(100, pct(d.endTs)) - left
            if (width <= 0) return null
            return (
              <div
                key={`drop-${i}`}
                data-testid="timeline-drop-mark"
                className="absolute top-8 h-10 min-w-[2px] rounded-sm bg-warning/70"
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${new Date(d.startTs).toLocaleString('zh-CN')} 起${d.reason === 'stopped' ? '录制停止时未保存' : d.reason === 'backlog' ? '写入积压丢弃' : '未保存'} ${Math.round(d.droppedMs / 1000)} 秒`}
              />
            )
          })}

          {/* Actual SEI intervals, centered at 60% of the green bar height. */}
          {seiPath && <svg aria-label="录像内 SEI 识别覆盖" data-testid="timeline-ai-mark"
            className="pointer-events-none absolute inset-x-0 top-10 h-6 w-full text-danger"
            viewBox="0 0 100 24" preserveAspectRatio="none">
            <path d={seiPath} fill="currentColor" fillOpacity={0.4} />
          </svg>}

          {/* 当前时刻线（窗口覆盖现在时） */}
          {showNowLine && (
            <div className="pointer-events-none absolute inset-y-1 w-px bg-warning" style={{ left: `${pct(now)}%` }} />
          )}

          {/* 播放头（一体化）：顶部红色抓手 + 竖线 + 紧贴线下的时间气泡。
              竖线精确对准点击/拖拽位置；气泡默认居中在线下方，只有贴左右
              边缘时才水平让位（按像素 clamp，绝不溢出轨道），气泡上的小三角
              始终回指正线，拖动时随 dragTs 实时刷新到秒。 */}
          {effectivePlayhead != null && effectivePlayhead >= win.from && effectivePlayhead <= win.to && (
            (() => {
              // 拖拽中：保持纯线性，竖线严格跟手，与 tsFromPointer 的换算一致；
              // Playback and pointer positions always use the same linear scale.
              const frac = pct(effectivePlayhead) / 100
              const linePx = frac * trackWidth
              const multiDay = dateKey(win.from) !== dateKey(win.to)
              // 气泡半宽：跨天窗口会多显示「月-日」，留更宽余量
              const labelHalf = multiDay ? 46 : 32
              const labelPx = trackWidth > 0
                ? Math.max(labelHalf, Math.min(trackWidth - labelHalf, linePx))
                : 0
              // 气泡相对竖线锚点的横向偏移（0=正中；边缘让位时非 0，小三角补回）
              const bubbleShift = trackWidth > 0 ? labelPx - linePx : 0
              const d = new Date(effectivePlayhead)
              const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
              const labelText = (multiDay ? md : '') + formatClockAt(effectivePlayhead, true)
              return (
                <div
                  className="pointer-events-none absolute inset-y-0 z-10"
                  style={{ left: `${frac * 100}%` }}
                  data-testid="timeline-playhead"
                >
                  {/* 顶部抓手（暗示可拖，拖拽中略加高） */}
                  <div
                    className={[
                      'absolute left-0 top-0 w-3 -translate-x-1/2 rounded-b-sm bg-danger shadow-sm transition-all',
                      dragTs != null ? 'h-3.5' : 'h-2.5',
                    ].join(' ')}
                  />
                  {/* 竖线 */}
                  <div className="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-danger" />
                  {/* 时间气泡 */}
                  <div
                    className="absolute top-0 flex h-[18px] items-center whitespace-nowrap rounded bg-danger px-1.5 text-[11px] font-semibold leading-none text-white shadow"
                    style={{
                      left: `${bubbleShift}px`,
                      transform: 'translateX(-50%)',
                    }}
                    data-testid="timeline-playhead-label"
                  >
                    {/* 小三角：无论气泡怎么让位都指向竖线 */}
                    <span
                      className="absolute -top-1 h-2 w-2 -translate-x-1/2 rotate-45 rounded-[2px] bg-danger"
                      style={{ left: `${-bubbleShift}px` }}
                    />
                    <span className="tabular-nums">{dragTs != null ? '预览 ' : ''}{labelText}</span>
                  </div>
                </div>
              )
            })()
          )}

          {/* 刻度（字体与按钮一致，正常黑色） */}
          {tickList.map((t) => (
            <div key={t.ts} className="pointer-events-none absolute bottom-0 h-5" style={{ left: `${pct(t.ts)}%` }}>
              <div className="h-1 w-px bg-line" />
              <span className="absolute top-1 whitespace-nowrap text-[10px] leading-3 text-ink" style={{
                left: trackWidth ? Math.max(40, Math.min(trackWidth - 40, pct(t.ts) / 100 * trackWidth)) - pct(t.ts) / 100 * trackWidth : 0,
                transform: 'translateX(-50%)',
              }}>{t.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 时间范围：触发按钮 + 快捷按钮（合并进时间轴组件，不另起一块）——
          跟识别历史页同一套交互：预设点击/弹窗确定都走 applyRange，样式
          与 testid 约定也保持一致（range-trigger），两个页面看着是同一个
          控件，改一处两边都跟着变。 */}
      <div className="mt-1 flex gap-3 text-[10px] text-ink-faint">
        <span title="旧录像起点仅精确到秒，未标记丢弃的小于1秒接缝按连续显示；实际播放仍按文件定位。">绿色：可播放录像</span><span>红色：录像内 SEI 识别信息</span>
        {drops.length > 0 && <span className="text-amber-700">琥珀：未保存录像（悬停查看原因）</span>}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          data-testid="range-trigger"
          className="flex items-center gap-1.5 rounded-base border border-line bg-surface px-2 py-1 text-xs text-ink hover:border-primary"
        >
          <CalendarClock size={13} className="text-ink-faint" aria-hidden />
          {formatRangeShort(new Date(win.from))} → {formatRangeShort(new Date(win.to))}
        </button>
        <div className="ml-1 flex flex-wrap gap-1">
          {PLAYBACK_RANGE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              aria-pressed={selectedPreset === preset.label}
              onClick={() => applyPreset(preset)}
              className={[
                'rounded-base border px-2 py-1 text-xs transition-colors',
                selectedPreset === preset.label
                  ? 'border-primary bg-primary-50 text-primary'
                  : 'border-line text-ink-subtle hover:border-primary hover:text-primary',
              ].join(' ')}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <DateTimeRangePicker
        open={pickerOpen}
        from={toDatetimeLocalValue(new Date(win.from))}
        to={toDatetimeLocalValue(new Date(win.to))}
        onConfirm={(f, t) => {
          const fromDate = parseDatetimeLocalValue(f)
          const toDate = parseDatetimeLocalValue(t)
          if (!fromDate || !toDate) return
          applyRange(fromDate.getTime(), toDate.getTime(), null)
        }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  )
}
