/** Shared navigation for evidence consumers. The caller supplies the explicit
 * recording identity; this helper must never guess an input/output fallback. */
export const EVIDENCE_PRE_ROLL_MS = 2000
export function recordingPlaybackHref(channelId: string | null | undefined, from: number, to: number) {
  if (!channelId || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return null
  return `/playback/${encodeURIComponent(channelId)}?from=${Math.max(0, from)}&to=${to}&autoplay=1`
}
export function evidencePlaybackHref(channelId: string | null | undefined, start: string, end: string) {
  const from = Date.parse(start), to = Date.parse(end)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null
  return recordingPlaybackHref(channelId, from - EVIDENCE_PRE_ROLL_MS, to + 15000)
}
