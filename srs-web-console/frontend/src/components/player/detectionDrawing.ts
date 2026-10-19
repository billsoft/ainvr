import type { AiDetection } from '@/types/aiChannel'
import { computeContainLayout, projectDetectionBox, projectLandmark } from './overlayGeometry'

const BOX_COLOR = '#22c55e'
const LANDMARK_COLOR = '#ef4444'
const LABEL_TEXT_COLOR = '#0a0a0a'

export function drawDetections(
  ctx: CanvasRenderingContext2D,
  detections: AiDetection[],
  layout: ReturnType<typeof computeContainLayout>,
  frameW: number,
  frameH: number,
): void {
  if (!frameW || !frameH) return
  ctx.lineWidth = 2
  ctx.font = '13px sans-serif'
  ctx.textBaseline = 'alphabetic'
  for (const d of detections) {
    const box = projectDetectionBox(d, layout, frameW, frameH)
    ctx.strokeStyle = BOX_COLOR
    ctx.strokeRect(box.x, box.y, box.w, box.h)
    const identity = d.track_id ? ` #${d.track_id.split(':').at(-1)}` : ''
    const label = (d.confidence === null ? d.class_name : `${d.class_name} ${(d.confidence * 100).toFixed(0)}%`) + identity
    const metrics = ctx.measureText(label)
    const labelY = box.y > 16 ? box.y - 4 : box.y + 16
    ctx.fillStyle = BOX_COLOR
    ctx.fillRect(box.x, labelY - 13, metrics.width + 6, 15)
    ctx.fillStyle = LABEL_TEXT_COLOR
    ctx.fillText(label, box.x + 3, labelY)
    if (d.landmarks) {
      ctx.fillStyle = LANDMARK_COLOR
      for (const lm of d.landmarks) {
        const p = projectLandmark(lm, layout, frameW, frameH)
        ctx.beginPath()
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}

