import {expect,it} from 'vitest';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {AlarmArmingStore} from '../store/alarmArmingStore.js';
import {flowRoutes} from '../routes/flowRoutes.js';
it('opts into historical bindings only with the explicit flag and keeps the legacy default',async()=>{
 const calls:boolean[]=[];
 const app=Fastify();
 await app.register(flowRoutes,{store:{listCounters:async (all=false)=>{calls.push(all);return []}} as any,
  principal:async()=> 'operator',catalog:async()=>null,synchronization:null,connection:async()=>null});
 try{
  for(const url of ['/flow/counters','/flow/counters?include_inactive=0','/flow/counters?include_inactive=1'])
   expect((await app.inject({url})).statusCode).toBe(200);
  expect(calls).toEqual([false,false,true]);
  expect((await app.inject({url:'/flow/counters?include_inactive=true'})).statusCode).toBe(422);
 }finally{await app.close()}
});
it.skipIf(process.env.AINVR_FLOW_REVIEW_PG!=='1')('PG preserves binding identities and projects authoritative state/membership history',async()=>{
 process.loadEnvFile('/home/sunrise/ainvr/deploy/s100p/runtime/backend.env');
 const connection={host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT),user:process.env.CONFIG_PG_USER,
  password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE};
 const schema='flow_review_'+randomUUID().replaceAll('-',''),admin=new Pool(connection);
 let pool:Pool|undefined,created=false;
 try{
  await admin.query('CREATE SCHEMA '+schema);created=true;
  pool=new Pool({...connection,options:'-c search_path='+schema});
  for(const name of ['003_alarm_zones.sql','004_alarm_monitors.sql','005_alarm_triggers.sql','006_alarm_migration_review.sql','007_alarm_arming_storage.sql','009_flow_counters.sql','010_flow_counter_library.sql','011_flow_counter_history.sql'])
   await pool.query(await readFile(new URL('../store/migrations/'+name,import.meta.url),'utf8'));
  const document={counter_id:'people',name:'People',labels:[{label_id:'person',name:'Person'}],method:'line',outputs:'in',names:{in:'In',out:'Out'},occupancy:false,max_gap_ms:1000,state:'enabled'};
  await pool.query('INSERT INTO flow_counter_definitions(counter_id,version,document) VALUES($1,1,$2)',['people',document]);
  await pool.query('INSERT INTO flow_counter_definition_versions(counter_id,version,document,actor,created_at) VALUES($1,1,$2,$3,$4)',['people',document,'test','2026-10-01T00:00:00Z']);
  await pool.query('INSERT INTO alarm_arming_sources(source_id,revision,document) VALUES($1,3,$2)',['camera',{zones:[{zone_id:'live-zone',name:'Live'}]}]);
  for(const [binding_id,zone_id,active] of [['flow-live','live-zone',true],['flow-old','gone-zone',false]] as const)
   await pool.query('INSERT INTO flow_counter_bindings(binding_id,source_id,counter_id,execution_version,document,active) VALUES($1,$2,$3,1,$4,$5)',
    [binding_id,'camera','people',{binding_id,zone_id,processor_id:'ai',direction:{kind:'line',edge:'edge',in_side:'inward'}},active]);
  for(const [revision,created_at,ids] of [[1,'2026-10-01T00:00:00Z',['flow-live','flow-old']],[2,'2026-10-01T01:00:00Z',[]],[3,'2026-10-01T02:00:00Z',['flow-live']]] as const)
   await pool.query('INSERT INTO alarm_arming_versions(source_id,revision,document,actor,created_at) VALUES($1,$2,$3,$4,$5)',
    ['camera',revision,{counter_bindings:ids.map(binding_id=>({binding_id}))},'test',created_at]);
  const store=new AlarmArmingStore(pool);
  const defaults=await store.listCounters(),withOld=await store.listCounters(true);
  expect(defaults[0].bindings.map(b=>b.binding_id)).toEqual(['flow-live']);
  expect(withOld[0].bindings.find(b=>b.binding_id==='flow-old')).toMatchObject({active:false,zone_id:'gone-zone',zone_name:'gone-zone',processor_id:'ai'});
  expect(defaults[0].bindings[0]).toEqual(withOld[0].bindings.find(b=>b.binding_id==='flow-live'));
  expect((await store.definitionHistory(['people']))[0]).toMatchObject({version:1,document:{state:'enabled'},labels:document.labels});
  const history=await store.armingHistory(['camera'],{from:'2026-10-01T00:30:00Z',to:'2026-10-01T01:30:00Z'});
  expect(history.map(v=>v.revision)).toEqual([1,2,3]);
  expect(history[1]).toMatchObject({binding_ids:[],current_revision:3});
 }finally{
  await pool?.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
 }
},30000);
