import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { motionDigest, PtzMotionAdmission, type MotionSnapshot } from '../services/ptzMotionAdmission.js';
import { PtzGuardedSnapshot } from '../services/ptzGuardedSnapshot.js';
import { runMigrations } from '../store/migrator.js';
import { PhysicalPtzGuards } from '../store/physicalPtzGuards.js';
import { PtzStore } from '../store/ptzStore.js';

const onvif = 'onvif:hik-main', gb = 'gb28181:hik/1', other = 'onvif:other';
const groups = [[gb, onvif]];

it('uses only explicit runtime groups and rejects invalid or ambiguous membership', () => {
  try {
    vi.stubEnv('AINVR_PTZ_MOTOR_GROUPS', JSON.stringify(groups));
    const physical = new PhysicalPtzGuards();
    expect(physical.key(gb)).toBe(onvif);
    expect(physical.key(other)).toBe(other);
    expect(new PhysicalPtzGuards([]).key(gb)).toBe(gb);
    for (const invalid of [[[onvif]], [[gb, gb]], [...groups, [onvif, other]], [['bad', onvif]]])
      expect(() => new PhysicalPtzGuards(invalid)).toThrow();
  } finally { vi.unstubAllEnvs(); }
});

const port = process.env.AINVR_SCENE_PG_PORT;
async function isolated(run: (pool: Pool) => Promise<void>) {
  const config = { host: '127.0.0.1', port: Number(port), database: 'scene_test', user: 'postgres' };
  const schema = 'physical_guard_' + randomUUID().replaceAll('-', '');
  const admin = new Pool(config);
  const db = new Pool({ ...config, options: '-c search_path=' + schema });
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    try { await runMigrations(db); await run(db); }
    finally { await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); }
  } finally { await db.end(); await admin.end(); }
}

async function globalRevision(db: Pool) {
  return Number((await db.query('SELECT revision FROM alarm_configuration_revision WHERE singleton')).rows[0].revision);
}

it.skipIf(!port)('merges persisted rows once, invalidates old CAS and keeps unrelated guards and device presets', async () => {
  await isolated(async db => {
    const old = new PtzStore(db, []), store = new PtzStore(db, groups);
    await old.watch(onvif, ['raw-a', 'shared'], { pan: 0.3 });
    await old.block(gb, ['shared', 'raw-b'], 'operator');
    const aliasRevision = await old.block(gb, ['shared', 'raw-b'], 'operator');
    await old.watch(other, ['unrelated'], { pan: 0.5 });
    const unrelated = await old.guard(other);
    await db.query("INSERT INTO ptz_presets(resource_key,preset_id,name) VALUES($1,'32','saved')", [gb]);
    const before = await globalRevision(db);
    await store.reconcilePhysicalGuards();
    const merged = await store.guard(onvif);
    expect(merged).toMatchObject({ resource_key: onvif, revision: String(aliasRevision + 1),
      source_ids: ['raw-a', 'raw-b', 'shared'], blocked: true, stop_pending: true, baseline: null, restored_at: null });
    expect(await store.guard(gb)).toEqual(merged);
    expect(await globalRevision(db)).toBe(before + 1);
    expect(await old.guard(gb)).toBeNull();
    await store.stopped(gb, aliasRevision);
    expect((await store.guard(onvif)).stop_pending).toBe(true);
    await expect(store.restore(gb, Number(merged.revision), 'operator')).rejects.toThrow('version_conflict');
    await store.stopped(onvif, Number(merged.revision));
    await expect(store.restore(gb, aliasRevision, 'operator')).rejects.toThrow('version_conflict');
    const stable = await store.guard(onvif);
    await new PtzStore(db, groups).reconcilePhysicalGuards();
    expect(await store.guard(gb)).toEqual(stable);
    expect(await globalRevision(db)).toBe(before + 1);
    expect(await store.guard(other)).toEqual(unrelated);
    expect((await store.presets(gb)).map(p => p.id)).toEqual(['32']);
    expect(await store.presets(onvif)).toEqual([]);
  });
});

const earlier = '2026-11-21T09:29:53.673Z', latest = '2026-11-21T10:29:29.735Z';
it.skipIf(!port).each([
  {canonicalAt:earlier,aliasAt:latest}, {canonicalAt:latest,aliasAt:earlier}, {canonicalAt:null,aliasAt:latest},
])('retains the latest published counter boundary across merge and restart ($canonicalAt, $aliasAt)', async ({canonicalAt,aliasAt}) => {
  await isolated(async db => {
    const grouped = new PtzStore(db,groups);
    const seeds = [{key:gb,source:'raw-b',at:aliasAt}];
    if (canonicalAt) seeds.push({key:onvif,source:'raw-a',at:canonicalAt});
    for (const {key,source,at} of seeds) {
      await db.query(`INSERT INTO ptz_view_guards(resource_key,source_ids,blocked,baseline,restored_at,actor)
        VALUES($1,ARRAY[$2::text],true,'{"pan":1}'::jsonb,$3,'fixture')`,[key,source,at]);
    }
    const rules = seeds.map(({source})=>({id:'counter-'+source,input_stream_id:source,channel_id:'ai',
      state:'enabled',version:1,source_binding:{not_before:earlier}}));
    const snapshot = new PtzGuardedSnapshot({snapshot:async()=>({
      schema_version:'1.0',revision:String(await globalRevision(db)),rules,
    })},db);
    expect((await snapshot.snapshot()).rules).toMatchObject(seeds.map(({at})=>({
      state:'paused',view_not_before:at,source_binding:{not_before:at},
    })));
    await grouped.reconcilePhysicalGuards();
    expect(await grouped.guard(onvif)).toMatchObject({blocked:true,baseline:null,restored_at:new Date(latest)});
    const merged=await snapshot.snapshot();
    expect(merged.rules).toMatchObject(seeds.map(()=>({
      state:'paused',version:1,view_not_before:latest,source_binding:{not_before:latest},
    })));
    await new PtzStore(db,groups).reconcilePhysicalGuards();
    expect(await snapshot.snapshot()).toEqual(merged);
  });
});

it.skipIf(!port)('requires a new consumer ACK for merged sources even if the old ACK arrives late', async () => {
  await isolated(async db => {
    const old = new PtzStore(db, []), store = new PtzStore(db, groups);
    const admission = new PtzMotionAdmission(db);
    for (const [key, source] of [[onvif, 'cam-a'], [gb, 'cam-b'], [other, 'unrelated']])
      await old.block(key, [source], 'test');
    const rules = ['cam-a','cam-b','unrelated'].map(source =>
      ({ id: source, input_stream_id: source, channel_id: 'ai', state: 'paused' }));
    const snapshot = () => admission.snapshot({ snapshot: async () =>
      ({ schema_version: '1.0', revision: String(await globalRevision(db)), rules }) });
    const ack = (s: MotionSnapshot) => admission.acknowledge(s,
      { protocol: 1, scopes_digest: motionDigest(s.motion_admission!.scopes) });
    const states = async () => (await db.query(
      'SELECT source_id,installed,snapshot_revision::text FROM ptz_motion_scopes ORDER BY source_id',
    )).rows;

    const before = await snapshot();
    await ack(before);
    expect(await admission.ready(['cam-a','cam-b'], ['ai'])).toBe(true);
    await store.reconcilePhysicalGuards();
    const revision = String(await globalRevision(db));
    expect(revision).not.toBe(before.revision);
    const revoked = [
      { source_id: 'cam-a', installed: false, snapshot_revision: revision },
      { source_id: 'cam-b', installed: false, snapshot_revision: revision },
      { source_id: 'unrelated', installed: true, snapshot_revision: before.revision },
    ];
    await ack(before); // Delayed duplicate, before any new snapshot exists.
    expect(await states()).toEqual(revoked);
    const installations = async () => (await db.query(
      'SELECT resource_key,installed,snapshot_revision::text FROM ptz_motion_guard_installations ORDER BY resource_key',
    )).rows;
    expect(await installations()).toEqual([
      {resource_key:gb,installed:false,snapshot_revision:revision},
      {resource_key:onvif,installed:false,snapshot_revision:revision},
      {resource_key:other,installed:true,snapshot_revision:before.revision},
    ]);
    expect(await admission.ready(['cam-a','cam-b'], ['ai'])).toBe(false);
    const after = await snapshot();
    await ack(before);
    expect(await admission.ready(['cam-a','cam-b'], ['ai'])).toBe(false);
    await ack(after);
    expect((await installations()).map(r=>[r.resource_key,r.installed])).toEqual([[gb,false],[onvif,true],[other,true]]);
    await store.reconcilePhysicalGuards();
    expect(await states()).toEqual(revoked.map(row => ({ ...row, installed: true, snapshot_revision: revision })));
    expect(await admission.ready(['cam-a','cam-b'], ['ai'])).toBe(true);
  });
});

it.skipIf(!port)('moves a lone unblocked alias to a blocked epoch, and leaves a standalone resource independent', async () => {
  await isolated(async db => {
    const old = new PtzStore(db, []), store = new PtzStore(db, groups);
    await old.watch(gb, ['raw-b'], { pan: 0.3 });
    await old.watch(other, ['raw-b'], null);
    await old.reconcilePhysicalGuards();
    expect(await old.guard(onvif)).toBeNull();
    const unmapped = await old.guard(other);
    await store.reconcilePhysicalGuards();
    expect(await store.guard(onvif)).toMatchObject({ blocked: true, stop_pending: false,
      revision: '2', source_ids: ['raw-b'], baseline: null });
    expect(await store.guard(other)).toEqual(unmapped);
    expect(await old.guard(gb)).toBeNull();
  });
});

it.skipIf(!port)('serializes both protocols on one guard, retaining sources, stop fences and adapter-specific pose', async () => {
  await isolated(async db => {
    const store = new PtzStore(db, groups);
    const pose = { pan: 0.2 }, foreignPose = { pan: 240 };
    await store.watch(gb, ['video-b'], foreignPose);
    await store.observeBaseline(gb, 1, foreignPose);
    expect((await store.guard(onvif)).baseline).toBeNull();
    await store.observeBaseline(onvif, 1, pose);
    expect((await store.guard(onvif)).baseline).toEqual(pose);
    expect((await store.guard(gb)).baseline).toBeNull();
    const revisions = await Promise.all([store.block(onvif, ['video-a'], 'one', pose),
      store.block(gb, ['video-c', 'video-b'], 'two', foreignPose, false)]);
    const [older, latest] = revisions.sort((a,b) => a-b);
    expect(latest).toBe(older + 1);
    expect(await store.guard(gb)).toMatchObject({ blocked: true, stop_pending: true,
      source_ids: ['video-a','video-b','video-c'], revision: String(latest) });
    expect(await store.guards()).toHaveLength(1);
    await store.stopped(onvif, older);
    await expect(store.restore(gb, latest, 'actor')).rejects.toThrow('version_conflict');
    await store.stopped(gb, latest);
    await expect(store.restore(onvif, latest, 'actor', pose,
      async () => { throw Error('missing confirmation'); })).rejects.toThrow('missing confirmation');
    expect((await store.guard(gb)).blocked).toBe(true);
    await store.restore(gb, latest, 'actor', foreignPose);
    expect(await store.guard(onvif)).toMatchObject({ blocked: false, baseline: null, revision: String(latest + 1) });
    await store.observeBaseline(onvif, latest, pose);
    expect((await store.guard(onvif)).baseline).toBeNull();
  });
});

it.skipIf(!port)('selects current input IDs and streams only for enabled GB bindings in the explicit group',async()=>{
  await isolated(async db=>{
    const device='34020000001320000166',channel='34020000001320000001',input=randomUUID();
    const resource='gb28181:'+device+'/'+channel;
    await db.query("INSERT INTO gb28181_devices(device_id,name,profile,secret_ref) VALUES($1,'fixture','auto','fixture')",[device]);
    await db.query("INSERT INTO gb28181_catalog(device_id,channel_id,document) VALUES($1,$2,'{}')",[device,channel]);
    await db.query(`INSERT INTO gb28181_bindings(binding_id,device_id,channel_id,input_id,stream_name,transport)
      VALUES($1,$2,$3,$4,'new-stream','udp')`,[randomUUID(),device,channel,input]);
    const store=new PtzStore(db,[[resource,onvif]]);
    expect(await store.groupGbInputs([gb])).toEqual([]);
    expect(await store.groupGbInputs([resource])).toEqual([{input_id:input,stream_name:'new-stream',resource}]);
    await db.query('UPDATE gb28181_bindings SET enabled=false WHERE input_id=$1',[input]);
    expect(await store.groupGbInputs([resource])).toEqual([]);
  });
});

it.skipIf(!port)('keeps the canonical ONVIF pose through an unissued GB lease and refuses stale undo', async () => {
  await isolated(async db => {
    const store=new PtzStore(db,groups), pose={pan:0.3};
    await store.watch(onvif,['a'],pose);
    let revision=await store.block(gb,['b'],'operator',{pan:999});
    expect((await store.guard(onvif)).baseline).toEqual(pose);
    expect((await store.guard(gb)).baseline).toBeNull();
    await expect(store.restoreUnissued(gb,revision,'operator')).rejects.toThrow('version_conflict');
    await store.stopped(gb,revision);
    await store.restoreUnissued(gb,revision,'operator');
    expect(await store.guard(onvif)).toMatchObject({blocked:false,baseline:pose});
    expect((await store.guard(gb)).baseline).toBeNull();
    revision=await store.block(gb,['b'],'operator');
    const intervening=await store.block(onvif,['a'],'external');
    await store.stopped(onvif,intervening);
    await expect(store.restoreUnissued(gb,revision,'operator')).rejects.toThrow('version_conflict');
    expect(await store.guard(onvif)).toMatchObject({blocked:true,baseline:pose});
  });
});
