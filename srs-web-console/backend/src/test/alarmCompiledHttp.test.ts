import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {compileAssignment,parseTriggerDefinition} from '../store/alarmTriggerDefinition.js';

it.skipIf(process.env.AINVR_ALARM_TEST_MONGO!=='1')('compiled selections persist through HTTP ingestion, statistics-only use and acknowledgement',async()=>{
 const alarmRoot=new URL('../../../../alarm-service/',import.meta.url);
 const load=(name:string)=>import(new URL(`src/${name}.mjs`,alarmRoot).href);
 const {MongoClient}=createRequire(new URL('package.json',alarmRoot))('mongodb');
 const {AlarmRepository}=await load('repository');
 const {ObservationConsumer}=await load('ingestion');
 const {createApp}=await load('http');
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});
 await client.connect();
 const db=client.db('ainvr_alarm_contract_'+randomUUID().replaceAll('-',''));
 let app:any;
 try{
  const repository=new AlarmRepository(db);await repository.initialize();
  const apiToken='contract-operator-'.repeat(4),producerToken='contract-producer-'.repeat(4);
  app=createApp({repository,consumer:new ObservationConsumer(repository),apiToken,producerToken});
  const headers={authorization:`Bearer ${apiToken}`,'x-ainvr-actor':'contract-test'};
  const source={channel_id:'ai',input_stream_id:'camera',geometry_revision:'g',label_map_version:'lm',tracking_available:true,
   labels:[{label_id:'person',name:'人员'}],width:1920,height:1080,stream_fingerprint:'a'.repeat(64),observed_at:'2026-10-20T00:00:00Z'};
  const zone={zone_id:'zone',channel_id:'camera',geometry_revision:'g',version:1,state:'active',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]] as [number,number][],edge_ids:['top','right','bottom','left']};
  const definition=parseTriggerDefinition({trigger_id:'passage',name:'穿过计数',behavior:'region_traverse',labels:source.labels,duration_ms:0,alarm_enabled:true,state:'enabled',schedule:{mode:'always'}});
  const assignment={assignment_id:'selection',trigger_id:'passage',input_stream_id:'camera',processor_id:'ai',zone_id:'zone',zone_version:1,geometry_revision:'g',label_map_version:'lm',entry_edges:['left'],exit_edges:['right']};
  const rule=compileAssignment(definition,1,assignment,source,zone,1);
  async function snapshot(revision:string,rules:unknown[]){
   const r=await app.inject({method:'POST',url:'/v1/configuration/rules',headers,payload:{schema_version:'1.0',revision,rules}});
   expect(r.statusCode,r.body).toBe(200);expect(r.json().applied).toBe(true);
  }
  let seq=0;
  async function walk(track:string){
   for(const x of [.2,.4,.6,.8]){
    seq++;const pts=String(seq*200000000);
    const payload={schema_version:'1.0',producer_id:'contract',offset:String(seq),frame:{schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:'s',seq:String(seq),frame_id:`s:${seq}`,source_pts_ns:pts,captured_at:new Date(Date.parse(source.observed_at)+seq*200).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},tracks:[{track_id:track,label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1920-10,y:520,w:20,h:20}}]}};
    const request={method:'POST',url:'/v1/observations',headers:{authorization:`Bearer ${producerToken}`},payload};
    const r=await app.inject(request);expect(r.statusCode,r.body).toBe(200);expect(r.json().durable).toBe(true);
    // The producer may retry every delivered frame; neither fact nor alarm duplicates.
    const replay=await app.inject(request);expect(replay.json().outcome).toBe('already_consumed');
   }
  }
  const query='from=2026-10-20T00%3A00%3A00Z&to=2026-10-21T00%3A00%3A00Z&channel_id=ai';
  async function stats(){const r=await app.inject({url:`/v1/behavior-statistics?${query}`,headers});expect(r.statusCode,r.body).toBe(200);return r.json();}
  await snapshot('1',[]);await walk('unbound');expect((await stats()).items).toEqual([]);
  await snapshot('2',[rule]);await walk('alarm-target');
  expect((await stats()).items).toEqual([{event_type:'region_traverse',occurrences:1,tracked_targets:1}]);
  const facts=await app.inject({url:`/v1/behavior-events?${query}`,headers});
  expect(facts.statusCode,facts.body).toBe(200);expect(facts.json().items).toHaveLength(1);
  expect(facts.json().items[0]).toMatchObject({event_type:'region_traverse',trigger_id:'passage',rule_id:'selection',rule_version:1,zone_id:'zone',direction:{entry_edge:3,exit_edge:1}});
  const alarm=await repository.events.findOne();expect(await repository.events.countDocuments()).toBe(1);
  const before=await stats();
  const ack=await app.inject({method:'POST',url:`/v1/events/${alarm.alarm_id}/acknowledgements`,headers:{...headers,'idempotency-key':'contract-ack'},payload:{expected_handling_revision:0}});
  expect(ack.statusCode,ack.body).toBe(200);expect(await stats()).toEqual(before);
  const countOnly=compileAssignment({...definition,alarm_enabled:false},2,assignment,source,zone,2);
  await snapshot('3',[countOnly]);await walk('statistics-target');
  expect((await stats()).items).toEqual([{event_type:'region_traverse',occurrences:2,tracked_targets:2}]);
  expect(await repository.events.countDocuments()).toBe(1);
  await snapshot('4',[]);await walk('removed-target');
  expect((await stats()).items).toEqual([{event_type:'region_traverse',occurrences:2,tracked_targets:2}]);
 }finally{await app?.close();await db.dropDatabase();await client.close();}
},30000);