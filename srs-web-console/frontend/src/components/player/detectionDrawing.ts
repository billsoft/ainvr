import type { AiDetection } from '@/types/aiChannel'
import { computeContainLayout, projectDetectionBox, projectLandmark } from './overlayGeometry'
import { parsePoseAttribute, POSE_CONNECTIONS } from './poseAttributes'

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
    // 短时丢失的推算框用虚线，与真实检测区分。
    ctx.setLineDash?.(d.predicted || d.lowConfidence ? [6, 4] : [])
    ctx.strokeRect(box.x, box.y, box.w, box.h)
    const identity = d.track_id ? ` #${d.track_id.split(':').at(-1)}` : ''
    const label = d.predicted ? `${(typeof d.model_extra?.attributes?.plate_text?.value === 'string' ? d.model_extra.attributes.plate_text.value : d.class_name)}${identity} 推算`
      : d.lowConfidence ? `${(typeof d.model_extra?.attributes?.plate_text?.value === 'string' ? d.model_extra.attributes.plate_text.value : d.class_name)}${identity} 低置信`
      : (d.confidence === null ? (typeof d.model_extra?.attributes?.plate_text?.value === 'string' ? d.model_extra.attributes.plate_text.value : d.class_name) : `${(typeof d.model_extra?.attributes?.plate_text?.value === 'string' ? d.model_extra.attributes.plate_text.value : d.class_name)} ${(d.confidence * 100).toFixed(0)}%`) + identity
    const metrics = ctx.measureText(label)
    const labelY = box.y > 16 ? box.y - 4 : box.y + 16
    ctx.fillStyle = BOX_COLOR
    ctx.fillRect(box.x, labelY - 13, metrics.width + 6, 15)
    ctx.fillStyle = LABEL_TEXT_COLOR
    ctx.fillText(label, box.x + 3, labelY)
    // Draw only observed pose on its original image geometry, never extrapolate
    // stale joints with a predicted/lost bounding box.
    const pose = !d.predicted && !d.lowConfidence ? parsePoseAttribute(d.model_extra?.attributes?.pose) : null
    if (pose && pose.image_size[0] === frameW && pose.image_size[1] === frameH) {
      const visible = pose.points.map(p => p.score >= pose.visibility_threshold
        && p.x >= 0 && p.x <= frameW && p.y >= 0 && p.y <= frameH
        ? projectLandmark(p, layout, frameW, frameH) : null)
      ctx.strokeStyle = '#38bdf8'
      ctx.fillStyle = '#e0f2fe'
      for (const [a, b] of POSE_CONNECTIONS) {
        const start = visible[a], end = visible[b]
        if (!start || !end) continue
        ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke()
      }
      for (const p of visible) if (p) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill()
      }
    }
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
  ctx.setLineDash?.([])
}

