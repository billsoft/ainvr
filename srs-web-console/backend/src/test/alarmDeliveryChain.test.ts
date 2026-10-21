import {it,expect} from 'vitest';
import {Pool} from 'pg';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AlarmArmingStore} from '../store/alarmArmingStore.js';
import {AlarmRuleSync} from '../services/alarmRuleSync.js';

it.skipIf(process.env.AINVR_ALARM_TEST_PG!=='1'||process.env.AINVR_ALARM_TEST_MONGO!=='1')('real PG arming publishes over HTTP and native journal resumes after rule service restart',async()=>{
 const id=randomUUID().replaceAll('-',''),schema='chain_'+id;
 const connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
 const admin=new Pool(connection),pool=new Pool({...connection,options:`-c search_path=${schema}`});
 const alarmRoot=new URL('../../../../alarm-service/',import.meta.url);
 const load=(name:string)=>import(new URL(`src/${name}.mjs`,alarmRoot).href);
 const {MongoClient}=createRequire(new URL('package.json',alarmRoot))('mongodb');
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});
 const db=client.db('ainvr_chain_'+id),root=await mkdtemp(path.join(tmpdir(),'ainvr-chain-'));
 let app:any,pump:any;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await client.connect();
  for(const file of ['003_alarm_zones.sql','004_alarm_monitors.sql','005_alarm_triggers.sql','006_alarm_migration_review.sql','007_alarm_arming_storage.sql','009_flow_counters.sql','010_flow_counter_library.sql','011_flow_counter_history.sql'])
   await pool.query(readFileSync(new URL('../store/migrations/'+file,import.meta.url),'utf8'));
  const {AlarmRepository}=await load('repository'),{ObservationConsumer}=await load('ingestion');
  const {createApp}=await load('http'),{ObservationPump}=await load('observation-pump'),{digest}=await load('domain');
  const repo=new AlarmRepository(db);await repo.initialize();
  const consumer=new ObservationConsumer(repo),store=new AlarmArmingStore(pool);
  const apiToken='chain-api-'.repeat(8),producerToken='chain-producer-'.repeat(8);
  const makeApp=()=>createApp({repository:repo,consumer,apiToken,producerToken});
  app=makeApp();const address=await app.listen({host:'127.0.0.1',port:0});
  const sync=new AlarmRuleSync(store,async()=>({baseUrl:address,apiToken,timeoutMs:1000}));
  const labels=[{class_id:0,label_id:'person',name:'Person',description:''}],url='rtmp://127.0.0.1/live/isolated-chain';
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  const source={channel_id:'ai',input_stream_id:'camera',geometry_revision:'g',label_map_version:'labels-'+digest(['test_bpu',labels]),tracking_available:true,labels:[{label_id:'person',name:'Person'}],width:1000,height:1000,stream_fingerprint:hash(url),observed_at:'2026-10-20T00:00:00Z'};
  const lookup=async()=>source;
  const definition={trigger_id:'appearance',name:'出现',behavior:'appearance',labels:source.labels,duration_ms:0,alarm_enabled:true,state:'enabled',schedule:{mode:'always'}};
  await store.saveDefinition(definition,0,'test','definition',lookup);
  const assignment={assignment_id:'selection',trigger_id:'appearance',input_stream_id:'camera',processor_id:'ai',zone_id:null,zone_version:null,geometry_revision:'g',label_map_version:source.label_map_version,entry_edges:[],exit_edges:[]};
  await store.saveArming({source_id:'camera',geometry_revision:'g',zones:[],assignments:[assignment]},0,'test','arming',lookup,async()=>'g');
  // No rule snapshot means the pump must retain evidence until rules arrive.
  pump=new ObservationPump(root,consumer,repo);
  const folder=path.join(root,hash('ai'));await mkdir(folder);
  let offset=0;
  async function record(track:string){
   offset++;const pts=String(offset*1000000000),name=String(offset).padStart(20,'0')+'.json';
   await writeFile(path.join(folder,name),JSON.stringify({schema_version:'1.0',producer_id:'native-chain',offset:String(offset),channel_id:'ai',stream_url:url,stream_session_id:'session',source_frame_index:String(offset),source_pts_ns:pts,timestamp:Date.parse(source.observed_at)/1000+offset,width:1000,height:1000,model:{id:'test',label_catalog:{schema_version:'1.0',adapter:'test_bpu',labels}},tracks:[{track_id:track,label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:200,y:300,w:20,h:40}}]}));
  }
  await record('one');await pump.tick();expect(await readdir(folder)).toHaveLength(1);
  expect(pump.status.last_error).toBe('rules_not_configured');
  expect((await sync.synchronize()).state).toBe('applied');
  await pump.tick();expect(await readdir(folder)).toEqual([]);
  expect(await repo.events.countDocuments()).toBe(1);
  // A previously successful synchronization is not proof while the service is down.
  await app.close();app=null;
  await store.saveDefinition({...definition,state:'paused'},1,'test','pause',lookup);
  expect((await sync.synchronize()).state).toBe('pending');
  const port=Number(new URL(address).port);app=makeApp();await app.listen({host:'127.0.0.1',port});
  const applied=await sync.synchronize();expect(applied).toMatchObject({state:'applied',desired_revision:(await store.snapshot()).revision});
  await record('two');await pump.tick();expect(await readdir(folder)).toEqual([]);
  expect(pump.status.last_ignored_reason).toBe('no_active_monitor');expect(await repo.events.countDocuments()).toBe(1);
  await store.saveDefinition({...definition,alarm_enabled:false},2,'test','statistics',lookup);
  expect((await sync.synchronize()).state).toBe('applied');
  await record('three');await pump.tick();expect(pump.status.failed).toBe(0);expect(await repo.events.countDocuments()).toBe(1);
  const result=await fetch(address+'/v1/behavior-statistics?from=2026-10-20T00%3A00%3A00Z&to=2026-10-21T00%3A00%3A00Z',{headers:{authorization:`Bearer ${apiToken}`}});
  expect(result.status).toBe(200);expect((await result.json() as any).items).toEqual([{event_type:'appearance',occurrences:2,tracked_targets:2}]);
 }finally{
  await pump?.close();await app?.close();await db.dropDatabase();await client.close();
  await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  await rm(root,{recursive:true,force:true});
 }
},30000);
