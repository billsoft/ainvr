import type { Pool } from 'pg';
import { z } from 'zod';
export const ptzSettingsSchema = z
  .object({
    enabled: z.boolean(),
    capacity: z.number().int().min(1).max(16),
    leaseMs: z.number().int().min(500).max(1500),
  })
  .strict();
export const ptzCameraSchema = z
  .object({
    enabled: z.boolean().default(true),
    panTilt: z.boolean().nullable().default(null),
    zoom: z.boolean().nullable().default(null),
    presets: z.boolean().nullable().default(null),
  })
  .strict();
export const ptzCameraDraftSchema = z
  .object({ settings: ptzCameraSchema, expectedRevision: z.number().int().nonnegative() })
  .strict();
export type PtzCameraDraft = z.infer<typeof ptzCameraDraftSchema>;
export type PtzSettings = z.infer<typeof ptzSettingsSchema>;
export class PtzError extends Error {
  constructor(
    public code: string,
    public statusCode = 409,
  ) {
    super(code);
  }
}
export class PtzStore {
  constructor(public pool: Pool) {}
  async settings() {
    const { rows } = await this.pool.query(
      'SELECT revision,document FROM ptz_settings WHERE singleton',
    );
    if (!rows[0]) throw new PtzError('ptz_configuration_unavailable', 503);
    return {
      revision: Number(rows[0].revision),
      settings: ptzSettingsSchema.parse(rows[0].document),
    };
  }
  async saveSettings(input: unknown, expected: number, actor: string) {
    const settings = ptzSettingsSchema.parse(input);
    return this.transaction(async (c) => {
      const r = await c.query(
        'UPDATE ptz_settings SET revision=revision+1,document=$1 WHERE singleton AND revision=$2 RETURNING revision',
        [settings, expected],
      );
      if (!r.rows.length) throw new PtzError('version_conflict');
      await this.audit(c, actor, 'ptz-settings');
      return { revision: Number(r.rows[0].revision), settings };
    });
  }
  async camera(source: string, identity: string) {
    const { rows } = await this.pool.query(
      'SELECT revision,identity,document FROM ptz_camera_settings WHERE source_id=$1',
      [source],
    );
    return rows[0]?.identity === identity
      ? { revision: Number(rows[0].revision), settings: ptzCameraSchema.parse(rows[0].document) }
      : { revision: 0, settings: ptzCameraSchema.parse({}) };
  }
  async saveCamera(
    source: string,
    identity: string,
    input: unknown,
    expected: number,
    actor: string,
  ) {
    return this.transaction((c) =>
      this.writeCamera(
        c,
        source,
        identity,
        { settings: ptzCameraSchema.parse(input), expectedRevision: expected },
        actor,
      ),
    );
  }
  async writeCamera(
    c: import('pg').PoolClient,
    source: string,
    identity: string,
    draft: PtzCameraDraft,
    actor: string,
  ) {
    const { settings, expectedRevision: expected } = ptzCameraDraftSchema.parse(draft);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ptz-camera:${source}`]);
    const old = (
      await c.query(
        'SELECT identity,revision FROM ptz_camera_settings WHERE source_id=$1 FOR UPDATE',
        [source],
      )
    ).rows[0];
    if ((old?.identity === identity ? Number(old.revision) : 0) !== expected)
      throw new PtzError('version_conflict');
    await c.query(
      'INSERT INTO ptz_camera_settings(source_id,identity,revision,document) VALUES($1,$2,$3,$4) ON CONFLICT(source_id) DO UPDATE SET identity=$2,revision=$3,document=$4,updated_at=now()',
      [source, identity, expected + 1, settings],
    );
    await this.audit(c, actor, 'ptz-camera');
    return { revision: expected + 1, settings };
  }
  // Channel metadata currently lives in a JSON store. Hold the camera revision
  // lock through its save; rollback PG preferences when channel validation fails.
  // A COMMIT transport failure after the channel save is explicitly partial.
  async withCamera<T>(
    source: string,
    identity: string,
    draft: PtzCameraDraft,
    actor: string,
    action: () => Promise<T>,
  ) {
    const c = await this.pool.connect();
    let result: T | undefined;
    try {
      await c.query('BEGIN');
      await this.writeCamera(c, source, identity, draft, actor);
      result = await action();
      await c.query('COMMIT');
      return { result, ptzApplication: { state: 'applied' as const } };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      if (result !== undefined)
        return {
          result,
          ptzApplication: {
            state: 'failed' as const,
            error: 'ptz_channel_saved_preferences_unconfirmed',
          },
        };
      throw e;
    } finally {
      c.release();
    }
  }
  async guards() {
    return (
      await this.pool.query(
        'SELECT resource_key,blocked,stop_pending,source_ids,baseline,revision,changed_at,actor FROM ptz_view_guards ORDER BY changed_at DESC LIMIT 1024',
      )
    ).rows;
  }
  async watch(resource: string, sources: string[], baseline: unknown) {
    await this.pool.query(
      `INSERT INTO ptz_view_guards(resource_key,source_ids,baseline,blocked,actor) VALUES($1,$2,$3,false,'ptz-observer') ON CONFLICT(resource_key) DO NOTHING`,
      [resource, sources, baseline],
    );
  }
  async guard(resource: string) {
    return (
      (
        await this.pool.query(
          'SELECT resource_key,revision,blocked,stop_pending,source_ids,baseline,changed_at,restored_at FROM ptz_view_guards WHERE resource_key=$1',
          [resource],
        )
      ).rows[0] ?? null
    );
  }
  async block(
    resource: string,
    sources: string[],
    actor: string,
    baseline: unknown = null,
    needsStop = true,
  ) {
    return this.transaction(async (c) => {
      await c.query('SELECT revision FROM alarm_configuration_revision WHERE singleton FOR UPDATE');
      const result = await c.query(
        `INSERT INTO ptz_view_guards(resource_key,source_ids,actor,baseline,stop_pending) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(resource_key) DO UPDATE SET blocked=true,source_ids=EXCLUDED.source_ids,
   revision=ptz_view_guards.revision+1,changed_at=now(),actor=$3,stop_pending=ptz_view_guards.stop_pending OR $5,
   baseline=CASE WHEN ptz_view_guards.blocked THEN ptz_view_guards.baseline ELSE $4 END RETURNING revision`,
        [resource, [...new Set(sources)], actor, baseline, needsStop],
      );
      await c.query('UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton');
      await this.audit(c, actor, 'ptz-view-block');
      return Number(result.rows[0].revision);
    });
  }
  async stopped(resource: string, revision: number) {
    await this.pool.query(
      'UPDATE ptz_view_guards SET stop_pending=false WHERE resource_key=$1 AND revision=$2',
      [resource, revision],
    );
  }
  async observeBaseline(resource: string, revision: number, baseline: unknown) {
    await this.pool.query(
      'UPDATE ptz_view_guards SET baseline=$3 WHERE resource_key=$1 AND revision=$2 AND NOT blocked AND baseline IS NULL',
      [resource, revision, baseline],
    );
  }
  async restore(resource: string, expected: number, actor: string, baseline: unknown = null) {
    return this.transaction(async (c) => {
      await c.query('SELECT revision FROM alarm_configuration_revision WHERE singleton FOR UPDATE');
      const result = await c.query(
        'UPDATE ptz_view_guards SET blocked=false,revision=revision+1,restored_at=now(),actor=$3,baseline=$4 WHERE resource_key=$1 AND revision=$2 AND NOT stop_pending RETURNING resource_key',
        [resource, expected, actor, baseline],
      );
      if (!result.rows.length) throw new PtzError('version_conflict');
      await c.query('UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton');
      await this.audit(c, actor, 'ptz-view-restore');
    });
  }
  async presets(resource: string) {
    return (
      await this.pool.query(
        'SELECT preset_id AS id,name,shortcut,position,device_state AS "deviceState" FROM ptz_presets WHERE resource_key=$1 ORDER BY shortcut NULLS LAST,name,preset_id',
        [resource],
      )
    ).rows;
  }
  async savePreset(
    resource: string,
    id: string,
    name: string,
    shortcut: number | null,
    position: unknown,
    actor: string,
  ) {
    return this.transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `ptz-preset:${resource}`,
      ]);
      const count = Number(
        (await c.query('SELECT count(*) n FROM ptz_presets WHERE resource_key=$1', [resource]))
          .rows[0].n,
      );
      if (
        count >= 255 &&
        !(
          await c.query('SELECT 1 FROM ptz_presets WHERE resource_key=$1 AND preset_id=$2', [
            resource,
            id,
          ])
        ).rows.length
      )
        throw new PtzError('ptz_preset_capacity');
      await c.query(
        `INSERT INTO ptz_presets(resource_key,preset_id,name,shortcut,position) VALUES($1,$2,$3,$4,$5) ON CONFLICT(resource_key,preset_id) DO UPDATE SET name=$3,shortcut=$4,position=$5,updated_at=now()`,
        [resource, id, name, shortcut, position],
      );
      await this.audit(c, actor, 'ptz-preset-save');
    });
  }
  async removePreset(resource: string, id: string, actor: string) {
    await this.transaction(async (c) => {
      await c.query('DELETE FROM ptz_presets WHERE resource_key=$1 AND preset_id=$2', [
        resource,
        id,
      ]);
      await this.audit(c, actor, 'ptz-preset-remove');
    });
  }
  async record(actor: string, action: string) {
    await this.audit(this.pool, actor, action);
  }
  private async audit(c: Pick<Pool, 'query'>, actor: string, action: string) {
    await c.query("INSERT INTO config_audit_logs(actor,action,service) VALUES($1,$2,'backend')", [
      actor,
      action,
    ]);
  }
  private async transaction<T>(fn: (c: import('pg').PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}
