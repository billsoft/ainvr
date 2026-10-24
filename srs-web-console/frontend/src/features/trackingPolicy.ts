/** Operational floor, not an accuracy guarantee. Runtime continuity is checked separately. */
export const MIN_TRACKING_FPS = 3
export function trackingUnavailableReason(preset: string, fps: number): string | null {
  if (preset === 'locateanything-3b') return '当前模型采用低频识别，不支持可靠的目标跟踪。'
  if (!Number.isFinite(fps) || fps < 0) return '请先设置有效的检测帧率。'
  if (fps > 0 && fps < MIN_TRACKING_FPS) return `目标跟踪要求计划检测帧率至少 ${MIN_TRACKING_FPS} FPS。`
  return null
}
