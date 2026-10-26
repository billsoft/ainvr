import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { PgConfigStore } from './pgStore.js';

export class OnvifError extends Error {
  constructor(
    public code: string,
    public statusCode = 400,
  ) {
    super(code);
  }
}
const address = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash;
  }, '请输入 HTTP(S) 设备服务地址');
const cidr = z.string().refine((value) => {
  const [ip, bits, ...extra] = value.split('/');
  return (
    !extra.length &&
    !!isIP(ip!) &&
    bits !== undefined &&
    /^\d+$/.test(bits) &&
    Number(bits) >= 0 &&
    Number(bits) <= (isIP(ip!) === 4 ? 32 : 128)
  );
}, '网段格式无效');
export const onvifSettingsSchema = z
  .object({
    enabled: z.boolean(),
    serviceUrl: address,
    allowedCIDRs: z.array(cidr).max(32),
    interfaces: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,32}$/)).max(16),
    timeoutSeconds: z.number().int().min(1).max(15),
  })
  .strict()
  .refine((v) => !v.enabled || v.allowedCIDRs.length > 0, '启用前请选择允许访问的摄像头网段');
export const defaultOnvifSettings = {
  enabled: false,
  serviceUrl: 'http://127.0.0.1:8150',
  allowedCIDRs: [] as string[],
  interfaces: [] as string[],
  timeoutSeconds: 5,
};
export const deviceSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(100),
    url: address,
    username: z.string().max(128),
    password: z.string().max(256).optional(),
    certificateSHA256: z
      .string()
      .regex(/^([a-fA-F0-9]{64})?$/)
      .default(''),
    epr: z.string().max(300).optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();
export type OnvifSettings = z.infer<typeof onvifSettingsSchema>;
export type OnvifDevice = z.infer<typeof deviceSchema>;
export class OnvifStore {
  constructor(public pg: PgConfigStore) {}
  async settings() {
    const row = (
      await this.pg.pool.query('SELECT revision,document FROM onvif_settings WHERE singleton')
    ).rows[0];
    if (!row) throw new OnvifError('configuration_unavailable', 503);
    return {
      revision: Number(row.revision),
      settings: onvifSettingsSchema.parse({ ...defaultOnvifSettings, ...row.document }),
      tokenSet: await this.pg.hasSecret('onvif/service-token'),
    };
  }
  async saveSettings(
    input: OnvifSettings,
    expectedRevision: number,
    token: string | undefined,
    actor: string,
  ) {
    const settings = onvifSettingsSchema.parse(input);
    if (token !== undefined && (token.length < 32 || token.length > 512))
      throw new OnvifError('invalid_service_token');
    return this.transaction(async (c) => {
      const old = (await c.query('SELECT revision FROM onvif_settings WHERE singleton FOR UPDATE'))
        .rows[0];
      if (Number(old?.revision) !== expectedRevision) throw new OnvifError('version_conflict', 409);
      if (token) await this.secret(c, 'onvif/service-token', token);
      if (settings.enabled && !token && !(await this.pg.hasSecret('onvif/service-token')))
        throw new OnvifError('service_credential_missing');
      await c.query(
        'UPDATE onvif_settings SET revision=revision+1,document=$1,updated_at=now() WHERE singleton',
        [settings],
      );
      await this.audit(c, actor, 'onvif-settings', expectedRevision, expectedRevision + 1);
      return { revision: expectedRevision + 1 };
    });
  }
  async devices() {
    return (
      await this.pg.pool.query(
        'SELECT device_id AS id,name,service_url AS url,username,certificate_sha256 AS "certificateSHA256",epr,version,capabilities->>\'model\' AS model,last_probe_at AS "lastProbeAt",last_error AS "lastError",true AS "credentialSet" FROM onvif_devices ORDER BY name,device_id',
      )
    ).rows;
  }
  async publicDevice(id: string) {
    const row = (
      await this.pg.pool.query(
        'SELECT device_id AS id,name,service_url AS url,username,certificate_sha256 AS "certificateSHA256",epr,version,capabilities,last_probe_at AS "lastProbeAt",last_error AS "lastError",true AS "credentialSet" FROM onvif_devices WHERE device_id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new OnvifError('device_not_found', 404);
    return row;
  }
  async device(id: string) {
    const d = (await this.pg.pool.query('SELECT * FROM onvif_devices WHERE device_id=$1', [id]))
      .rows[0];
    if (!d) throw new OnvifError('device_not_found', 404);
    const password = await this.pg.getSecret(d.secret_ref);
    if (password === null || password === undefined)
      throw new OnvifError('device_credential_missing', 503);
    return {
      record: d,
      device: {
        url: d.service_url,
        username: d.username,
        password,
        certificateSHA256: d.certificate_sha256,
      },
    };
  }
  async saveDevice(input: OnvifDevice, actor: string) {
    const d = deviceSchema.parse(input),
      id = d.id ?? randomUUID();
    return this.transaction(async (c) => {
      await c.query('SELECT revision FROM onvif_settings WHERE singleton FOR UPDATE');
      const old = (
        await c.query('SELECT version FROM onvif_devices WHERE device_id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (old && Number(old.version) !== d.expectedVersion)
        throw new OnvifError('version_conflict', 409);
      if (!old && d.expectedVersion) throw new OnvifError('device_not_found', 404);
      if (!old && d.password === undefined) throw new OnvifError('device_credential_missing');
      if (!old) {
        const count = Number((await c.query('SELECT count(*) AS n FROM onvif_devices')).rows[0].n);
        if (count >= 1024) throw new OnvifError('device_capacity_exceeded', 409);
      }
      const key = `onvif/device/${id}`;
      if (d.password !== undefined) await this.secret(c, key, d.password);
      await c.query(
        `INSERT INTO onvif_devices(device_id,name,service_url,username,secret_ref,certificate_sha256,epr) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(device_id) DO UPDATE SET name=EXCLUDED.name,service_url=EXCLUDED.service_url,username=EXCLUDED.username,certificate_sha256=EXCLUDED.certificate_sha256,epr=EXCLUDED.epr,version=onvif_devices.version+1,capabilities=NULL,last_error=NULL,updated_at=now()`,
        [id, d.name, d.url, d.username, key, d.certificateSHA256, d.epr ?? null],
      );
      await this.audit(
        c,
        actor,
        'onvif-device-save',
        Number(old?.version ?? 0),
        Number(old?.version ?? 0) + 1,
      );
      return { id, version: Number(old?.version ?? 0) + 1 };
    });
  }
  async recordProbe(id: string, version: number, capabilities: unknown, error: string | null) {
    await this.pg.pool.query(
      'UPDATE onvif_devices SET capabilities=COALESCE($3,capabilities),last_error=$4,last_probe_at=now() WHERE device_id=$1 AND version=$2',
      [id, version, capabilities, error],
    );
  }
  private async secret(c: PoolClient, key: string, value: string) {
    await c.query(
      'INSERT INTO config_secrets(key_path,ciphertext) VALUES($1,$2) ON CONFLICT(key_path) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,updated_at=now()',
      [key, this.pg.encryptSecret(value)],
    );
  }
  private async audit(c: PoolClient, actor: string, action: string, before: number, after: number) {
    await c.query(
      "INSERT INTO config_audit_logs(actor,action,service,version_before,version_after) VALUES($1,$2,'onvif',$3,$4)",
      [actor, action, before, after],
    );
  }
  private async transaction<T>(work: (c: PoolClient) => Promise<T>) {
    const c = await this.pg.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      if ((e as any).code === '23505' && (e as any).constraint === 'onvif_device_epr')
        throw new OnvifError('device_already_configured', 409);
      throw e;
    } finally {
      c.release();
    }
  }
}
