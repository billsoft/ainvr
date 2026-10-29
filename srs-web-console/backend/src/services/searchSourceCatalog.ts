import { z } from 'zod';
import type { AppSettings, Channel } from '../types/channel.js';
import type { PgConfigStore } from '../store/pgStore.js';
import { resolveAiApiKey } from '../routes/aiProxy.js';
import { limitedJson } from './internalServiceHttp.js';
import { localRtmpStreamPath, resolvePtzSource } from './ptzSources.js';
import { normalizeInput } from './ingestPolicy.js';

const processorSchema = z.object({
  id: z.string().min(1).max(128),
  config: z.object({
    enabled: z.boolean().optional(), inference_fps: z.number().nonnegative().optional(),
    analytics: z.object({ enabled: z.boolean() }).optional(),
    model: z.object({ adapter: z.string().max(128) }).optional(),
    snapshot: z.object({ projection_mode: z.enum(['none', 'erp_equirect']).optional() }).optional(),
    stream: z.object({ url: z.string().max(2048) }),
    publish: z.object({ enabled: z.boolean(), effective_target_url: z.string().max(2048).optional(),
      target_url: z.string().max(2048).nullable().optional() }),
  }),
});
export type SearchAiProcessor = z.infer<typeof processorSchema>;
export interface SearchSource {
  channel_id: string; input_stream_id: string; processor_id: string;
  /** Actual local stream consumed/published by this processor, not the root's path. */
  input_path: string; output_path: string;
  recording_channel_id: string; object: boolean; scene: boolean;
}
export interface SearchSourceChannel {
  id: string; name: string;
  /** Live sampling capability; never revokes historical query permission. */
  sampling_supported?: boolean;
  sampling_reason?: 'projection_unsupported' | null;
}
export interface SearchSourceCatalog {
  sources: SearchSource[];
  channels: SearchSourceChannel[];
  /** Non-secret source generation material included only in the revision hash. */
  identities: unknown[];
}

/** Reuse the same local stream and ancestry resolver as PTZ. The catalogue is
 * configuration-derived: an offline camera needs no fresh detection to appear.
 * Duplicate publishers and ambiguous source paths are never guessed. */
export function buildSearchSourceCatalog(channels: Channel[], raw: unknown): SearchSourceCatalog {
  const ai = z.array(processorSchema).max(1024).parse(raw);
  if (new Set(ai.map(p => p.id)).size !== ai.length) throw Error('source_catalog_unavailable');
  const byPath = new Map<string, Channel[]>();
  for (const channel of channels) {
    if (!z.string().uuid().safeParse(channel.id).success) continue;
    const app = channel.app || 'live';
    if (typeof app !== 'string' || typeof channel.streamName !== 'string') continue;
    try { normalizeInput({ app, streamName: channel.streamName }); }
    catch { continue; } // Keep unrelated valid sources; never repair or rename legacy channels.
    const path = `/${app}/${channel.streamName}`;
    byPath.set(path, [...(byPath.get(path) ?? []), channel]);
  }
  const publishers = new Map<string, SearchAiProcessor[]>();
  for (const processor of ai) {
    if (!processor.config.publish.enabled) continue;
    const path = localRtmpStreamPath(processor.config.publish.effective_target_url || processor.config.publish.target_url || '');
    if (path) publishers.set(path, [...(publishers.get(path) ?? []), processor]);
  }
  const sources: SearchSource[] = [], visible: SearchSourceCatalog['channels'] = [], identities: unknown[] = [];
  for (const [path, owners] of publishers) {
    const outputs = byPath.get(path) ?? [];
    if (outputs.length !== 1 || owners.length !== 1) continue;
    const output = outputs[0]!, processor = owners[0]!;
    const inputPath = localRtmpStreamPath(processor.config.stream.url);
    if (!inputPath || (byPath.get(inputPath) ?? []).length !== 1) continue;
    try {
      const resolved = resolvePtzSource(output.id, channels, ai);
      if (resolved.root.id === output.id || !z.string().uuid().safeParse(resolved.root.id).success) continue;
      const tracking = processor.config.analytics?.enabled === true && processor.config.model?.adapter !== 'locateanything_bpu' &&
        (processor.config.inference_fps === 0 || (processor.config.inference_fps ?? 0) >= 3);
      // Same default as the AI config. This describes processing geometry,
      // not a physical camera/lens calibration or a semantic quality claim.
      const supported = (processor.config.snapshot?.projection_mode ?? 'none') === 'none';
      sources.push({ channel_id: output.id, input_stream_id: resolved.root.id, processor_id: processor.id,
        input_path: inputPath, output_path: path, recording_channel_id: output.id, object: supported && tracking, scene: supported });
      visible.push({ id: output.id, name: output.name, sampling_supported: supported,
        sampling_reason: supported ? null : 'projection_unsupported' });
      identities.push([output.id, output.inputGeneration ?? null, resolved.root.id, resolved.root.inputGeneration ?? null,
        processor.id, processor.config, resolved.fingerprint]);
    } catch { /* One ambiguous mapping does not remove unrelated channels. */ }
  }
  const order = (a: { channel_id: string }, b: { channel_id: string }) => a.channel_id.localeCompare(b.channel_id);
  return { sources: sources.sort(order), channels: visible.sort((a, b) => a.id.localeCompare(b.id)),
    identities: identities.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}

export async function readSearchAiProcessors(settings: AppSettings, pg: PgConfigStore | null,
  fallback: string, fetchImpl: typeof fetch = fetch): Promise<SearchAiProcessor[]> {
  const base = new URL(settings.aiService.baseUrl || fallback);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw Error('source_catalog_unavailable');
  const key = await resolveAiApiKey(settings, pg);
  const response = await fetchImpl(new URL('/api/v1/channels', base), { redirect: 'error',
    headers: key ? { 'x-api-key': key } : {}, signal: AbortSignal.timeout(5000) });
  if (!response.ok) { await response.body?.cancel(); throw Error('source_catalog_unavailable'); }
  return z.object({ channels: z.array(processorSchema).max(1024) }).parse(await limitedJson(response)).channels;
}
