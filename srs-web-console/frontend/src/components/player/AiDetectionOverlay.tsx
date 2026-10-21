import { useEffect, useRef } from 'react'
import type { AiDetection } from '@/types/aiChannel'
import { drawDetections } from './detectionDrawing'
import { reportOverlayDiag } from '@/api/diagService'
import { computeContainLayout, projectLandmark } from './overlayGeometry'
import { TrackTrailBuffer, trailSegments, type TrackTrail } from './trackTrails'
import { drawGroundingPoints, type GroundingOverlay } from './groundingPoints'

const TRAIL_IDLE_MS = 1000
type DisplayResult = { detections: AiDetection[]; ptsNs?: number | null; displayAgeMs?: number; grounding?: GroundingOverlay }

interface Props {
  drawFrame?: (ctx: CanvasRenderingContext2D, detections: AiDetection[], width: number, height: number, frameW: number, frameH: number, grounding?: GroundingOverlay, trails?: TrackTrail[]) => void
  /** The video element whose displayed frames are annotated. */
  video: HTMLVideoElement | null
  enabled: boolean
  showTrails?: boolean
  showDetections?: boolean
  channelId?: string
  protocol?: string
  /** Changes whenever the player opens a new transport session. */
  resetKey?: string | number
  /** Returns metadata at/before the displayed frame, at most 300 ms old. */
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
 * 识别框以显示帧为基准，最多复用此前 300ms 的检测，复用时降低不透明度：
 * - 逐帧：rVFC 给出显示帧的 rtpTimestamp，按它精确取；
 * - 近似：rVFC 不给 rtpTimestamp（或没有 rVFC），按显示时刻取"到达 + 实测延迟"最近的帧，
 *   每帧都用最新的延迟估计，没有累加项，误差不随时间累计；
 * - 不取未来帧；过期、断流和重建清框，不以墙钟猜视频时间。
 */
export function AiDetectionOverlay({
  video, enabled, channelId, protocol, resetKey, getSeiForFrame, getSeiApprox, getReceiveStats, diagnostics = false, onMode, drawFrame, showTrails = false, showDetections = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<DisplayResult | null>(null)
  const expiresRef = useRef(0)
  const trailBuffer = useRef(new TrackTrailBuffer())
  const trails = useRef<TrackTrail[]>([])
  // Trails are history:drawn whether or not the current frame has its own result,
  // until no result has arrived for TRAIL_IDLE_MS (stream stalled or AI stopped).
  const lastResultRef = useRef(Number.NEGATIVE_INFINITY)
  const countersRef = useRef({ displayed: 0, matched: 0, held: 0, missing: 0, drawn: 0 })
  const modeSeenRef = useRef<'exact' | 'approx' | null>(null)
  const lastHeartbeatRef = useRef(0)

  useEffect(() => {
    frameRef.current = null
    modeSeenRef.current = null
    expiresRef.current = 0
    trailBuffer.current.clear()
    trails.current = []
    lastResultRef.current = Number.NEGATIVE_INFINITY
  }, [resetKey, video, enabled, channelId])

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
    let cancelled = false
    let handle = 0
    const apply = (hit: DisplayResult | null, mode: 'exact' | 'approx') => {
      frameRef.current = hit
      if (hit) {
        trails.current = trailBuffer.current.update(hit.ptsNs, hit.detections)
        lastResultRef.current = performance.now()
      }
      expiresRef.current = performance.now() + Math.max(0, 300 - (hit?.displayAgeMs ?? 0))
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
      if (performance.now() >= expiresRef.current) frameRef.current = null
      const frame = frameRef.current
      context.globalAlpha = (frame?.displayAgeMs ?? 0) > 0 ? 0.65 : 1
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
          context.lineWidth = 2
          for (const trail of trails.current) {
            if (trail.points.length < 2) continue
            let hash = 0
            for (const char of trail.id) hash = (hash * 31 + char.charCodeAt(0)) | 0
            context.strokeStyle = `hsl(${Math.abs(hash) % 360} 85% 65%)`
            // 推算段虚线，真实观测段实线。
            for (const segment of trailSegments(trail.points)) {
              const a = projectLandmark(segment.from, layout, video.videoWidth, video.videoHeight)
              const b = projectLandmark(segment.to, layout, video.videoWidth, video.videoHeight)
              context.setLineDash?.(segment.predicted ? [6, 4] : [])
              context.beginPath()
              context.moveTo(a.x, a.y)
              context.lineTo(b.x, b.y)
              context.stroke()
            }
          }
          context.setLineDash?.([])
        }
        drawDetections(context, visibleDetections, layout, video.videoWidth, video.videoHeight)
        if (showDetections) {
          drawGroundingPoints(context, frame?.grounding, layout)
        }
      }
      context.globalAlpha = 1
    }
    animation = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animation)
  }, [enabled, video, drawFrame, showTrails, showDetections])

  return enabled ? <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" data-testid="ai-detection-overlay" /> : null
}
