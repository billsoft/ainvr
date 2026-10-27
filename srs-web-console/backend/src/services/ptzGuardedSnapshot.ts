import type { Channel } from '../types/channel.js';
import { resolvePtzSource, type AiSourceLink } from './ptzSources.js';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
interface Snapshot {
  schema_version: string;
  revision: string;
  rules: unknown[];
}
interface Source {
  snapshot(): Promise<Snapshot>;
}
/** Persistent view epochs reset spatial evidence even if no observation arrived
 * while the camera moved. Apply paused rules so old activities can be closed. */
export class PtzGuardedSnapshot {
  constructor(
    private source: Source,
    private pool: Pool,
    private links?: () => Promise<{ channels: Channel[]; ai: AiSourceLink[] }>,
  ) {}
  async snapshot(): Promise<Snapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = await this.source.snapshot();
      const { rows } = await this.pool.query(
        `SELECT revision::text,(SELECT COALESCE(jsonb_agg(jsonb_build_object('resource',resource_key,'epoch',revision::text,'blocked',blocked,'sources',source_ids,'restored',restored_at)),'[]'::jsonb) FROM ptz_view_guards WHERE blocked OR restored_at IS NOT NULL) AS guards FROM alarm_configuration_revision WHERE singleton`,
      );
      if (rows[0]?.revision !== s.revision) continue;
      const guardRows = rows[0].guards as any[];
      const legacy = s.rules.some((raw) => !(raw as any).input_stream_id);
      const processorGuards = new Map<string, Set<string>>();
      if (legacy && guardRows.length) {
        if (!this.links) throw Error('Legacy view protection requires source resolution');
        const { channels, ai } = await this.links();
        const known = new Set(channels.map((c) => c.id));
        const resolved = new Map<string, ReturnType<typeof resolvePtzSource>>();
        for (const g of guardRows) {
          const ids = new Set<string>();
          for (const source of g.sources) {
            if (!known.has(source)) continue;
            let graph = resolved.get(source);
            if (!graph) {
              graph = resolvePtzSource(source, channels, ai);
              resolved.set(source, graph);
            }
            for (const id of graph.processorIds) ids.add(id);
          }
          processorGuards.set(g.resource, ids);
        }
      }
      return {
        ...s,
        rules: s.rules.map((raw) => {
          const r = raw as Record<string, any>;
          const guards = guardRows.filter(
            (g) =>
              g.sources.includes(r.input_stream_id) ||
              (!r.input_stream_id &&
                (g.sources.includes(r.channel_id) ||
                  processorGuards.get(g.resource)?.has(r.channel_id))),
          );
          if (!guards.length) return r;
          const epoch = createHash('sha256')
            .update(
              guards
                .map((g) => `${g.resource}:${g.epoch}`)
                .sort()
                .join('|'),
            )
            .digest('hex');
          const restored = guards
            .map((g) => g.restored)
            .filter(Boolean)
            .sort()
            .at(-1);
          const sourceBinding =
            r.source_binding && restored
              ? {
                  ...r.source_binding,
                  not_before: new Date(
                    Math.max(Date.parse(r.source_binding.not_before), Date.parse(restored)),
                  ).toISOString(),
                }
              : r.source_binding;
          return {
            ...r,
            view_epoch: epoch,
            ...(restored ? { view_not_before: new Date(restored).toISOString() } : {}),
            ...(sourceBinding ? { source_binding: sourceBinding } : {}),
            ...(guards.some((g) => g.blocked) ? { state: 'paused' } : {}),
          };
        }),
      };
    }
    throw Error('View configuration changed while building rules');
  }
}
