import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import type { AiDetection } from '@/types/aiChannel'
import { drawPanoramaDetections, type PanoramaCamera } from './panoramaDetection'

/** Presentation only: never owns a media connection or changes playback time. */
export function usePlayerView(container: RefObject<HTMLDivElement | null>) {
  const [panorama, setPanorama] = useState(false)
  const [panoramaReset, setPanoramaReset] = useState(0)
  const [panoramaError, setPanoramaError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState('')
  const camera = useRef<PanoramaCamera | null>(null)
  const receivePanoramaCamera = useCallback((value: PanoramaCamera | null) => { camera.current = value }, [])
  const drawPanoramaFrame = useCallback((ctx: CanvasRenderingContext2D, detections: AiDetection[], width: number, height: number, frameW: number, frameH: number) => {
    drawPanoramaDetections(ctx, detections, camera.current, width, height, frameW, frameH)
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
    receivePanoramaCamera, drawPanoramaFrame, panoramaFailed, toggleFullscreen,
    togglePanorama: () => { setPanoramaError(''); setPanorama(v => !v) },
    resetPanorama: () => setPanoramaReset(v => v + 1) }
}

export function PlayerViewControls({ view, allowPanorama = true, disabled = false }: {
  view: ReturnType<typeof usePlayerView>; allowPanorama?: boolean; disabled?: boolean
}) {
  return <>
    {allowPanorama && <>
      {view.panorama && <button type="button" title="重置视角" aria-label="重置视角"
        className="min-h-8 min-w-8 rounded-base p-1 text-white hover:bg-white/10"
        onClick={e => { e.stopPropagation(); view.resetPanorama() }}><RefreshCw size={14} /></button>}
      <button type="button" aria-label={view.panorama ? '关闭360°观看' : '开启360°观看'} aria-pressed={view.panorama}
        title="360°观看（适用于2:1 ERP全景）" disabled={disabled}
        className={`min-h-8 rounded px-2 py-1 text-xs font-medium ${view.panorama ? 'bg-primary-600 text-white' : 'bg-black/65 text-white'} disabled:opacity-40`}
        onClick={e => { e.stopPropagation(); view.togglePanorama() }}>◎ 360°</button>
    </>}
    <button type="button" onClick={e => { e.stopPropagation(); void view.toggleFullscreen() }}
      className="min-h-8 min-w-8 rounded-base p-1 text-white hover:bg-white/10"
      title={view.isFullscreen ? '退出全屏' : '全屏'} aria-label={view.isFullscreen ? '退出全屏' : '全屏'}
      aria-pressed={view.isFullscreen} data-testid="btn-fullscreen">
      {view.isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </button>
  </>
}
