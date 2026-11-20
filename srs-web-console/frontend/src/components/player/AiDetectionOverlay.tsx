import { overlayHoldMs, overlayOpacity } from './overlayPresentation'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AiDetection } from '@/types/aiChannel'
import { drawDetections } from './detectionDrawing'
import { reportOverlayDiag } from '@/api/diagService'
import { computeContainLayout } from './overlayGeometry'
import { TrackTrailBuffer, drawTrackTrails, type TrackTrail } from './trackTrails'
import { drawGroundingPoints, type GroundingOverlay } from './groundingPoints'
import './AiDetectionOverlay.css'

const TRAIL_IDLE_MS = 1000
type DisplayResult = { detections: AiDetection[]; ptsNs?: number | null; displayAgeMs?: number; displayHoldMs?: number; grounding?: GroundingOverlay }

export type ReadDisplayedTracks = () => readonly AiDetection[]
export interface TrackPicking {
  /** Full track ID, including the tracker generation. */
  selectedId: string | null
  pickEnabled?: boolean
  onPick: (id: string) => void
}

// Keep the geometry and lease of the painted frame. A video-frame callback can
// already have delivered the next SEI result before the canvas repaints.
interface PaintedTracks {
  detections: AiDetection[]
  width: number
  height: number
  frameW: number
  frameH: number
  layout: ReturnType<typeof computeContainLayout>
  expires: number
  mediaExpires: number
}

function pickable(d: AiDetection): d is AiDetection & { track_id: string } {
  return !!d.track_id && !d.predicted && !d.lowConfidence && d.bbox.w > 0 && d.bbox.h > 0
}

interface TrackMenu {
  choices: { id: string; label: string }[]
  bounds: React.CSSProperties
  position: React.CSSProperties
}

// Percentages keep the menu in the canvas coordinate system even under digital zoom.
function menuPlacement(rect: DOMRect, painted: PaintedTracks, event: React.MouseEvent<HTMLCanvasElement>) {
  const { layout, width, height } = painted
  const clip = event.currentTarget.closest('.overflow-hidden')?.getBoundingClientRect()
  const left = Math.max(rect.left + layout.offsetX * rect.width / width, clip?.left ?? -Infinity)
  const top = Math.max(rect.top + layout.offsetY * rect.height / height, clip?.top ?? -Infinity)
  const right = Math.min(rect.left + (layout.offsetX + layout.dispW) * rect.width / width, clip?.right ?? Infinity)
  const bottom = Math.min(rect.top + (layout.offsetY + layout.dispH) * rect.height / height, clip?.bottom ?? Infinity)
  if (right <= left || bottom <= top) return null
  const percent = (fraction: number) => `${fraction * 100}%`
  const bounds = { left: percent((left - rect.left) / rect.width), top: percent((top - rect.top) / rect.height),
    width: percent((right - left) / rect.width), height: percent((bottom - top) / rect.height) }
  const x = (event.clientX - left) / (right - left)
  const y = (event.clientY - top) / (bottom - top)
  const position = { left: `min(${percent(x)}, max(0px, 100% - 13rem))`,
    ...(y <= 0.5 ? { top: percent(y), maxHeight: percent(1 - y) } : { bottom: percent(1 - y), maxHeight: percent(y) }) }
  return { bounds, position }
}

interface Props {
  trackPicking?: TrackPicking | null
  displayedTracks?: {current: ReadDisplayedTracks | null}

  drawFrame?: (ctx: CanvasRenderingContext2D, detections: AiDetection[], width: number, height: number, frameW: number, frameH: number, grounding?: GroundingOverlay, trails?: TrackTrail[]) => void
  /** The video element whose displayed frames are annotated. */
  video: HTMLVideoElement | null
  enabled: boolean
  compact?: boolean
  showTrails?: boolean
  showDetections?: boolean
  channelId?: string
  protocol?: string
  /** Changes whenever the player opens a new transport session. */
  resetKey?: string | number
  /** Returns metadata at/before the displayed frame, within the bounded adaptive display window. */
  getSeiForFrame?: (rtpTimestamp: number) => DisplayResult | null
  /** 近似对齐（设计 §8.2）：浏览器不给显示帧的 rtpTimestamp 时，按显示时刻（performance.now 时基）
   *  取"到达时刻 + 实测延迟"最接近的那一帧；延迟还没估出来时返回 null（不画）。 */
  getSeiApprox?: (displayMs: number) => DisplayResult | null
  getReceiveStats?: () => { encoded: number; parsed: number; withTargets: number; malformed: number }
  diagnostics?: boolean
  /** 每个会话第一次成功对上帧时上报一次实际叠框模式 */
  onMode?: (mode: 'exact' | 'approx') => void
}

const DIAG_HEARTBEAT_MS = 15_000

/**
 * 识别框以显示帧为基准，按识别节奏限时复用此前检测（300–1000ms），短时保持亮度、陈旧时淡出：
 * - 逐帧：rVFC 给出显示帧的 rtpTimestamp，按它精确取；
 * - 近似：rVFC 不给 rtpTimestamp（或没有 rVFC），按显示时刻取"到达 + 实测延迟"最近的帧，
 *   每帧都用最新的延迟估计，没有累加项，误差不随时间累计；
 * - 不取未来帧；过期、断流和重建清框，不以墙钟猜视频时间。
 */
export function AiDetectionOverlay({
  video, enabled, displayedTracks, trackPicking, channelId, protocol, resetKey, getSeiForFrame, getSeiApprox, getReceiveStats, diagnostics = false, onMode, drawFrame, compact = false, showTrails = false, showDetections = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const paintedRef = useRef<PaintedTracks | null>(null)
  const picking = !!trackPicking && trackPicking.pickEnabled !== false && showDetections && !drawFrame
  const selectedId = trackPicking?.selectedId ?? null
  const [menu, setMenu] = useState<TrackMenu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<DisplayResult | null>(null)
  const expiresRef = useRef(0)
  const sourceAtRef = useRef(0)
  const holdRef = useRef(300)
  const displayedIntervalsRef = useRef<number[]>([])
  const mediaExpiresRef = useRef(0)
  const lastPtsRef = useRef<number | null>(null)
  const startedRef = useRef(0)
  const presentedAtRef = useRef(0)
  const [staleSeconds, setStaleSeconds] = useState(0)
  const [videoStalled, setVideoStalled] = useState(false)
  const trailBuffer = useRef(new TrackTrailBuffer())
  const trails = useRef<TrackTrail[]>([])
  // Trails are history:drawn whether or not the current frame has its own result,
  // until no result has arrived for TRAIL_IDLE_MS (stream stalled or AI stopped).
  const lastResultRef = useRef(Number.NEGATIVE_INFINITY)
  const countersRef = useRef({ displayed: 0, matched: 0, held: 0, missing: 0, drawn: 0 })
  const modeSeenRef = useRef<'exact' | 'approx' | null>(null)
  const lastHeartbeatRef = useRef(0)

  const readCurrentTracks = useCallback(() => {
    if (!video || video.paused || video.ended || video.seeking || performance.now() >= expiresRef.current ||
        video.currentTime >= mediaExpiresRef.current) return []
    return frameRef.current?.detections ?? []
  }, [video])

  useEffect(() => {
    if (!displayedTracks || !video || !enabled) return
    displayedTracks.current = readCurrentTracks
    return () => { displayedTracks.current = null }
  }, [displayedTracks, video, enabled, readCurrentTracks])

  useLayoutEffect(() => { setMenu(null) }, [picking, resetKey, video, enabled, channelId])

  useLayoutEffect(() => {
    if (!menu || !picking || !enabled) return
    const previousFocus = document.activeElement
    menuRef.current?.querySelector('button')?.focus({ preventScroll: true })
    const cancel = () => setMenu(null)
    const outside = (event: MouseEvent) => {
      // The canvas consumes its own dismissing click so it cannot start a new pick.
      if (event.target !== canvasRef.current && !menuRef.current?.contains(event.target as Node)) cancel()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel()
      if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true })
    }
    document.addEventListener('click', outside, true)
    document.addEventListener('keydown', escape, true)
    video?.addEventListener('seeking', cancel)
    video?.addEventListener('pause', cancel)
    return () => {
      document.removeEventListener('click', outside, true)
      document.removeEventListener('keydown', escape, true)
      video?.removeEventListener('seeking', cancel)
      video?.removeEventListener('pause', cancel)
    }
  }, [menu, video, picking, enabled])

  useEffect(() => {
    frameRef.current = null
    paintedRef.current = null
    modeSeenRef.current = null
    expiresRef.current = 0
    sourceAtRef.current = 0
    holdRef.current = 300
    displayedIntervalsRef.current = []
    mediaExpiresRef.current = 0
    lastPtsRef.current = null
    startedRef.current = performance.now()
    presentedAtRef.current = startedRef.current
    setStaleSeconds(0)
    setVideoStalled(false)
    trailBuffer.current.clear()
    trails.current = []
    lastResultRef.current = Number.NEGATIVE_INFINITY
  }, [resetKey, video, enabled, channelId])

  useEffect(() => {
    if (!enabled || !video || (!getSeiForFrame && !getSeiApprox)) return
    let mediaTime = video.currentTime
    let progressedAt = performance.now()
    let stale = false
    const timer = window.setInterval(() => {
      const now = performance.now()
      // Pausing or backgrounding is intentional, not a recognition outage.
      if (document.hidden || video.paused || video.ended) {
        progressedAt = now
        presentedAtRef.current = now
        mediaTime = video.currentTime
        setStaleSeconds(0)
        setVideoStalled(false)
        return
      }
      if (video.currentTime !== mediaTime) { mediaTime = video.currentTime; progressedAt = now }
      const age = now - (Number.isFinite(lastResultRef.current) ? lastResultRef.current : startedRef.current)
      // currentTime may advance while a live decoder repeats its last image.
      const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function'
      const stalled = now - (hasFrameCallback ? presentedAtRef.current : progressedAt) >= 3000
      const seconds = age >= 3000 ? Math.floor(age / 1000) : 0
      setVideoStalled(stalled)
      setStaleSeconds(seconds)
      if (seconds && !stale && channelId) {
        console.warn('[sei-overlay] stale', JSON.stringify({ channelId, videoStalled: stalled, ageMs: Math.round(age), ...getReceiveStats?.() }))
        reportOverlayDiag({ channelId, event: 'heartbeat', offsetS: 0, offsetJumpMs: 0,
          nowS: Date.now() / 1000, matchGapMs: age, protocol,
          matchType: modeSeenRef.current === 'exact' ? 'sei' : 'sei-approx' })
      }
      stale = seconds > 0
    }, 500)
    return () => window.clearInterval(timer)
  }, [enabled, video, getSeiForFrame, getSeiApprox, getReceiveStats, channelId, protocol, resetKey])

  useEffect(() => {
    countersRef.current = { displayed: 0, matched: 0, held: 0, missing: 0, drawn: 0 }
    lastHeartbeatRef.current = 0
    if (canvasRef.current) delete canvasRef.current.dataset.overlayStats
  }, [resetKey, channelId])

  useEffect(() => {
    if (!enabled || !video || (!getSeiForFrame && !getSeiApprox)) return
    type Meta = { rtpTimestamp?: number; expectedDisplayTime?: number }
    type RvfcVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: (now: number, metadata: Meta) => void) => number
      cancelVideoFrameCallback?: (handle: number) => void
    }
    const current = video as RvfcVideo
    const hasRvfc = typeof current.requestVideoFrameCallback === 'function'
    // 没有 rVFC 时只有近似路径能用（逐帧需要显示帧的 rtpTimestamp）
    if (!hasRvfc && !getSeiApprox) return
    const clearForSeek = () => {
      frameRef.current = null
      paintedRef.current = null
      expiresRef.current = 0
      lastPtsRef.current = null
      displayedIntervalsRef.current = []
      trailBuffer.current.clear()
      trails.current = []
    }
    video.addEventListener('seeking', clearForSeek)
    let cancelled = false
    let handle = 0
    const apply = (hit: DisplayResult | null, mode: 'exact' | 'approx') => {
      const nowMono = performance.now()
      const pts = hit?.ptsNs
      const hasPts = typeof pts === 'number' && Number.isFinite(pts)
      // Repeated SEI or out-of-order metadata must not renew a stale box/trail.
      const fresh = !!hit && (!hasPts || lastPtsRef.current === null || pts > lastPtsRef.current)
      if (fresh) {
        if (hasPts && lastPtsRef.current !== null) {
          const interval = (pts - lastPtsRef.current) / 1e6
          if (interval > 0 && interval <= 1000) {
            displayedIntervalsRef.current.push(interval)
            if (displayedIntervalsRef.current.length > 5) displayedIntervalsRef.current.shift()
          }
        }
        if (hasPts) lastPtsRef.current = pts
        trails.current = trailBuffer.current.update(hit!.ptsNs, hit!.detections)
        lastResultRef.current = nowMono
        const hold = Math.min(1000, Math.max(hit!.displayHoldMs ?? 300, overlayHoldMs(displayedIntervalsRef.current)))
        holdRef.current = hold
        sourceAtRef.current = nowMono - (hit!.displayAgeMs ?? 0)
        expiresRef.current = sourceAtRef.current + hold
        mediaExpiresRef.current = video.currentTime + Math.max(0, expiresRef.current - nowMono) / 1000
      }
      const same = hasPts && pts === lastPtsRef.current
      if (hit && (fresh || same)) frameRef.current = hit
      if (!fresh && hit && same) expiresRef.current = Math.min(expiresRef.current,
        nowMono + Math.max(0, holdRef.current - (hit.displayAgeMs ?? 0)))
      // Missing metadata is not an explicit empty detection. Never renew its lease.
      if (nowMono >= expiresRef.current || video.currentTime >= mediaExpiresRef.current) frameRef.current = null
      const counters = countersRef.current
      counters.displayed++
      if (!hit) counters.missing++
      else if ((hit.displayAgeMs ?? 0) > 0) counters.held++
      else counters.matched++
      if (hit && modeSeenRef.current !== mode) {
        modeSeenRef.current = mode
        onMode?.(mode)
      }
      if (channelId) {
        const now = Date.now()
        if (now - lastHeartbeatRef.current >= DIAG_HEARTBEAT_MS) {
          lastHeartbeatRef.current = now
          // Bounded session counters, no payload/image data. Available even when
          // the server intentionally filters normal overlay heartbeats.
          const stats = { channelId, sampleMonoMs: performance.now(), ...getReceiveStats?.(), ...counters }
          if (diagnostics) {
            if (canvasRef.current) canvasRef.current.dataset.overlayStats = JSON.stringify(stats)
            console.info('[sei-overlay]', JSON.stringify(stats))
          }
          reportOverlayDiag({
            channelId,
            event: 'heartbeat',
            offsetS: 0,
            offsetJumpMs: 0,
            nowS: now / 1000,
            matchGapMs: null,
            signedGapMs: null,
            protocol,
            matchType: mode === 'exact' ? 'sei' : 'sei-approx',
            detCount: hit?.detections.filter(d => !d.predicted && !d.lowConfidence).length ?? 0,
          })
        }
      }
    }
    if (hasRvfc) {
      const onFrame = (now: number, metadata: Meta) => {
        if (cancelled) return
        presentedAtRef.current = performance.now()
        if (typeof metadata.rtpTimestamp === 'number' && getSeiForFrame) {
          apply(getSeiForFrame(metadata.rtpTimestamp), 'exact')
        } else if (getSeiApprox) {
          apply(getSeiApprox(metadata.expectedDisplayTime || now), 'approx')
        } else {
          frameRef.current = null
        }
        handle = current.requestVideoFrameCallback!(onFrame)
      }
      handle = current.requestVideoFrameCallback!(onFrame)
      return () => {
        video.removeEventListener('seeking', clearForSeek)
        cancelled = true
        current.cancelVideoFrameCallback?.(handle)
      }
    }
    const tick = (now: number) => {
      if (cancelled) return
      apply(getSeiApprox!(now), 'approx')
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => {
      video.removeEventListener('seeking', clearForSeek)
      cancelled = true
      cancelAnimationFrame(handle)
    }
  }, [enabled, video, getSeiForFrame, getSeiApprox, getReceiveStats, diagnostics, channelId, protocol, resetKey, onMode])

  useEffect(() => {
    if (!enabled || !video) return
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    let animation = 0
    const draw = () => {
      animation = requestAnimationFrame(draw)
      paintedRef.current = null
      const rect = video.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      if (!rect.width || !rect.height) return
      const width = Math.round(rect.width * dpr)
      const height = Math.round(rect.height * dpr)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, rect.width, rect.height)
      if (!video.videoWidth || !video.videoHeight) return
      if (performance.now() >= expiresRef.current || video.currentTime >= mediaExpiresRef.current) frameRef.current = null
      const frame = frameRef.current
      const age = Math.max(0, performance.now() - sourceAtRef.current)
      const hold = Math.max(300, expiresRef.current - sourceAtRef.current)
      context.globalAlpha = overlayOpacity(age, hold)
      if (frame?.detections.length || frame?.grounding?.points.length) countersRef.current.drawn++
      // Box visibility applies to detected and display-only boxes; trails remain independent.
      const visibleDetections = showDetections ? frame?.detections ?? []
        : []
      if (drawFrame) {
        drawFrame(context, visibleDetections, rect.width, rect.height, video.videoWidth, video.videoHeight,
          showDetections ? frame?.grounding : undefined,
          showTrails && performance.now()-lastResultRef.current<=TRAIL_IDLE_MS ? trails.current : [])
      } else {
        const layout = computeContainLayout(video.videoWidth, video.videoHeight, rect.width, rect.height)
        if (showTrails && !drawFrame && performance.now() - lastResultRef.current <= TRAIL_IDLE_MS) {
          drawTrackTrails(context, trails.current, layout, video.videoWidth, video.videoHeight)
        }
        const matches = selectedId ? visibleDetections.filter(d => d.track_id === selectedId) : []
        const highlight = matches.length === 1 && pickable(matches[0]!) ? selectedId : null
        drawDetections(context, visibleDetections, layout, video.videoWidth, video.videoHeight, compact, highlight)
        if (picking && visibleDetections.length) {
          paintedRef.current = {
            detections: visibleDetections, layout, width: rect.width, height: rect.height,
            frameW: video.videoWidth, frameH: video.videoHeight,
            expires: expiresRef.current, mediaExpires: mediaExpiresRef.current,
          }
        }
        if (showDetections) {
          drawGroundingPoints(context, frame?.grounding, layout)
        }
      }
      context.globalAlpha = 1
    }
    animation = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(animation)
      paintedRef.current = null
    }
  }, [enabled, video, drawFrame, showTrails, showDetections, compact, picking, selectedId])

  function confirmTrack(id: string) {
    if (!picking) return
    setMenu(null)
    if (readCurrentTracks().filter(d => pickable(d) && d.track_id === id).length === 1) trackPicking?.onPick(id)
  }

  function pickTrack(event: React.MouseEvent<HTMLCanvasElement>) {
    event.stopPropagation()
    if (menu) { setMenu(null); return }
    const painted = paintedRef.current
    if (!trackPicking || !painted || !video || video.paused || video.ended || video.seeking ||
        performance.now() >= painted.expires || video.currentTime >= painted.mediaExpires) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const { layout, frameW, frameH } = painted
    const x = ((event.clientX - rect.left) * painted.width / rect.width - layout.offsetX) * frameW / layout.dispW
    const y = ((event.clientY - rect.top) * painted.height / rect.height - layout.offsetY) * frameH / layout.dispH
    if (x < 0 || x >= frameW || y < 0 || y >= frameH) return
    const hits = painted.detections.filter(pickable).filter(({ bbox }) =>
      x >= bbox.x && x <= bbox.x + bbox.w && y >= bbox.y && y <= bbox.y + bbox.h)
    if (hits.length === 1) return confirmTrack(hits[0]!.track_id)
    if (hits.length < 2) return
    const placement = menuPlacement(rect, painted, event)
    if (!placement) return
    const choices = Array.from(new Map(hits.map(d => {
      const plate = d.model_extra?.attributes?.plate_text?.value
      return [d.track_id, typeof plate === 'string' ? plate : d.class_name] as const
    })), ([id, label]) => ({ id, label }))
    setMenu({ choices, ...placement })
  }

  return enabled ? <><canvas ref={canvasRef}
    className={`absolute inset-0 h-full w-full ${picking ? 'cursor-crosshair' : 'pointer-events-none'}`}
    onClick={picking ? pickTrack : undefined}
    onDoubleClick={picking ? e => e.stopPropagation() : undefined}
    data-testid="ai-detection-overlay" />
    {picking && menu && <div className="ai-track-menu-bounds" style={menu.bounds}>
      <div ref={menuRef} role="menu" aria-label="选择跟踪目标" className="ai-track-menu" style={menu.position}
        onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
        onKeyDown={e => {
          e.stopPropagation()
          const buttons = Array.from(e.currentTarget.querySelectorAll('button'))
          const index = buttons.indexOf(e.target as HTMLButtonElement)
          const keys: Record<string, number> = { ArrowDown: (index + 1) % buttons.length,
            ArrowUp: (index + buttons.length - 1) % buttons.length, Home: 0, End: buttons.length - 1 }
          const next = keys[e.key]
          if (next !== undefined) { e.preventDefault(); buttons[next]?.focus() }
        }}>
        {menu.choices.map(({ id, label }) => {
          const short = id.split(':').at(-1) || id
          const ambiguous = menu.choices.some(other => other.id !== id && other.label === label && other.id.split(':').at(-1) === short)
          return <button type="button" role="menuitem" key={id} title={id} onClick={() => confirmTrack(id)}>
            {label} #{ambiguous ? id : short}
          </button>
        })}
      </div>
    </div>}
    {staleSeconds > 0 && <div role="status" className="pointer-events-none absolute bottom-12 left-2 z-20 max-w-[90%] rounded bg-black/75 px-2 py-1 text-xs text-amber-200">{compact ? (videoStalled ? '画面停滞' : '标注延迟') : videoStalled ? '播放画面暂时停滞，正在等待恢复' : `识别标注已 ${staleSeconds} 秒未与画面对齐，旧框已隐藏`}</div>}</> : null
}
