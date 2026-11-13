import type { AiPoseAttribute } from '@/types/aiChannel'

// Pose is a separate, versioned attribute. Never interpret it as five face landmarks.
export function parsePoseAttribute(raw: unknown): AiPoseAttribute | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  if (p.schema_version !== '1.0' || p.type !== 'keypoints' || p.status !== 'observed'
    || p.layout !== 'coco17' || p.coordinate_space !== 'original_image'
    || !Array.isArray(p.image_size) || p.image_size.length !== 2
    || !p.image_size.every(v => Number.isInteger(v) && v > 0 && v <= 16384)
    || p.visibility_threshold !== 0.5 || typeof p.source_model_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(p.source_model_sha256)
    || !Array.isArray(p.points) || p.points.length !== 17) return null
  const points: AiPoseAttribute['points'] = []
  for (const point of p.points) {
    if (!point || typeof point !== 'object') return null
    const { x, y, score } = point as Record<string, unknown>
    if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 32768
      || typeof y !== 'number' || !Number.isFinite(y) || Math.abs(y) > 32768
      || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return null
    points.push({ x, y, score })
  }
  return {
    schema_version: '1.0', type: 'keypoints', status: 'observed', layout: 'coco17',
    coordinate_space: 'original_image', image_size: [p.image_size[0], p.image_size[1]],
    visibility_threshold: 0.5, source_model_sha256: p.source_model_sha256, points,
    ...(typeof p.source_node === 'string' && p.source_node.length <= 48 ? { source_node: p.source_node } : {}),
  }
}

export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 2], [1, 3], [2, 4], [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
]
