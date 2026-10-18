import type { ContainLayout } from './overlayGeometry'

export interface GroundingPoint {
  x: number
  y: number
  class_name: string
  confidence: number | null
  label_id?: string
  query_description?: string
}

export interface GroundingOverlay {
  points: GroundingPoint[]
  omitted: number
}

/** Only explicitly normalized,completed model output can place a marker. */
export function parseGroundingOverlay(extra: unknown): GroundingOverlay | undefined {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return undefined
  const grounding = (extra as Record<string, unknown>).grounding
  if (!grounding || typeof grounding !== 'object' || Array.isArray(grounding)) return undefined
  const g = grounding as Record<string, unknown>
  if (g.complete !== true || g.coordinate_space !== 'normalized_full_frame' || !Array.isArray(g.points)) return undefined
  const points: GroundingPoint[] = []
  for (const raw of g.points.slice(0, 300)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const p = raw as Record<string, unknown>
    if (typeof p.x !== 'number' || typeof p.y !== 'number' ||
        !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue
    if (p.confidence !== undefined && p.confidence !== null &&
        (typeof p.confidence !== 'number' || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1)) continue
    points.push({
      x: p.x, y: p.y,
      class_name: typeof p.class_name === 'string' ? p.class_name : typeof p.query_description === 'string' ? p.query_description : '',
      confidence: typeof p.confidence === 'number' ? p.confidence : null,
      ...(typeof p.label_id === 'string' ? { label_id: p.label_id } : {}),
      ...(typeof p.query_description === 'string' ? { query_description: p.query_description } : {}),
    })
  }
  const omitted = typeof g.sei_points_omitted === 'number' && Number.isSafeInteger(g.sei_points_omitted) && g.sei_points_omitted > 0
    ? g.sei_points_omitted : 0
  return { points, omitted: omitted + Math.max(0, g.points.length - 300) }
}

export function drawGroundingMarker(ctx: CanvasRenderingContext2D, point: GroundingPoint,
  x: number, y: number, bounds: ContainLayout): void {
  ctx.strokeStyle = '#22c55e'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(x, y, 5, 0, Math.PI * 2)
  ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y)
  ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9)
  ctx.stroke()
  const label = point.confidence === null ? point.class_name : `${point.class_name} ${(point.confidence * 100).toFixed(0)}%`
  if (!label) return
  ctx.font = '13px sans-serif'; ctx.textBaseline = 'alphabetic'
  const width = ctx.measureText(label).width + 6
  const lx = Math.max(bounds.offsetX, Math.min(bounds.offsetX + bounds.dispW - width, x + 11))
  const ly = y - 8 >= bounds.offsetY + 14 ? y - 8 : y + 19
  ctx.fillStyle = '#22c55e'; ctx.fillRect(lx, ly - 13, width, 16)
  ctx.fillStyle = '#0a0a0a'; ctx.fillText(label, lx + 3, ly)
}

export function drawGroundingNotice(ctx: CanvasRenderingContext2D, omitted: number, layout: ContainLayout): void {
  if (omitted <= 0) return
  ctx.font = '13px sans-serif'; ctx.textBaseline = 'alphabetic'
  const text = `另有 ${omitted} 个定位点未显示`
  ctx.fillStyle = '#0a0a0a'; ctx.fillRect(layout.offsetX + 6, layout.offsetY + 6, ctx.measureText(text).width + 10, 20)
  ctx.fillStyle = '#ffffff'; ctx.fillText(text, layout.offsetX + 11, layout.offsetY + 21)
}

/** Points use full-frame normalized coordinates,not YOLO box/letterbox math. */
export function drawGroundingPoints(ctx: CanvasRenderingContext2D, grounding: GroundingOverlay | undefined,
  layout: ContainLayout): void {
  if (!grounding || (!grounding.points.length && !grounding.omitted) || layout.dispW <= 0 || layout.dispH <= 0) return
  ctx.save(); ctx.beginPath(); ctx.rect(layout.offsetX, layout.offsetY, layout.dispW, layout.dispH); ctx.clip()
  for (const point of grounding.points) {
    drawGroundingMarker(ctx, point, layout.offsetX + point.x * layout.dispW, layout.offsetY + point.y * layout.dispH, layout)
  }
  drawGroundingNotice(ctx, grounding.omitted, layout)
  ctx.restore()
}
