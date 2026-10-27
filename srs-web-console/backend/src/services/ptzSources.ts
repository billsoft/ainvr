import { createHash } from 'node:crypto';
import type { Channel } from '../types/channel.js';
import { PtzError } from '../store/ptzStore.js';
export interface AiSourceLink {
  id: string;
  config: {
    stream: { url: string };
    publish: { enabled: boolean; effective_target_url?: string; target_url?: string | null };
  };
}
function stream(url: string) {
  try {
    const u = new URL(url);
    if (
      u.protocol !== 'rtmp:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      (u.port && u.port !== '1935')
    )
      return null;
    return u.pathname;
  } catch {
    return null;
  }
}
export function resolvePtzSource(
  id: string,
  channels: Channel[],
  ai: AiSourceLink[],
  nodeSources?: string[],
) {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const byStream = new Map<string, Channel[]>();
  for (const c of channels) {
    const k = `/${c.app || 'live'}/${c.streamName}`;
    byStream.set(k, [...(byStream.get(k) ?? []), c]);
  }
  const parents = new Map<string, Set<string>>();
  const processors = new Map<string, Set<string>>();
  for (const a of ai) {
    const input = byStream.get(stream(a.config.stream.url) ?? '') ?? [];
    const output =
      byStream.get(
        stream(a.config.publish.effective_target_url || a.config.publish.target_url || '') ?? '',
      ) ?? [];
    if (input.length === 1) {
      const ids = processors.get(input[0]!.id) ?? new Set();
      ids.add(a.id);
      processors.set(input[0]!.id, ids);
    }
    if (!a.config.publish.enabled) continue;
    for (const c of output) {
      const ids = parents.get(c.id) ?? new Set();
      for (const source of input) ids.add(source.id);
      if (input.length !== 1) ids.add('__ambiguous__');
      parents.set(c.id, ids);
    }
  }
  let root = byId.get(id);
  const seen = new Set<string>();
  if (!root) throw new PtzError('ptz_channel_not_found', 404);
  while (parents.has(root.id)) {
    if (seen.has(root.id)) throw new PtzError('ptz_source_ambiguous');
    seen.add(root.id);
    const p = parents.get(root.id)!;
    if (p.size !== 1) throw new PtzError('ptz_source_ambiguous');
    root = byId.get([...p][0]!);
    if (!root) throw new PtzError('ptz_source_ambiguous');
  }
  // Main/sub profiles of one ONVIF video source share the physical view.
  const aliases = channels.filter(
    (c) =>
      c.id === root!.id ||
      (root!.onvif &&
        c.onvif?.deviceId === root!.onvif.deviceId &&
        (nodeSources ?? [root!.onvif.videoSource]).includes(c.onvif!.videoSource)),
  );
  const descendants = new Set(aliases.map((c) => c.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, ps] of parents) {
      if ([...ps].some((p) => descendants.has(p)) && !descendants.has(child)) {
        descendants.add(child);
        changed = true;
      }
    }
  }
  const processorIds = [
    ...new Set([...descendants].flatMap((source) => [...(processors.get(source) ?? [])])),
  ].sort();
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        root: root.id,
        generation: root.inputGeneration,
        onvif: root.onvif,
        streams: aliases.map((c) => [c.id, c.inputGeneration, c.onvif]).sort(),
        parents: [...parents]
          .filter(([id]) => descendants.has(id))
          .map(([id, ids]) => [id, [...ids].sort()])
          .sort(),
        processorIds,
      }),
    )
    .digest('hex');
  return { root, sourceIds: [...descendants].sort(), processorIds, fingerprint };
}

// Offline configuration follows a physical video source, never a replaceable
// stream profile or AI output. A verified shared node combines restrictions.
export function ptzCameraKey(root: Channel, gbIdentity?: string) {
  if (root.onvif) {
    const key = `onvif:${root.onvif.deviceId}/${root.onvif.videoSource}`;
    return { key, identity: key };
  }
  if (!gbIdentity) throw new PtzError('ptz_not_supported', 422);
  const parsed = JSON.parse(gbIdentity) as string[];
  if (parsed.length !== 3 || parsed.some((v) => typeof v !== 'string'))
    throw new PtzError('ptz_source_changed');
  const key = `gb28181:${parsed[1]}/${parsed[2]}`;
  return { key, identity: key };
}
