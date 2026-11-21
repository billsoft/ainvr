import type { Channel } from '../types/channel.js';
import { resolvePtzSource, type AiSourceLink } from './ptzSources.js';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type {ArmingScenes,SceneRow} from '../store/armingScenes.js';
interface Snapshot {
  schema_version: string;
  revision: string;
  rules: unknown[];
}
interface ZoneKey {
  source_id: string;
  processor_id: string;
  zone_id: string;
}
interface DeletedBinding extends ZoneKey {
  id: string;
  recorded_at: Date;
}
const zoneKey = (source: string, processor: string, zone: string) =>
  JSON.stringify([source, processor, zone]);
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
    private scenes?:ArmingScenes,
    private checkBindings?:()=>Promise<void>,
  ) {}
  async snapshot(): Promise<Snapshot> {
    await this.scenes?.invalidate(false);
    await this.checkBindings?.();
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = await this.source.snapshot();
      const bindings=this.scenes?(await this.pool.query<SceneRow>(
        'SELECT * FROM arming_scene_zones')).rows:[];
      const byZone = new Map(bindings.map(r => [zoneKey(r.source_id, r.processor_id, r.zone_id), r]));
      const unbound = new Map<string, ZoneKey>();
      if (this.scenes) {
        for (const raw of s.rules) {
          const { input_stream_id, channel_id, zone_id } = raw as Record<string, string>;
          if (!input_stream_id || !channel_id || !zone_id) continue;
          const key = zoneKey(input_stream_id, channel_id, zone_id);
          if (!byZone.has(key)) unbound.set(key, { source_id: input_stream_id, processor_id: channel_id, zone_id });
        }
      }
      // Each distinct unbound key probes the scene journal's (source, processor, zone, time) index.
      const deletes = unbound.size ? (await this.pool.query<DeletedBinding>(
        `SELECT k.source_id,k.processor_id,k.zone_id,h.id::text AS id,h.recorded_at
         FROM jsonb_to_recordset($1::jsonb) AS k(source_id text,processor_id text,zone_id text)
         CROSS JOIN LATERAL (
           SELECT id,recorded_at FROM arming_scene_history
           WHERE source_id=k.source_id AND processor_id=k.processor_id AND zone_id=k.zone_id
             AND operation='DELETE'
           ORDER BY recorded_at DESC,id DESC LIMIT 1
         ) h`, [JSON.stringify([...unbound.values()])])).rows : [];
      const byDeletedZone = new Map(deletes.map(d => [zoneKey(d.source_id, d.processor_id, d.zone_id), d]));
      const { rows } = await this.pool.query(
        `SELECT revision::text,(SELECT COALESCE(jsonb_agg(jsonb_build_object('resource',resource_key,'epoch',revision::text,'blocked',blocked,'sources',source_ids,'restored',restored_at,'changed',changed_at)),'[]'::jsonb) FROM ptz_view_guards WHERE blocked OR restored_at IS NOT NULL) AS guards FROM alarm_configuration_revision WHERE singleton`,
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
          const key = zoneKey(r.input_stream_id, r.channel_id, r.zone_id);
          const scene = byZone.get(key);
          const deleted = byDeletedZone.get(key);
          if (!guards.length && !scene && !deleted) return r;
          const epoch = createHash('sha256')
            .update(
              guards
                .map((g) => `${g.resource}:${g.epoch}`)
                .sort()
                .join('|'),
            )
            .digest('hex');
          if(scene){
            const ok=scene.binding_mode==='preset' && scene.state==='matched' && scene.epoch===epoch && !!scene.current_points &&
              scene.geometry_revision===r.geometry_revision && scene.zone_version===r.zone_version &&
              !guards.some(g=>g.blocked&&g.resource!==scene.resource);
            const boundary=new Date(Math.max(scene.changed_at.getTime(),...guards.map(g=>Date.parse(g.restored)||0))).toISOString();
            const notBefore=new Date(Math.max(Date.parse(r.source_binding?.not_before)||0,Date.parse(boundary))).toISOString();
            return {...r,...(ok?{points:scene.current_points}:{state:'paused'}),view_epoch:createHash('sha256')
              .update(epoch+':'+scene.revision).digest('hex'),view_not_before:boundary,
              ...(r.source_binding?{source_binding:{...r.source_binding,not_before:notBefore}}:{})};
          }
          // Unbinding restores authored coordinates under a new, durable evidence boundary.
          const restored = deleted ? new Date(Math.max(
            deleted.recorded_at.getTime(),
            Date.parse(r.view_not_before) || 0,
            ...guards.map(g => Math.max(Date.parse(g.changed) || 0, Date.parse(g.restored) || 0)),
          )).toISOString() : guards
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
            view_epoch: deleted ? createHash('sha256').update(epoch + ':delete:' + deleted.id).digest('hex') : epoch,
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
