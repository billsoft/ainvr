import type { SnapshotItem } from '@/types/snapshot'

/** Map original full-frame coordinates into its possibly edge-padded JPEG. */
export function snapshotPointPosition(item: Pick<SnapshotItem, 'geometry_type' | 'context_image' | 'point'>): { x: number; y: number } | null {
  const p = item.point
  if (item.geometry_type !== 'point' || item.context_image !== 'full_frame' ||
      !p || p.coordinate_space !== 'normalized_full_frame' ||
      ![p.x, p.y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) return null
  const r = p.context_image_rect === undefined ? { x: 0, y: 0, w: 1, h: 1 } : p.context_image_rect
  if (!r || typeof r !== 'object' || Array.isArray(r) ||
      ![r.x, r.y, r.w, r.h].every(v => typeof v === 'number' && Number.isFinite(v)) ||
      r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0 || r.x + r.w > 1 || r.y + r.h > 1) return null
  return { x: r.x + p.x * r.w, y: r.y + p.y * r.h }
}
