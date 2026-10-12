import { useEffect, useRef } from 'react'
import type * as THREE from 'three'
import type { PanoramaCamera } from './panoramaDetection'

export function PanoramaView({ video, onError, resetToken = 0, onCamera }: { video: HTMLVideoElement; onError: (message: string) => void; resetToken?: number; onCamera?: (camera: PanoramaCamera | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const resetRef = useRef(() => {})
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let cleanup = () => {}
    // Load only when requested; the existing video owns networking and decoding.
    void import('three').then(T => {
      if (disposed) return
      let renderer: THREE.WebGLRenderer | undefined
      let texture: THREE.VideoTexture | undefined
      let geometry: THREE.SphereGeometry | undefined
      let material: THREE.MeshBasicMaterial | undefined
      let raf = 0, frame = 0
      let width = 0, height = 0, yaw = 0, pitch = 0
      let visible = true
      const points = new Map<number, { x: number; y: number }>()
      const camera = new T.PerspectiveCamera(75, 1, 0.1, 20)
      const scene = new T.Scene()
      const rvfc = typeof video.requestVideoFrameCallback === 'function'
      const fail = () => { if (!disposed) onError('此设备无法全景显示，已返回平面') }
      const render = () => {
        raf = 0
        if (disposed || document.hidden || !visible || !renderer) return
        try {
          if (video.readyState < 2 || !video.videoWidth) return
          if (video.videoWidth > renderer.capabilities.maxTextureSize || video.videoHeight > renderer.capabilities.maxTextureSize) {
            fail(); return
          }
          if (width !== video.videoWidth || height !== video.videoHeight) {
            texture?.dispose()
            width = video.videoWidth; height = video.videoHeight
            texture = new T.VideoTexture(video)
            texture.colorSpace = T.SRGBColorSpace
            material!.map = texture; material!.needsUpdate = true
          }
          camera.rotation.order = 'YXZ'
          camera.rotation.set(pitch, yaw, 0)
          renderer.render(scene, camera)
          onCamera?.({ view: camera.matrixWorldInverse.elements, projection: camera.projectionMatrix.elements })
        } catch { fail() }
      }
      const schedule = () => { if (!disposed && !raf && visible && !document.hidden) raf = requestAnimationFrame(render) }
      const resize = () => {
        if (!renderer) return
        const w = host.clientWidth, h = host.clientHeight
        if (!w || !h) return
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
        renderer.setSize(w, h)
        camera.aspect = w / h; camera.updateProjectionMatrix(); schedule()
      }
      const distance = () => { const p = [...points.values()]; return p.length === 2 ? Math.hypot(p[0]!.x - p[1]!.x, p[0]!.y - p[1]!.y) : 0 }
      const zoom = (delta: number) => { camera.fov = Math.max(35, Math.min(100, camera.fov + delta)); camera.updateProjectionMatrix(); schedule() }
      const down = (e: PointerEvent) => { e.stopPropagation(); if (e.pointerType === 'mouse' && e.button !== 0) return; points.set(e.pointerId, { x: e.clientX, y: e.clientY }); host.setPointerCapture(e.pointerId) }
      const move = (e: PointerEvent) => {
        const old = points.get(e.pointerId); if (!old) return
        const before = distance()
        points.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (points.size === 1) {
          yaw += (e.clientX - old.x) * .004
          pitch = Math.max(-Math.PI / 2 + .01, Math.min(Math.PI / 2 - .01, pitch + (e.clientY - old.y) * .004))
          schedule()
        } else if (before) zoom((before - distance()) * .15)
      }
      const up = (e: PointerEvent) => { points.delete(e.pointerId) }
      const wheel = (e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); zoom(Math.sign(e.deltaY) * 3) }
      const visibility = () => { points.clear(); schedule() }
      const lost = (e: Event) => { e.preventDefault(); fail() }
      let observer: ResizeObserver | undefined
      let intersection: IntersectionObserver | undefined
      let interval: ReturnType<typeof setInterval> | undefined
      cleanup = () => {
        cancelAnimationFrame(raf)
        if (rvfc) video.cancelVideoFrameCallback(frame)
        if (interval) clearInterval(interval)
        observer?.disconnect(); intersection?.disconnect()
        document.removeEventListener('visibilitychange', visibility)
        video.removeEventListener('loadeddata', schedule)
        video.removeEventListener('seeked', schedule)
        video.removeEventListener('resize', schedule)
        host.removeEventListener('pointerdown', down); host.removeEventListener('pointermove', move)
        host.removeEventListener('pointerup', up); host.removeEventListener('pointercancel', up); host.removeEventListener('lostpointercapture', up)
        host.removeEventListener('wheel', wheel)
        renderer?.domElement.removeEventListener('webglcontextlost', lost)
        texture?.dispose(); material?.dispose(); geometry?.dispose()
        renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove()
      }
      try {
        renderer = new T.WebGLRenderer({ antialias: false, powerPreference: 'default' })
        host.appendChild(renderer.domElement)
        renderer.domElement.addEventListener('webglcontextlost', lost)
        geometry = new T.SphereGeometry(10, 64, 32)
        geometry.scale(-1, 1, 1)
        material = new T.MeshBasicMaterial({ color: 0xffffff })
        scene.add(new T.Mesh(geometry, material))
        observer = new ResizeObserver(resize); observer.observe(host)
        intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; schedule() }); intersection.observe(host)
        host.addEventListener('pointerdown', down); host.addEventListener('pointermove', move)
        host.addEventListener('pointerup', up); host.addEventListener('pointercancel', up); host.addEventListener('lostpointercapture', up)
        host.addEventListener('wheel', wheel, { passive: false })
        document.addEventListener('visibilitychange', visibility)
        video.addEventListener('loadeddata', schedule); video.addEventListener('seeked', schedule); video.addEventListener('resize', schedule)
        if (rvfc) {
          const tick = () => { if (disposed) return; schedule(); frame = video.requestVideoFrameCallback(tick) }
          frame = video.requestVideoFrameCallback(tick)
        } else interval = setInterval(() => { if (!video.paused) schedule() }, 40)
        resetRef.current = () => { yaw = pitch = 0; camera.fov = 75; camera.updateProjectionMatrix(); schedule() }
        resize()
      } catch { cleanup(); fail() }
    }).catch(() => { if (!disposed) onError('全景组件加载失败，已返回平面') })
    return () => { disposed = true; onCamera?.(null); cleanup() }
  }, [video, onError, onCamera])
  useEffect(() => { resetRef.current() }, [resetToken])
  return <>
    <div ref={hostRef} data-testid="panorama-view" className="absolute inset-0 bg-black touch-none"
      onClick={e => e.stopPropagation()} onDoubleClick={e => { e.stopPropagation(); resetRef.current() }} />

  </>
}
