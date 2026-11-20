import { it, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtzStore } from '../store/ptzStore.js';
import { PgConfigStore } from '../store/pgStore.js';
import { GB28181Store } from '../store/gb28181Store.js';
import { PtzGuardedSnapshot } from '../services/ptzGuardedSnapshot.js';
import { runMigrations } from '../store/migrator.js';
const enabled = process.env.AINVR_PTZ_TEST_PG === '1';
it.skipIf(!enabled)('serializes calibration saves, version checks and shared motor epoch invalidations in PG', async () =>
  isolated(async store => {
    const motor = 'shared', scope = 'gb-view', other = 'onvif-view';
    const snapshot = {version:1 as const, records:[{axis:'pan' as const,sign:-1 as const,
      speed:0.2,durationMs:150,displacement:0.15,at:123}]};
    expect(await store.calibration(motor,scope)).toEqual({epoch:0,revision:0,snapshot:null});
    const save = (revision:number) => store.saveCalibration(motor,scope,0,revision,snapshot);
    for (const revision of [0,1]) {
      const results = await Promise.allSettled([save(revision),save(revision)]);
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    }
    expect(await new PtzStore(store.pool).calibration(motor,scope)).toEqual({epoch:0,revision:2,snapshot});
    await store.saveCalibration(motor,other,0,0,snapshot);
    await store.saveCalibration('separate',other,0,0,snapshot);
    await Promise.allSettled([store.invalidateCalibration(motor),save(2)]);
    for (const key of [scope,other]) {
      expect(await store.calibration(motor,key)).toEqual({epoch:1,revision:0,snapshot:null});
      await expect(store.saveCalibration(motor,key,0,0,snapshot)).rejects.toThrow('ptz_calibration_stale');
    }
    expect(await store.calibration('separate',other)).toEqual({epoch:0,revision:1,snapshot});
    expect(await store.saveCalibration(motor,scope,1,0,snapshot)).toEqual({revision:1});
  }));
async function isolated(run: (store: PtzStore, pg: PgConfigStore) => Promise<void>) {
  const schema = 'ptz_' + randomUUID().replaceAll('-', ''),
    connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
  const admin = new Pool(connection),
    dir = mkdtempSync(join(tmpdir(), 'ainvr-ptz-pg-'));
  const key = join(dir, 'key');
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pg = new PgConfigStore({
    poolConfig: { ...connection, options: `-c search_path=${schema}` },
    masterKeyPath: key,
  });
  try {
    await runMigrations(pg.pool);
    await run(new PtzStore(pg.pool), pg);
  } finally {
    await pg.pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  }
}
it.skipIf(!enabled)(
  'camera preferences reject concurrent edits and failed channel saves roll back',
  async () =>
    isolated(async (store) => {
      const settings = { enabled: true, panTilt: null, zoom: null, presets: null },
        key = 'onvif:device/sensor';
      const results = await Promise.allSettled([
        store.saveCamera(key, key, settings, 0, 'one'),
        store.saveCamera(key, key, { ...settings, zoom: false }, 0, 'two'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const before = await store.camera(key, key);
      await expect(
        store.withCamera(
          key,
          key,
          { settings: { ...settings, enabled: false }, expectedRevision: before.revision },
          'operator',
          async () => {
            throw Error('channel rejected');
          },
        ),
      ).rejects.toThrow('channel rejected');
      expect(await store.camera(key, key)).toEqual(before);
      const committed = await store.withCamera(
        key,
        key,
        { settings, expectedRevision: before.revision },
        'operator',
        async () => ({ id: 'channel' }),
      );
      expect(committed.ptzApplication.state).toBe('applied');
      expect((await store.camera(key, key)).revision).toBe(before.revision + 1);
    }),
);
it.skipIf(!enabled)(
  'view guards persist across manager restart and old Stop cannot clear a newer intent',
  async () =>
    isolated(async (store, pg) => {
      const before = Number(
        (await pg.pool.query('SELECT revision FROM alarm_configuration_revision')).rows[0].revision,
      );
      const baseline = { position: { Pan: 1, Tilt: 2, Zoom: 3 } };
      await store.watch('motor', ['raw', 'ai'], baseline);
      expect(
        Number(
          (await pg.pool.query('SELECT revision FROM alarm_configuration_revision')).rows[0]
            .revision,
        ),
      ).toBe(before);
      const snap = new PtzGuardedSnapshot(
        {
          snapshot: async () => ({
            schema_version: '1.0',
            revision: String(
              (await pg.pool.query('SELECT revision FROM alarm_configuration_revision')).rows[0]
                .revision,
            ),
            rules: [{ id: 'rule', input_stream_id: 'raw', state: 'enabled' }],
          }),
        },
        pg.pool,
      );
      expect((await snap.snapshot()).rules[0]).not.toHaveProperty('view_epoch');
      const first = await store.block('motor', ['raw', 'ai'], 'operator', baseline);
      const second = await store.block('motor', ['raw', 'ai'], 'operator');
      await store.stopped('motor', first);
      expect((await new PtzStore(pg.pool).guard('motor')).stop_pending).toBe(true);
      expect((await snap.snapshot()).rules[0]).toMatchObject({ state: 'paused' });
      await store.stopped('motor', second);
      expect((await store.guard('motor')).baseline).toEqual(baseline);
      await expect(store.restore('motor', first, 'operator')).rejects.toThrow('version_conflict');
      await store.restore('motor', second, 'operator');
      expect((await store.guard('motor')).blocked).toBe(false);
      expect((await snap.snapshot()).rules[0]).toMatchObject({
        state: 'enabled',
        view_epoch: expect.any(String),
      });
    }),
);
it.skipIf(!enabled)(
  'preset aliases and native identifiers survive restart with unique shortcuts',
  async () =>
    isolated(async (store, pg) => {
      await store.savePreset('motor', 'native-7', '前门', 1, { zoom: 0.5 }, 'operator');
      const after = new PtzStore(pg.pool);
      expect(await after.presets('motor')).toEqual([
        expect.objectContaining({ id: 'native-7', name: '前门', shortcut: 1 }),
      ]);
      await expect(
        after.savePreset('motor', 'native-8', '后门', 1, null, 'operator'),
      ).rejects.toThrow();
      expect(await after.presets('motor')).toHaveLength(1);
      await after.removePreset('motor', 'native-7', 'operator');
      expect(await after.presets('motor')).toEqual([]);
    }),
);
it.skipIf(!enabled)('metadata edits preserve positions and serialize shortcut claims across physical aliases', async () =>
  isolated(async (store, pg) => {
    const group = ['gb28181:device/channel','onvif:motor'];
    const [gb, onvif] = group as [string,string];
    const position = {zoom:0.25};
    await store.savePreset(gb,'7','old',1,position,'operator',group);
    await store.updatePresetMetadata(gb,'7','new',null,'operator',group);
    expect(await store.presets(gb)).toEqual([expect.objectContaining({id:'7',name:'new',shortcut:null,position,deviceState:'delivery_accepted'})]);
    // Separate connections model workers receiving different orderings. An
    // external holder makes a mismatched lock key fail deterministically.
    const reversed = [onvif, gb, onvif];
    const holder = await pg.pool.connect();
    const contender = new Pool({...pg.pool.options, options: pg.pool.options.options + ' -c lock_timeout=400ms'});
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['ptz-preset:' + gb]);
      await expect(new PtzStore(contender).updatePresetMetadata(onvif,'7','alias',2,'operator',reversed))
        .rejects.toMatchObject({code:'55P03'});
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await contender.end();
    }
    const edits = await Promise.allSettled([
      store.updatePresetMetadata(gb,'7','alias',2,'operator',group),
      store.updatePresetMetadata(onvif,'7','alias',2,'operator',reversed),
    ]);
    expect(edits.filter(r => r.status==='fulfilled')).toHaveLength(1);
    expect(edits.find(r => r.status==='rejected')).toMatchObject({reason:{code:'ptz_shortcut_in_use'}});
    await store.updatePresetMetadata(onvif,'camera-token','display name',3,'operator',group);
    expect(await store.presets(onvif)).toContainEqual(expect.objectContaining({id:'camera-token',position:null,deviceState:'device_reported'}));
    expect((await pg.pool.query("SELECT count(*)::int AS n FROM config_audit_logs WHERE action='ptz-preset-metadata'")).rows[0].n).toBe(3);
  }),
);
it.skipIf(!enabled)('GB batch camera preferences and input mappings save atomically', async () =>
  isolated(async (store, pg) => {
    const gb = new GB28181Store(pg),
      device = '34020000001320000001',
      channel = '34020000001320000002';
    await gb.saveDevice(
      {
        id: device,
        name: 'NVR',
        version: '2022',
        enabled: true,
        mediaIPs: ['192.0.2.10'],
        password: 'fixture-password',
      },
      1,
      'test',
    );
    await pg.pool.query(
      'INSERT INTO gb28181_catalog(device_id,channel_id,document,available) VALUES($1,$2,$3,true)',
      [device, channel, { DeviceID: channel, Name: 'Gate' }],
    );
    const key = `gb28181:${device}/${channel}`,
      input = {
        deviceId: device,
        channelId: channel,
        transport: 'udp',
        enabled: false,
        config: { name: 'Gate', description: '', protocols: ['flv'], primary: 'flv' },
        ptz: {
          settings: { enabled: true, panTilt: true, zoom: true, presets: true },
          expectedRevision: 0,
        },
      };
    const revision = (await gb.readSettings()).revision;
    await store.saveCamera(key, key, { enabled: true }, 0, 'other');
    await expect(gb.saveChannel(input, revision, 'test')).rejects.toThrow('version_conflict');
    expect((await pg.pool.query('SELECT * FROM gb28181_bindings')).rows).toHaveLength(0);
    expect((await gb.readSettings()).revision).toBe(revision);
    input.ptz.expectedRevision = 1;
    await gb.saveChannel(input, revision, 'test');
    expect((await store.camera(key, key)).settings.zoom).toBe(true);
    expect((await pg.pool.query('SELECT * FROM gb28181_bindings')).rows).toHaveLength(1);
  }),
);
