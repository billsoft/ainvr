import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {runMigrations} from '../store/migrator.js';
import {PtzStore} from '../store/ptzStore.js';
import {PtzMotionAdmission,motionDigest,type MotionSnapshot} from '../services/ptzMotionAdmission.js';
import {ptzMotionRoutes} from '../routes/ptzMotionRoutes.js';

const enabled=!!process.env.AINVR_SCENE_PG_PORT;
let admin:Pool,db:Pool,gate:PtzMotionAdmission,ptz:PtzStore;
const schema='motion_'+randomUUID().replaceAll('-','');
beforeAll(async()=>{
 if(!enabled)return;
 const cfg={host:'127.0.0.1',port:Number(process.env.AINVR_SCENE_PG_PORT),user:'postgres',database:'scene_test'};
 admin=new Pool(cfg);await admin.query('CREATE SCHEMA '+schema);
 db=new Pool({...cfg,options:'-c search_path='+schema,max:4});await runMigrations(db);
 gate=new PtzMotionAdmission(db);ptz=new PtzStore(db);
});
beforeEach(async()=>{
 if(!enabled)return;
 await db.query('TRUNCATE ptz_motion_scopes,ptz_motion_guard_installations,ptz_view_guards');
 await ptz.block('motor',['cam'],'test',null,false);
});
afterAll(async()=>{if(enabled){await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}});
const raw=[{id:'rule',input_stream_id:'cam',channel_id:'ai',state:'enabled',points:[[0,0],[1,0],[1,1]]}];
async function publish(rules=raw){
 const s=await gate.snapshot({snapshot:async()=>({schema_version:'1.0',revision:(await db.query('SELECT revision::text FROM alarm_configuration_revision')).rows[0].revision,rules})});
 await gate.acknowledge(s,{protocol:1,scopes_digest:motionDigest(s.motion_admission!.scopes)});return s;
}
function request(s:MotionSnapshot){const scope=s.motion_admission!.scopes[0];return {protocol:1,producer_id:'producer',offset:'1',frame_digest:'f'.repeat(64),channel_id:'ai',input_stream_id:'cam',stream_session_id:'session',source_frame_index:'1',captured_at:new Date().toISOString(),guard_epoch:scope.guard_epoch,execution_digest:scope.execution_digest};}
it.skipIf(!enabled)('registers scopes, fences before installation, then grants only the exact rule/frame identity',async()=>{
 const s=await gate.snapshot({snapshot:async()=>({schema_version:'1.0',revision:(await db.query('SELECT revision::text FROM alarm_configuration_revision')).rows[0].revision,rules:raw})});
 expect((await gate.admit(request(s))).decision).toBe('retry');
 await gate.acknowledge(s,{protocol:1,scopes_digest:'0'.repeat(64)});
 expect((await gate.admit(request(s))).decision).toBe('retry');
 await gate.acknowledge(s,{protocol:1,scopes_digest:motionDigest(s.motion_admission!.scopes)});
 expect(await gate.admit(request(s))).toMatchObject({decision:'permit',permit:{frame_digest:'f'.repeat(64),producer_id:'producer',offset:'1'}});
 expect((await gate.admit({...request(s),execution_digest:'a'.repeat(64)})).decision).toBe('retry');
 expect((await gate.admit({...request(s),channel_id:'other'})).decision).toBe('retry');
});
it.skipIf(!enabled)('rejects the old scope immediately after motion without waiting for alarm publication',async()=>{
 const s=await publish();await ptz.block('motor',['cam'],'move');
 expect((await gate.admit(request(s))).decision).toBe('retry');
 const current=await publish();
 expect((await gate.admit(request(current))).decision).toBe('retry');
});
it.skipIf(!enabled)('keeps stopped but paused rules ineligible and permits only a fresh enabled publication',async()=>{
 const paused=await publish(raw.map(r=>({...r,state:'paused'})));
 expect((await gate.admit(request(paused))).decision).toBe('retry');
 const enabled=await publish();expect((await gate.admit(request(enabled))).decision).toBe('permit');
});
it.skipIf(!enabled)('serializes admission behind the motion fence transaction',async()=>{
 const s=await publish(),c=await db.connect();
 try{
  await c.query('BEGIN');await c.query('SELECT revision FROM alarm_configuration_revision WHERE singleton FOR UPDATE');
  const waiting=gate.admit(request(s));
  await c.query('UPDATE ptz_view_guards SET revision=revision+1,stop_pending=true');
  await c.query('UPDATE alarm_configuration_revision SET revision=revision+1');await c.query('COMMIT');
  expect((await waiting).decision).toBe('retry');
 }finally{await c.query('ROLLBACK');c.release();}
});
it.skipIf(!enabled)('fixed camera rules receive no motion metadata and do not share a moving scope',async()=>{
 const s=await publish([...raw,{...raw[0],id:'fixed',input_stream_id:'fixed',channel_id:'fixed-ai'}]);
 expect(s.motion_admission!.scopes.map(x=>x.channel_id)).toEqual(['ai']);
 // Fixed-camera ingestion never calls admission; a new PTZ registration cannot
 // infer absence of stale alarm rules from an empty current binding set.
 expect(await gate.ready(['fixed'],['fixed-ai'])).toBe(false);
});
it.skipIf(!enabled)('does not treat removed PG bindings as proof an old alarm snapshot is fenced',async()=>{
 expect(await gate.ready(['cam'],['ai'])).toBe(false);
 await publish();expect(await gate.ready(['cam'],['ai'])).toBe(true);
});
it.skipIf(!enabled)('requires an installed complete alias set, even when the new alias has no current rules',async()=>{
 const old=await publish();expect(await gate.ready(['cam'],['ai'])).toBe(true);
 expect(await gate.ready(['cam','new-alias'],['ai'])).toBe(false);
 await db.query("UPDATE ptz_view_guards SET source_ids=ARRAY['cam','new-alias']");
 await db.query('UPDATE alarm_configuration_revision SET revision=revision+1');
 await gate.acknowledge(old,{protocol:1,scopes_digest:motionDigest(old.motion_admission!.scopes)});
 expect(await gate.ready(['cam','new-alias'],['ai'])).toBe(false);
 // An entirely empty, acknowledged snapshot can safely retire the old rules.
 await publish([]);expect(await gate.ready(['cam','new-alias'],['ai'])).toBe(true);
});
it.skipIf(!enabled)('configuration changes and replacement source mappings invalidate admission',async()=>{
 const s=await publish();await db.query('UPDATE alarm_configuration_revision SET revision=revision+1');
 expect((await gate.admit(request(s))).decision).toBe('retry');
 const current=await publish();await db.query("UPDATE ptz_view_guards SET source_ids=ARRAY['other'],revision=revision+1");
 expect((await gate.admit(request(current))).decision).toBe('retry');
});
it.skipIf(!enabled)('revokes whole-guard eligibility while an enabled sourceless legacy snapshot can still execute',async()=>{
 const capture=async(rules:unknown[])=>gate.snapshot({snapshot:async()=>({schema_version:'1.0',revision:(await db.query('SELECT revision::text FROM alarm_configuration_revision')).rows[0].revision,rules})});
 const ack=(s:MotionSnapshot)=>gate.acknowledge(s,{protocol:1,scopes_digest:motionDigest(s.motion_admission!.scopes)});
 const original=await publish();expect(await gate.ready(['cam'],['ai'])).toBe(true);
 await db.query(`INSERT INTO alarm_triggers(trigger_id,version,document) VALUES('legacy',1,$1)`,[JSON.stringify({state:'enabled',bindings:[{channel_id:'ai'}]})]);
 try{
  await db.query('UPDATE alarm_configuration_revision SET revision=revision+1');
  const legacy={id:'legacy@ai',channel_id:'ai',state:'enabled'};
  const unsafe=await capture([...raw,legacy]);await ack(unsafe);
  expect(await gate.ready(['cam'],['ai'])).toBe(false);
  // PG authoring has retired legacy, but Mongo may still execute unsafe.
  await db.query("UPDATE alarm_triggers SET document=jsonb_set(document,'{state}','\"disabled\"') WHERE trigger_id='legacy'");
  await db.query('UPDATE alarm_configuration_revision SET revision=revision+1');
  expect(await gate.ready(['cam'],['ai'])).toBe(false);
  await ack(unsafe);await ack(original);
  expect(await gate.ready(['cam'],['ai'])).toBe(false);
  const clean=await capture(raw);
  expect(await gate.ready(['cam'],['ai'])).toBe(false);
  await ack(unsafe);expect(await gate.ready(['cam'],['ai'])).toBe(false);
  await ack(clean);expect(await gate.ready(['cam'],['ai'])).toBe(true);
 }finally{await db.query("DELETE FROM alarm_triggers WHERE trigger_id='legacy'");}
});
it.skipIf(!enabled)('does not alter legacy fixed-camera execution while withholding fast motion eligibility',async()=>{
 const legacy={id:'legacy-fixed',channel_id:'fixed-ai',state:'enabled'};
 const rules=[...raw,legacy];
 const s=await gate.snapshot({snapshot:async()=>({schema_version:'1.0',revision:(await db.query('SELECT revision::text FROM alarm_configuration_revision')).rows[0].revision,rules})});
 await gate.acknowledge(s,{protocol:1,scopes_digest:motionDigest(s.motion_admission!.scopes)});
 expect(s.rules).toEqual(rules);expect(s.motion_admission!.scopes.map(x=>x.channel_id)).toEqual(['ai']);
 expect(await gate.ready(['cam'],['ai'])).toBe(false);
});
it('internal admission requires the alarm identity and bounded validated input',async()=>{
 const app=Fastify();let authorized=false;
 await app.register(ptzMotionRoutes,{principal:()=>authorized,admission:{admit:async()=>({decision:'permit'})} as any});
 try{
  expect((await app.inject({method:'POST',url:'/api/internal/ptz-motion/admit',payload:{}})).statusCode).toBe(403);
  authorized=true;
  expect((await app.inject({method:'POST',url:'/api/internal/ptz-motion/admit',payload:{}})).statusCode).toBe(422);
  const s={motion_admission:{scopes:[{guard_epoch:'a'.repeat(64),execution_digest:'b'.repeat(64)}]}} as MotionSnapshot;
  expect((await app.inject({method:'POST',url:'/api/internal/ptz-motion/admit',payload:request(s)})).statusCode).toBe(200);
 }finally{await app.close();}
});
