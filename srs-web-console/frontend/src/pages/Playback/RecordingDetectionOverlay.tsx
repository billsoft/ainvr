import { useEffect, useRef, useState, type RefObject } from 'react'
import type { AiDetection } from '@/types/aiChannel'
import { drawDetections } from '@/components/player/detectionDrawing'
import { drawGroundingPoints, type GroundingOverlay } from '@/components/player/groundingPoints'
import { computeContainLayout } from '@/components/player/overlayGeometry'
import { request } from '@/api/httpClient'
import { parseRecordingSei, pickRecordingSei, type RecordingSeiFrame } from './recordingSei'

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>
  segmentId: string
  currentTime: number
  enabled?: boolean
  drawFrame?: (ctx: CanvasRenderingContext2D, detections: AiDetection[], width: number, height: number, frameW: number, frameH: number, grounding?: GroundingOverlay) => void
}

/** File playback has no WebRTC encoded-frame tap. Metadata uses MP4 PTS and
 * shares live preview's payload parser, box projection and canvas renderer. */
export function RecordingDetectionOverlay({ videoRef, segmentId, currentTime, drawFrame, enabled = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const windows = useRef(new Map<number, RecordingSeiFrame[]>())
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const bucket = Math.max(0, Math.floor(currentTime / 10))
  const prefetch = currentTime % 10 >= 7

  useEffect(() => {
    if (!enabled) return
    const ctrl = new AbortController()
    let cancelled = false
    for (const b of windows.current.keys()) {
      if (b < bucket - 1 || b > bucket + 1) windows.current.delete(b)
    }
    async function load() {
      setError(false)
      setLoading(!windows.current.has(bucket))
      for (const b of prefetch ? [bucket, bucket + 1] : [bucket]) {
        if (windows.current.has(b)) continue
        try {
          const timer = setTimeout(() => ctrl.abort(), 8000)
          try {
            const response = await request<unknown>(`/v1/recordings/${encodeURIComponent(segmentId)}/sei?from_ms=${b * 10000}`, {
              signal: ctrl.signal, credentials: 'same-origin', cache: 'no-store',
            })
            const frames = parseRecordingSei(response)
            if (cancelled) return
            windows.current.set(b, frames)
          } finally { clearTimeout(timer) }
        } catch {
          if (!cancelled && b === bucket) setError(true)
          break
        }
      }
      if (!cancelled) setLoading(false)
    }
    void load()
    return () => { cancelled = true; ctrl.abort() }
  }, [bucket, prefetch, segmentId, enabled, revision])

  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!video || !canvas || !ctx) return
    let paint = 0
    let frame = 0
    let mediaTime = video.currentTime
    const hasRvfc = typeof video.requestVideoFrameCallback === 'function'
    let stopped = false
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (stopped) return
      mediaTime = meta.mediaTime
      frame = video.requestVideoFrameCallback(onFrame)
    }
    if (hasRvfc) frame = video.requestVideoFrameCallback(onFrame)
    const onSeeked = () => { mediaTime = video.currentTime }
    video.addEventListener('seeked', onSeeked)
    const draw = () => {
      paint = requestAnimationFrame(draw)
      const rect = video.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const width = Math.round(rect.width * dpr)
      const height = Math.round(rect.height * dpr)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, rect.width, rect.height)
      if (!enabled || video.seeking || !video.videoWidth || video.readyState < 2) return
      const seconds = hasRvfc ? mediaTime : video.currentTime
      const rows = windows.current.get(Math.floor(seconds / 10)) ?? []
      const hit = pickRecordingSei(rows, seconds * 1000)
      ctx.globalAlpha = (hit?.displayAgeMs ?? 0) > 1 ? 0.65 : 1
      if (drawFrame) {
        if (hit?.grounding) drawFrame(ctx, hit.detections, rect.width, rect.height, video.videoWidth, video.videoHeight, hit.grounding)
        else drawFrame(ctx, hit?.detections ?? [], rect.width, rect.height, video.videoWidth, video.videoHeight)
      } else {
        const layout = computeContainLayout(video.videoWidth, video.videoHeight, rect.width, rect.height)
        drawDetections(ctx, hit?.detections ?? [], layout, video.videoWidth, video.videoHeight)
        drawGroundingPoints(ctx, hit?.grounding, layout)
      }
      ctx.globalAlpha = 1
    }
    paint = requestAnimationFrame(draw)
    return () => {
      stopped = true
      cancelAnimationFrame(paint)
      if (hasRvfc) video.cancelVideoFrameCallback(frame)
      video.removeEventListener('seeked', onSeeked)
    }
  }, [videoRef, enabled, segmentId, drawFrame])

  return <>
    <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" data-testid="recording-detection-overlay" />
    <div className="absolute left-3 top-20 z-10 flex items-center gap-2 text-xs text-white">
      {enabled && error ? <button type="button" className="rounded bg-black/60 px-2 py-1" onClick={() => setRevision(v => v + 1)}>识别框读取失败，重试</button>
        : enabled && loading ? <span className="rounded bg-black/60 px-2 py-1">识别框加载中…</span> : null}
    </div>
  </>
}
