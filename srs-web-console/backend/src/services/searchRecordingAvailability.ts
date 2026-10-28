import { z } from 'zod';
import { endpoint, limitedJson, type InternalServiceConnection } from './internalServiceHttp.js';
import type { PersistentSearchOptions } from './persistentSearchWorker.js';

type Availability = 'available' | 'missing' | 'pending';
type WorkerInput = Parameters<NonNullable<PersistentSearchOptions['recordingAvailability']>>[0];
export type SearchRecordingAvailabilityInput = Omit<WorkerInput, 'signal'> & { signal?: AbortSignal };
const timestamp = z.string().datetime({ offset: true });
const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const segmentSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,256}$/), channelId: z.string().uuid(),
  startTs: milliseconds, endTs: milliseconds, durationMs: z.number().int().positive(),
  sizeBytes: z.number().int().positive(), width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384), playable: z.boolean(),
  complete: z.boolean().optional(), state: z.string().max(64).optional(),
}).passthrough().refine(segment => segment.endTs > segment.startTs);
type Segment = z.infer<typeof segmentSchema>;
interface Probe { status: number; data: unknown; truncated: boolean }
interface PageCache {
  connectionKey: string; until: number; probes: Map<string, Promise<Probe>>;
}
const MAX_SEGMENTS = 512, MAX_PROBES = 4, MAX_PAGE_LOOKUPS = 128;

// The worker sometimes projects one matched frame as from==to. Recorder uses
// half-open intervals, so inspect that exact millisecond rather than broadening
// the result to an unrelated nearby recording or querying an empty interval.
function windowOf(from: string, to: string): { from: number; to: number } {
  timestamp.parse(from); timestamp.parse(to);
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start ||
    end - start > 31 * 86400000 || end >= Number.MAX_SAFE_INTEGER) throw new Error('invalid_recording_window');
  return { from: start, to: end === start ? end + 1 : end };
}
function truncated(response: Response): boolean {
  return !!response.headers.get('content-range') || !!response.headers.get('x-next-cursor') ||
    !!response.headers.get('x-total-count') ||
    /\brel\s*=\s*["']?next\b/i.test(response.headers.get('link') ?? '') ||
    /^(1|true|yes)$/i.test(response.headers.get('x-truncated') ?? '') ||
    /^(1|true|yes)$/i.test(response.headers.get('x-results-truncated') ?? '') ||
    /^(1|true|yes)$/i.test(response.headers.get('x-has-more') ?? '');
}
function cover(segments: Segment[], from: number, to: number): Segment[] | null {
  const ordered = [...segments].sort((a, b) => a.startTs - b.startTs || b.endTs - a.endTs || a.id.localeCompare(b.id));
  const chosen: Segment[] = []; let cursor = from, index = 0;
  while (cursor < to) {
    let next: Segment | undefined;
    while (index < ordered.length && ordered[index].startTs <= cursor) {
      if (ordered[index].endTs > cursor && (!next || ordered[index].endTs > next.endTs)) next = ordered[index];
      ++index;
    }
    if (!next) return null;
    chosen.push(next); cursor = next.endTs;
    if (chosen.length > MAX_PROBES) return chosen;
  }
  return chosen;
}

/** Only a server-authorized recording UUID is accepted. The connection callback
 * supplies applied settings and the existing recorder service token; this is not
 * a new login, an arbitrary URL proxy or a reader of recorder's private database.
 * Per-page promises are weakly keyed and expire with the worker's short signal.
 */
export function createSearchRecordingAvailability(
  connection: () => Promise<InternalServiceConnection | null>,
  fetchImpl: typeof fetch = fetch,
): (input: SearchRecordingAvailabilityInput) => Promise<Availability> {
  const pages = new WeakMap<AbortSignal, PageCache>();
  return async input => {
    const deadline = AbortSignal.timeout(2000);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    // Contain connection callbacks or test transports that do not honor abort;
    // every following I/O boundary checks the same signal before starting work.
    return new Promise<Availability>(resolve => {
      let done = false;
      const finish = (value: Availability) => {
        if (done) return; done = true; signal.removeEventListener('abort', aborted); resolve(value);
      };
      const aborted = () => finish('pending');
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      void (async (): Promise<Availability> => {
        z.string().uuid().parse(input.channelId);
        z.string().min(1).max(128).refine(actor => !/[\u0000-\u001f\u007f]/u.test(actor)).parse(input.actor);
        const window = windowOf(input.from, input.to);
        const config = await connection(); signal.throwIfAborted();
        if (!config) return 'pending';
        endpoint(config, '/v1/recordings/segments');
        if (config.apiToken.length > 512 || /[\r\n]/.test(config.apiToken)) return 'pending';
        const transportSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(config.timeoutMs, 2000))]);
        const cacheSignal = input.signal ?? deadline;
        const connectionKey = `${config.baseUrl}\n${config.apiToken}`;
        let cache = pages.get(cacheSignal);
        if (!cache || cache.until <= Date.now() || cache.connectionKey !== connectionKey) {
          cache = { connectionKey, until: Date.now() + 2000, probes: new Map() }; pages.set(cacheSignal, cache);
        }
        const page = cache;
        const read = (path: string): Promise<Probe> => {
          signal.throwIfAborted();
          const existing = page.probes.get(path); if (existing) return existing;
          if (page.probes.size >= MAX_PAGE_LOOKUPS) throw new Error('recording_probe_budget');
          const promise = (async (): Promise<Probe> => {
            transportSignal.throwIfAborted();
            const response = await fetchImpl(endpoint(config, path), { redirect: 'error', signal: transportSignal,
              headers: { 'x-service-token': config.apiToken, accept: 'application/json' } });
            if (response.status !== 200) {
              await response.body?.cancel().catch(() => undefined);
              return { status: response.status, data: null, truncated: false };
            }
            if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
              await response.body?.cancel().catch(() => undefined); throw new Error('invalid_recording_response');
            }
            const data = await limitedJson(response); transportSignal.throwIfAborted();
            return { status: 200, data, truncated: truncated(response) };
          })();
          page.probes.set(path, promise); return promise;
        };
        const query = new URLSearchParams({ channel: input.channelId, from: String(window.from), to: String(window.to) });
        const response = await read(`/v1/recordings/segments?${query}`); signal.throwIfAborted();
        if (response.status !== 200 || response.truncated) return 'pending';
        // Current recorder returns an unpaged array of completed segments. A new
        // envelope, partial response, malformed row or cap hit is uncertainty.
        const segments = z.array(segmentSchema).max(MAX_SEGMENTS).parse(response.data);
        if (segments.length >= MAX_SEGMENTS || new Set(segments.map(segment => segment.id)).size !== segments.length ||
          segments.some(segment => segment.channelId !== input.channelId || segment.startTs >= window.to || segment.endTs <= window.from)) return 'pending';
        const ready = (segment: Segment) => segment.playable && segment.complete !== false &&
          (segment.state === undefined || ['complete', 'completed', 'ready', 'available'].includes(segment.state));
        let candidates = segments.filter(ready), probes = 0;
        for (;;) {
          const chosen = cover(candidates, window.from, window.to);
          if (!chosen) break;
          if (chosen.length > MAX_PROBES - probes) return 'pending';
          let unavailable: string | null = null;
          for (const segment of chosen) {
            const readable = await read(`/v1/recordings/${encodeURIComponent(segment.id)}/availability`); ++probes;
            signal.throwIfAborted();
            if (readable.status === 404) { unavailable = segment.id; break; }
            if (readable.status !== 200 || readable.truncated ||
              !z.object({ available: z.literal(true) }).safeParse(readable.data).success) return 'pending';
          }
          if (!unavailable) return 'available';
          candidates = candidates.filter(segment => segment.id !== unavailable);
        }
        if (segments.some(segment => !ready(segment))) return 'pending';
        const [healthResponse, configResponse, channelsResponse] = await Promise.all([
          read('/v1/recorder/health'), read('/v1/recorder/config'), read('/v1/recorder/channels'),
        ]);
        signal.throwIfAborted();
        if ([healthResponse, configResponse, channelsResponse].some(probe => probe.status !== 200 || probe.truncated)) return 'pending';
        const health = z.object({ ok: z.literal(true), storageHealthy: z.boolean(), blockedOp: z.string().nullable().optional() }).passthrough().parse(healthResponse.data);
        if (!health.storageHealthy || health.blockedOp) return 'pending';
        const applied = z.object({ files: z.object({ segmentSeconds: z.number().int().min(10).max(3600) }).passthrough() }).passthrough().parse(configResponse.data);
        const channels = z.array(z.object({ id: z.string().uuid(), recording: z.boolean(), recordingState: z.string().max(64),
          drainingPrevious: z.boolean().optional(), waitingPreviousWriter: z.boolean().optional(), codecWarning: z.string().nullable().optional() }).passthrough()).max(10000).parse(channelsResponse.data);
        if (new Set(channels.map(channel => channel.id)).size !== channels.length) return 'pending';
        const channel = channels.find(channel => channel.id === input.channelId);
        if (channel?.drainingPrevious || channel?.waitingPreviousWriter ||
          (channel?.recording && channel.codecWarning && ['no_idr', 'open_gop'].includes(channel.codecWarning))) return 'pending';
        // The segment API deliberately omits open MP4s. Allow closing, probing
        // and scanner time after the actual applied segment length; do not label
        // a just-captured match as missing while that file is still being written.
        const settling = applied.files.segmentSeconds * 1000 + 30000;
        if (window.to > Date.now() - settling) {
          return channel?.recording === false && channel.recordingState === 'disabled' ? 'missing' : 'pending';
        }
        return 'missing';
      })().then(finish, () => finish('pending'));
    });
  };
}
