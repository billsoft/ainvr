import type { AiDetection } from '@/types/aiChannel'

export interface TrailPoint { x: number; y: number; ptsNs: number }
export interface TrackTrail { id: string; points: TrailPoint[] }

/** Track identities are "<session>:<number>"; a new session starts after the
 * service resets tracking (restart, stream reconnect, model change). */
export function trackSession(id: string): string {
  const cut = id.lastIndexOf(':')
  return cut < 0 ? '' : id.slice(0, cut)
}

/** Observations only. Feed displayed-frame metadata, never latest API results. */
export class TrackTrailBuffer {
  private tracks = new Map<string, TrailPoint[]>()
  private lastPts: number | null = null
  private session: string | null = null
  private readonly durationSeconds: number
  private readonly maxTracks: number
  private readonly maxPoints: number
  private readonly maxGapSeconds: number
  constructor(
    // 30 s of history; 360 points keep all of it at 10 detections per second.
    durationSeconds = 30,
    maxTracks = 128,
    maxPoints = 360,
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
    if (this.lastPts !== null && (ptsNs < this.lastPts || ptsNs - this.lastPts > this.maxGapSeconds * 1e9)) this.clear()
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
      points.push({ x: x + w/2, y: y + h/2, ptsNs })
      this.tracks.delete(id)
      this.tracks.set(id, points.slice(-this.maxPoints))
      while (this.tracks.size > this.maxTracks) this.tracks.delete(this.tracks.keys().next().value!)
    }
    return this.snapshot()
  }
  private snapshot(): TrackTrail[] {
    return [...this.tracks].map(([id, points]) => ({id, points: points.map(p => ({...p}))}))
  }
}
