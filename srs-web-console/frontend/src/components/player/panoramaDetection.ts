import type { AiDetection } from '@/types/aiChannel'

export type PanoramaCamera = { view: readonly number[]; projection: readonly number[] }
type Point = [number, number, number]

// Matches SphereGeometry(10).scale(-1, 1, 1), including its UV v inversion.
export function erpPoint(x: number, y: number, w: number, h: number): Point {
  const longitude = x / w * Math.PI * 2
  const theta = y / h * Math.PI
  return [10 * Math.cos(longitude) * Math.sin(theta), 10 * Math.cos(theta), 10 * Math.sin(longitude) * Math.sin(theta)]
}
function transform(p: Point, m: readonly number[]): Point {
  return [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!]
}
function screen(p: Point, m: readonly number[], w: number, h: number): [number, number] {
  const q = transform(p, m)
  const divisor = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!
  return [(q[0] / divisor + 1) * w / 2, (1 - q[1] / divisor) * h / 2]
}
// Clip before perspective division: never connect through the back hemisphere.
export function clipNear(a: Point, b: Point): [Point, Point] | null {
  const near = -.1
  if (a[2] > near && b[2] > near) return null
  if (a[2] > near || b[2] > near) {
    const t = (near - a[2]) / (b[2] - a[2])
    const p: Point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), near]
    return a[2] > near ? [p, b] : [a, p]
  }
  return [a, b]
}
export function drawPanoramaDetections(ctx: CanvasRenderingContext2D, detections: AiDetection[],
  camera: PanoramaCamera | null, width: number, height: number, frameW: number, frameH: number) {
  if (!camera || frameW <= 0 || frameH <= 0) return
  const point = (x: number, y: number) => transform(erpPoint(x, y, frameW, frameH), camera.view)
  const visiblePoint = (x: number, y: number) => {
    const p = point(x, y)
    if (p[2] > -.1) return null
    const s = screen(p, camera.projection, width, height)
    return s[0] >= 0 && s[0] <= width && s[1] >= 0 && s[1] <= height ? s : null
  }
  ctx.save()
  ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip()
  ctx.lineWidth = 2; ctx.font = '13px sans-serif'; ctx.textBaseline = 'alphabetic'
  for (const d of detections.slice(0, 256)) {
    const { x, y, w, h } = d.bbox
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || w > frameW || h <= 0) continue
    const top = Math.max(0, y), bottom = Math.min(frameH, y + h)
    if (bottom <= top) continue
    // Keep x unwrapped across the seam; trigonometry provides periodic mapping.
    const corners = [[x, top], [x + w, top], [x + w, bottom], [x, bottom], [x, top]]
    ctx.strokeStyle = '#22c55e'; ctx.beginPath()
    for (let edge = 0; edge < 4; edge++) {
      const a = corners[edge]!, b = corners[edge + 1]!
      const steps = Math.min(180, Math.max(1, Math.ceil(Math.max(Math.abs(b[0]! - a[0]!) / frameW * 360, Math.abs(b[1]! - a[1]!) / frameH * 180) / 2)))
      let prev = point(a[0]!, a[1]!)
      for (let i = 1; i <= steps; i++) {
        const next = point(a[0]! + (b[0]! - a[0]!) * i / steps, a[1]! + (b[1]! - a[1]!) * i / steps)
        const clipped = clipNear(prev, next)
        if (clipped) {
          const p = screen(clipped[0], camera.projection, width, height), q = screen(clipped[1], camera.projection, width, height)
          ctx.moveTo(...p); ctx.lineTo(...q)
        }
        prev = next
      }
    }
    ctx.stroke()
    const label = visiblePoint(x + w / 2, top)
    if (label) {
      const text = d.confidence === null ? d.class_name : `${d.class_name} ${(d.confidence * 100).toFixed(0)}%`
      const tw = ctx.measureText(text).width + 6
      const lx = Math.max(0, Math.min(width - tw, label[0] - tw / 2)), ly = Math.max(15, label[1] - 4)
      ctx.fillStyle = '#22c55e'; ctx.fillRect(lx, ly - 13, tw, 16)
      ctx.fillStyle = '#0a0a0a'; ctx.fillText(text, lx + 3, ly)
    }
    ctx.fillStyle = '#ef4444'
    for (const lm of (d.landmarks ?? []).slice(0, 128)) {
      if (!Number.isFinite(lm.x) || !Number.isFinite(lm.y)) continue
      const p = visiblePoint(lm.x, lm.y)
      if (p) { ctx.beginPath(); ctx.arc(...p, 3, 0, 2 * Math.PI); ctx.fill() }
    }
  }
  ctx.restore()
}
