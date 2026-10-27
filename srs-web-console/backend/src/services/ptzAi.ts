import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AppSettings } from '../types/channel.js';
import type { PgConfigStore } from '../store/pgStore.js';
import { resolveAiApiKey } from '../routes/aiProxy.js';
import { limitedJson } from '../routes/alarmProxy.js';
import { PtzError } from '../store/ptzStore.js';
const ai = z.object({
  id: z.string().min(1).max(128),
  analytics_reset_supported: z.boolean().optional(),
  config: z.object({
    stream: z.object({ url: z.string().max(2048) }),
    publish: z.object({
      enabled: z.boolean(),
      effective_target_url: z.string().max(2048).optional(),
      target_url: z.string().max(2048).nullable().optional(),
    }),
  }),
});
export function ptzAi(settings: () => Promise<AppSettings>, pg: PgConfigStore, fallback: string) {
  const call = async (path: string, body?: unknown) => {
    const s = await settings();
    const base = new URL(s.aiService.baseUrl || fallback);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new PtzError('ptz_ai_unavailable', 503);
    const key = await resolveAiApiKey(s, pg);
    const r = await fetch(new URL(path, base), {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      headers: {
        ...(key ? { 'x-api-key': key } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new PtzError('ptz_ai_unavailable', 503);
    return limitedJson(r);
  };
  return {
    list: async () =>
      z.object({ channels: z.array(ai).max(1024) }).parse(await call('/api/v1/channels')).channels,
    checkReset: async (ids: string[]) => {
      if (!ids.length) return;
      const channels = z
        .object({ channels: z.array(ai).max(1024) })
        .parse(await call('/api/v1/channels')).channels;
      if (ids.some((id) => channels.find((c) => c.id === id)?.analytics_reset_supported !== true))
        throw new PtzError('ptz_tracking_reset_unsupported', 422);
    },
    reset: async (ids: string[]) => {
      if (ids.length > 1024) throw new PtzError('ptz_ai_capacity', 503);
      let index = 0;
      const generation = randomUUID();
      await Promise.all(
        Array.from({ length: Math.min(2, ids.length) }, async () => {
          while (index < ids.length) {
            const id = ids[index++]!;
            const result = await call(
              `/api/v1/channels/${encodeURIComponent(id)}/analytics/reset`,
              { reason: 'ptz_view_change', generation },
            );
            if ((result as any).reset !== true)
              throw new PtzError('ptz_tracking_reset_pending', 503);
          }
        }),
      );
    },
  };
}
