import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import type { AiDetection } from '@/types/aiChannel'
import { drawPanoramaDetections, type PanoramaCamera } from './panoramaDetection'
import {projectErpSegment} from './panoramaDetection'
import {trailSegments,type TrackTrail} from './trackTrails'
import type { GroundingOverlay } from './groundingPoints'

/** Presentation only: never owns a media connection or changes playback time. */
export function usePlayerView(container: RefObject<HTMLDivElement | null>) {
  const [panorama, setPanorama] = useState(false)
  const [panoramaReset, setPanoramaReset] = useState(0)
  const [panoramaError, setPanoramaError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState('')
  const camera = useRef<PanoramaCamera | null>(null)
  const receivePanoramaCamera = useCallback((value: PanoramaCamera | null) => { camera.current = value }, [])
  const drawPanoramaFrame = useCallback((ctx: CanvasRenderingContext2D, detections: AiDetection[], width: number, height: number, frameW: number, frameH: number, grounding?: GroundingOverlay, trails:TrackTrail[] = []) => {
    if(frameW>0&&frameH>0){
      ctx.save();ctx.beginPath();ctx.rect(0,0,width,height);ctx.clip();ctx.lineWidth=2
      for(const trail of trails){
        let hash=0;for(const char of trail.id)hash=(hash*31+char.charCodeAt(0))|0
        ctx.strokeStyle=`hsl(${Math.abs(hash)%360} 85% 65%)`
        for(const segment of trailSegments(trail.points)){
          ctx.setLineDash?.(segment.predicted?[6,4]:[]);ctx.beginPath()
          for(const [a,b] of projectErpSegment([segment.from.x/frameW,segment.from.y/frameH],[segment.to.x/frameW,segment.to.y/frameH],camera.current,width,height,true)){ctx.moveTo(...a);ctx.lineTo(...b)}
          ctx.stroke()
        }
      }
      ctx.restore()
    }
    drawPanoramaDetections(ctx, detections, camera.current, width, height, frameW, frameH, grounding)
  }, [])
  const panoramaFailed = useCallback((message: string) => {
    setPanorama(false); setPanoramaError(message)
  }, [])
  useEffect(() => {
    const sync = () => setIsFullscreen(!!container.current && document.fullscreenElement === container.current)
    document.addEventListener('fullscreenchange', sync)
    sync()
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [container])
  const toggleFullscreen = useCallback(async () => {
    const el = container.current
    if (!el) return
    setFullscreenError('')
    try {
      if (document.fullscreenElement === el) await document.exitFullscreen()
      else if (el.requestFullscreen) await el.requestFullscreen()
      else setFullscreenError('此浏览器不支持页面全屏')
    } catch { setFullscreenError('无法切换全屏，请重试') }
  }, [container])
  return { panorama, panoramaReset, panoramaError, isFullscreen, fullscreenError,
    camera, receivePanoramaCamera, drawPanoramaFrame, panoramaFailed, toggleFullscreen,
    togglePanorama: () => { setPanoramaError(''); setPanorama(v => !v) },
    resetPanorama: () => setPanoramaReset(v => v + 1) }
}

export function PlayerViewControls({ view, allowPanorama = true, disabled = false }: {
  view: ReturnType<typeof usePlayerView>; allowPanorama?: boolean; disabled?: boolean
}) {
  return <>
    {allowPanorama && <>
      {view.panorama && <button type="button" title="重置视角" aria-label="重置视角"
        className="flex h-10 w-10 items-center justify-center rounded-base text-white hover:bg-white/10 disabled:opacity-40"
        onClick={e => { e.stopPropagation(); view.resetPanorama() }}><RefreshCw size={18} /></button>}
      <button type="button" aria-label={view.panorama ? '关闭360°观看' : '开启360°观看'} aria-pressed={view.panorama}
        title="360°观看（适用于全景相机画面）" disabled={disabled}
        className={`flex h-10 items-center rounded-base px-2.5 text-xs font-medium ${view.panorama ? 'bg-primary-600 text-white' : 'text-white hover:bg-white/10'} disabled:opacity-40`}
        onClick={e => { e.stopPropagation(); view.togglePanorama() }}>◎ 360°</button>
    </>}
    <button type="button" onClick={e => { e.stopPropagation(); void view.toggleFullscreen() }}
      className="flex h-10 w-10 items-center justify-center rounded-base text-white hover:bg-white/10 disabled:opacity-40"
      title={view.isFullscreen ? '退出全屏' : '全屏'} aria-label={view.isFullscreen ? '退出全屏' : '全屏'}
      aria-pressed={view.isFullscreen} data-testid="btn-fullscreen">
      {view.isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
    </button>
  </>
}
