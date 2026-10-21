import {it,expect} from 'vitest';
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {AlarmZoneStore} from '../store/alarmZones.js';
import {AlarmTriggerStore,type TriggerSourceCatalog} from '../store/alarmTriggers.js';
const enabled=process.env.AINVR_ALARM_TEST_PG==='1';
const migration=(name:string)=>readFileSync(new URL(`../store/migrations/${name}`,import.meta.url),'utf8');
async function isolated(run:(pool:Pool)=>Promise<void>){
  const schema='t'+randomUUID().replaceAll('-',''),connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
  const admin=new Pool(connection);await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({...connection,options:`-c search_path=${schema}`});
  try{await run(pool);}finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>undefined);await admin.end();}
}
const square=[[.3,.2],[.7,.2],[.7,.8],[.3,.8]];
const catalog=(channel:string,extra:Partial<TriggerSourceCatalog>={}):TriggerSourceCatalog=>({channel_id:channel,input_stream_id:'in-'+channel,label_map_version:'lm',label_ids:['person','car'],
  geometry_revision:'g-'+channel,tracking_available:true,labels:[{label_id:'person',name:'person'},{label_id:'car',name:'car'}],width:1920,height:1080,observed_at:'2026-10-20T01:00:00Z',stream_fingerprint:'a'.repeat(64),...extra});
// A trigger detects one behavior on one or more channels; zones bind per channel.
it.skipIf(!enabled)('PG triggers bind several channels, validate per behavior and publish one rule per channel',async()=>isolated(async pool=>{
  for(const name of ['003_alarm_zones.sql','004_alarm_monitors.sql','005_alarm_triggers.sql'])await pool.query(migration(name));
  const zones=new AlarmZoneStore(pool),store=new AlarmTriggerStore(pool);
  await zones.save({zone_id:'gate-area',channel_id:'in-gate',name:'门前区',geometry_revision:'g-gate',points:square,state:'active'},0,'operator','z1');
  const catalogs:Record<string,TriggerSourceCatalog|null>={gate:catalog('gate'),yard:catalog('yard'),blind:catalog('blind',{tracking_available:false}),offline:null};
  const lookup=async(id:string)=>catalogs[id]??null;
  const binding=(channel:string,extra={})=>({channel_id:channel,label_map_version:'lm',geometry_revision:'g-'+channel,zone_id:null,zone_version:null,direction:{entry_edges:[],exit_edges:[]},...extra});
  const appearance={trigger_id:'front',name:'前区有人',behavior:'appearance',labels:[{label_id:'person',name:'person'}],duration_ms:3000,alarm_enabled:true,state:'enabled',schedule:{mode:'always'},bindings:[binding('gate'),binding('yard')]};
  const saved=await store.save(appearance,0,'operator','a1',lookup);
  expect(saved.trigger.version).toBe(1);expect(saved.trigger.bindings.map((b:{input_stream_id:string})=>b.input_stream_id)).toEqual(['in-gate','in-yard']);
  expect(await store.save(appearance,0,'operator','a1',lookup)).toEqual(saved);
  const zoneBinding=binding('gate',{zone_id:'gate-area',zone_version:1});
  const passage={...appearance,trigger_id:'pass',name:'通道进出',behavior:'region_traverse',duration_ms:0,alarm_enabled:false,bindings:[{...zoneBinding,direction:{entry_edges:[2],exit_edges:[0]}}]};
  const reject=async(input:unknown,code:string,key:string)=>expect(store.save(input,0,'operator',key,lookup)).rejects.toMatchObject({code});
  await reject({...passage,bindings:[binding('gate')]},'zone_required','r1');
  await reject({...passage,bindings:[{...zoneBinding,direction:{entry_edges:[4],exit_edges:[]}}]},'invalid_direction','r2');
  await reject({...passage,bindings:[{...zoneBinding,direction:{entry_edges:[1],exit_edges:[1]}}]},'invalid_direction','r3');
  await reject({...passage,behavior:'region_enter',bindings:[{...zoneBinding,direction:{entry_edges:[2],exit_edges:[0]}}]},'invalid_direction','r4');
  await reject({...passage,behavior:'region_approach'},'invalid_trigger','r5');
  await reject({...appearance,trigger_id:'x',bindings:[binding('gate',{zone_id:'gate-area',zone_version:1})]},'invalid_trigger','r6');
  await reject({...appearance,trigger_id:'x',bindings:[binding('gate'),binding('gate')]},'invalid_trigger','r7');
  await reject({...appearance,trigger_id:'x',labels:[{label_id:'dog',name:'dog'}]},'source_changed','r8');
  await reject({...appearance,trigger_id:'x',labels:[{label_id:'person',name:'fire'}]},'source_changed','r8b');  // same number, other model
  await reject({...appearance,trigger_id:'x',bindings:[binding('blind')]},'tracking_required','r9');
  await reject({...appearance,trigger_id:'x',bindings:[binding('offline')]},'source_unavailable','r10');
  await reject({...appearance,trigger_id:'x',behavior:'line_crossing'},'invalid_trigger','r11');
  await store.save(passage,0,'operator','p1',lookup);
  await store.save({...passage,trigger_id:'near',name:'接近',behavior:'region_approach',bindings:[{...zoneBinding,approach_px:96}]},0,'operator','n1',lookup);
  let rules=(await store.snapshot()).rules as Record<string,unknown>[];
  expect(rules.map(r=>r.id).sort()).toEqual(['front@gate','front@yard','near@gate','pass@gate']);
  const pass=rules.find(r=>r.id==='pass@gate')!;
  expect(pass).toMatchObject({label_ids:['person'],trigger_id:'pass',behavior:'region_traverse',channel_id:'gate',input_stream_id:'in-gate',points:square,entry_edges:[2],exit_edges:[0],alarm_enabled:false});
  expect(rules.find(r=>r.id==='near@gate')).toMatchObject({approach_px:96});
  expect(rules.find(r=>r.id==='front@yard')).toMatchObject({duration_ms:3000,points:undefined});
  // A later zone edit does not move an enabled trigger; archive removes its rules.
  await zones.save({zone_id:'gate-area',channel_id:'in-gate',name:'门前区',geometry_revision:'g-gate',points:[[.1,.1],[.9,.1],[.9,.9]],state:'active'},1,'operator','z2');
  rules=(await store.snapshot()).rules as Record<string,unknown>[];expect(rules.find(r=>r.id==='pass@gate')!.points).toEqual(square);
  await store.setState('front','archived',1,'operator','s1');
  rules=(await store.snapshot()).rules as Record<string,unknown>[];expect(rules.map(r=>r.id).sort()).toEqual(['near@gate','pass@gate']);
  expect((await store.list()).find((t:{trigger_id:string})=>t.trigger_id==='front').state).toBe('archived');
}));
it.skipIf(!enabled)('migration turns each monitor behavior into its own trigger and keeps history ids',async()=>isolated(async pool=>{
  for(const name of ['003_alarm_zones.sql','004_alarm_monitors.sql'])await pool.query(migration(name));
  const document={monitor_id:'m',channel_id:'gate',name:'大门',label_map_version:'lm',label_ids:['person'],geometry_revision:'g-gate',zone_id:'z',zone_version:2,
    behaviors:['appearance','region_approach','region_contact'],alarm_enabled:true,state:'archived',schedule:{mode:'always'},duration_ms:1000,approach_distance:.05,
    behavior_settings:{appearance:{duration_ms:4000}},input_stream_id:'in-gate',source_binding:{width:1920,height:1080},zone_snapshot:{zone_id:'z',name:'门前区',points:square,version:2}};
  await pool.query('INSERT INTO alarm_monitors(monitor_id,channel_id,version,document) VALUES($1,$2,$3,$4)',['m','gate',3,JSON.stringify(document)]);
  await pool.query(migration('005_alarm_triggers.sql'));
  const rows=(await pool.query('SELECT trigger_id,version,document FROM alarm_triggers ORDER BY trigger_id')).rows;
  expect(rows.map(r=>r.trigger_id)).toEqual(['m:appearance','m:region_approach']);  // contact is not a trigger behavior
  expect(rows[0].document).toMatchObject({labels:[{label_id:'person',name:'person'}],behavior:'appearance',duration_ms:4000,state:'archived',bindings:[{channel_id:'gate',zone_id:null,input_stream_id:'in-gate'}]});
  expect(rows[1].document).toMatchObject({behavior:'region_approach',duration_ms:0,bindings:[{zone_id:'z',zone_version:2,approach_px:96,direction:{entry_edges:[],exit_edges:[]},zone_snapshot:{name:'门前区'}}]});
  expect((await pool.query('SELECT revision::int AS r FROM alarm_configuration_revision')).rows[0].r).toBe(1);
}));
