import type { AiDetection } from '@/types/aiChannel'

export interface TrailPoint { x: number; y: number; ptsNs: number; predicted?: boolean }
export interface TrackTrail { id: string; points: TrailPoint[] }

/** A result older than the last one by at most this much is alignment jitter
 * (approximate alignment re-estimates its delay every few seconds):it is dropped,
 * the trails stay. Larger backward jumps are a seek or a restart:trails reset. */
const STALE_BACKSTEP_SECONDS = 5

/** Track identities are "<session>:<number>"; a new session starts after the
 * service resets tracking (restart, stream reconnect, model change). */
export function trackSession(id: string): string {
  const cut = id.lastIndexOf(':')
  return cut < 0 ? '' : id.slice(0, cut)
}

/** Segments between consecutive points;a segment touching a predicted point is drawn dashed. */
export function trailSegments(points: TrailPoint[]): { from: TrailPoint; to: TrailPoint; predicted: boolean }[] {
  const out: { from: TrailPoint; to: TrailPoint; predicted: boolean }[] = []
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!, to = points[i]!
    out.push({ from, to, predicted: !!from.predicted || !!to.predicted })
  }
  return out
}

/** Observations and flagged short-loss predictions. Feed displayed-frame metadata, never latest API results.
 * A trail lives exactly as long as its target:a newer result without that target
 * (no observed, low-confidence or predicted box) erases the whole trail. */
export class TrackTrailBuffer {
  private tracks = new Map<string, TrailPoint[]>()
  private lastPts: number | null = null
  private session: string | null = null
  private readonly durationSeconds: number
  private readonly maxTracks: number
  private readonly maxPoints: number
  private readonly maxGapSeconds: number
  constructor(
    // Keep five seconds independently of display sampling density.
    durationSeconds = 5,
    maxTracks = 128,
    maxPoints = 120,
    maxGapSeconds = 3,
  ) {
    this.durationSeconds = durationSeconds
    this.maxTracks = maxTracks
    this.maxPoints = maxPoints
    this.maxGapSeconds = maxGapSeconds
    if (![durationSeconds,maxTracks,maxPoints,maxGapSeconds].every(Number.isFinite) ||
        durationSeconds <= 0 || maxTracks < 1 || maxPoints < 2 || maxGapSeconds <= 0 ||
        !Number.isInteger(maxTracks) || !Number.isInteger(maxPoints)) throw new Error('Invalid trail limits')
  }
  clear() { this.tracks.clear(); this.lastPts = null; this.session = null }
  update(ptsNs: number | null | undefined, detections: AiDetection[]): TrackTrail[] {
    if (ptsNs == null || !Number.isFinite(ptsNs) || ptsNs < 0) return []
    if (this.lastPts !== null && ptsNs < this.lastPts) {
      if (this.lastPts - ptsNs <= STALE_BACKSTEP_SECONDS * 1e9) return this.snapshot()
      this.clear()
    }
    if (this.lastPts !== null && ptsNs - this.lastPts > this.maxGapSeconds * 1e9) this.clear()
    // Held metadata is not another observation.
    if (ptsNs === this.lastPts) return this.snapshot()
    this.lastPts = ptsNs
    const cutoff = ptsNs - this.durationSeconds * 1e9
    for (const [id, points] of this.tracks) {
      const retained = points.filter(p => p.ptsNs >= cutoff)
      if (!retained.length) this.tracks.delete(id)
      else this.tracks.set(id, retained)
    }
    // Old-session identities are never drawn next to the new session's targets.
    const current = detections.find(d => d.track_id && d.track_id.length <= 256)?.track_id
    if (current !== undefined) {
      const session = trackSession(current)
      if (this.session !== null && session !== this.session) this.tracks.clear()
      this.session = session
    }
    const seen = new Set<string>()
    for (const detection of detections) {
      const id = detection.track_id
      if (!id || id.length > 256 || seen.has(id) || trackSession(id) !== this.session) continue
      seen.add(id)
      const {x,y,w,h} = detection.bbox
      if (![x,y,w,h].every(Number.isFinite) || w <= 0 || h <= 0) continue
      let points = this.tracks.get(id) ?? []
      const last = points.at(-1)
      if (last && ptsNs - last.ptsNs > this.maxGapSeconds * 1e9) points = []
      // The trail follows the centre of the drawn box.
      points.push({ x: x + w/2, y: y + h/2, ptsNs, ...(detection.predicted ? { predicted: true } : {}) })
      this.tracks.delete(id)
      this.tracks.set(id, sampleTrail(points, Math.max(512, this.maxPoints)))
      while (this.tracks.size > this.maxTracks) this.tracks.delete(this.tracks.keys().next().value!)
    }
    // The target is gone (left, lost beyond the prediction time, or tracking reset).
    for (const id of [...this.tracks.keys()]) if (!seen.has(id)) this.tracks.delete(id)
    return this.snapshot()
  }
  private snapshot(): TrackTrail[] {
    return [...this.tracks].map(([id, points]) => ({id, points: sampleTrail(points, this.maxPoints).map(p => ({...p}))}))
  }
}

/** Display-only reduction; retain both time endpoints. A skipped prediction
 * marks its replacement segment dashed, never as wholly real observation. */
function sampleTrail(points: TrailPoint[], limit: number): TrailPoint[] {
  if (points.length <= limit) return points
  const result: TrailPoint[] = [points[0]!]
  let previous = 0
  for (let i = 1; i < limit; i++) {
    const index = Math.round(i * (points.length - 1) / (limit - 1))
    const predicted = points.slice(previous, index + 1).some(p => p.predicted)
    result.push({ ...points[index]!, ...(predicted ? { predicted: true } : {}) })
    previous = index
  }
  return result
}
