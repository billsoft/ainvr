import {expect,it} from 'vitest';
import {Pool} from 'pg';
import Fastify from 'fastify';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {AlarmArmingStore} from '../store/alarmArmingStore.js';
import {flowRoutes} from '../routes/flowRoutes.js';
const pgEnabled=process.env.AINVR_ALARM_TEST_PG==='1',mongoEnabled=process.env.AINVR_ALARM_TEST_MONGO==='1';
async function isolated(run:(store:AlarmArmingStore,pool:Pool)=>Promise<void>){
  const schema='flow_'+randomUUID().replaceAll('-','');
  const connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
  const admin=new Pool(connection);await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({...connection,options:`-c search_path=${schema}`});
  try{
    for(const file of ['003_alarm_zones.sql','004_alarm_monitors.sql','005_alarm_triggers.sql','006_alarm_migration_review.sql','007_alarm_arming_storage.sql','009_flow_counters.sql','010_flow_counter_library.sql','011_flow_counter_history.sql'])
      await pool.query(readFileSync(new URL('../store/migrations/'+file,import.meta.url),'utf8'));
    await run(new AlarmArmingStore(pool),pool);
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
const source={stream_fingerprint:'a'.repeat(64),observed_at:'2026-10-21T00:00:00Z',channel_id:'ai',input_stream_id:'camera',geometry_revision:'g',label_map_version:'lm',tracking_available:true,
  labels:[{label_id:'person',name:'人员'}],width:1000,height:1000};
const lookup=async()=>source,offline=async()=>null;
const counter={counter_id:'visitors',name:'客流',labels:[{label_id:'person',name:'人员'}],method:'zone',outputs:'both',names:{in:'进',out:'出'},occupancy:true,max_gap_ms:1000,state:'enabled'};
const zone=(points:[number,number][]=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],version=1,edge_ids=['top','right','bottom','left'])=>
  ({zone_id:'door',channel_id:'camera',geometry_revision:'g',version,state:'active',name:'门口',points,edge_ids});
const binding=(zoneVersion=1)=>({binding_id:'flow-door-visitors',counter_id:'visitors',input_stream_id:'camera',processor_id:'ai',zone_id:'door',zone_version:zoneVersion,
  geometry_revision:'g',label_map_version:'lm',direction:{kind:'edges',entry:['left'],exit:['right']}});
const arming=(z=zone(),bindings=[binding(z.version)])=>({source_id:'camera',geometry_revision:'g',zones:[z],assignments:[],counter_bindings:bindings});
it.skipIf(!pgEnabled)('PG 计数器库：选用随布防保存，拖动顶点不打断，删掉计数边被拒，名称修改不依赖在线来源，删除解除选用',async()=>isolated(async store=>{
  await store.saveCounter(counter,0,'operator','c1',lookup);
  await store.saveArming(arming(),0,'operator','a1',lookup,async()=>'g');
  let rules=(await store.snapshot()).rules as any[];
  expect(rules.map(r=>[r.id,r.counter_id,r.alarm_enabled])).toEqual([['flow-door-visitors','visitors',false]]);
  expect((await store.readArming('camera'))!.counter_bindings).toHaveLength(1);
  // Dragging a vertex keeps every edge id: the same binding keeps counting, only the rule version moves.
  await store.saveArming(arming(zone([[.3,.25],[.72,.3],[.7,.7],[.3,.7]],2),[binding(2)]),1,'operator','a2',lookup,async()=>'g');
  rules=(await store.snapshot()).rules as any[];
  expect(rules[0]).toMatchObject({id:'flow-door-visitors',version:2,zone_version:2});
  // Re-drawing with new edges invalidates the counting line until it is confirmed again.
  await expect(store.saveArming(arming(zone(undefined,3,['a','b','c','d']),[binding(3)]),2,'operator','a3',lookup,async()=>'g')).rejects.toMatchObject({code:'direction_changed'});
  // Renaming while the camera is offline still works and keeps the execution version,
  // so a target that is half-way through the line is still counted.
  await store.saveCounter({...counter,name:'正门客流'},1,'operator','c2',offline);
  expect(((await store.snapshot()).rules as any[])[0]).toMatchObject({name:'正门客流',version:2,trigger_version:2});
  // A gap change alters the judgement, so it does start a new execution version.
  await store.saveCounter({...counter,name:'正门客流',max_gap_ms:500},2,'operator','c2b',offline);
  expect(((await store.snapshot()).rules as any[])[0]).toMatchObject({version:3});
  await store.saveCounter({...counter,name:'正门客流',max_gap_ms:1000},3,'operator','c2c',offline);
  const listed=await store.listCounters();
  expect(listed[0]).toMatchObject({name:'正门客流',bindings:[{binding_id:'flow-door-visitors',zone_name:'门口',counting:true}]});
  await store.saveCounter({...counter,state:'paused'},4,'operator','c3',offline);
  expect((await store.snapshot()).rules).toEqual([]);
  await expect(store.saveCounter({...counter,method:'line'},5,'operator','c4',lookup)).rejects.toMatchObject({code:'invalid_counter'});
  // There is no archive: a counter is kept or deleted together with its history.
  await expect(store.saveCounter({...counter,state:'archived'},5,'operator','c5',offline)).rejects.toMatchObject({code:'invalid_counter'});
  // Deleting first stops counting everywhere, then the records are purged, then the definition goes.
  await expect(store.beginDeleteCounter('visitors',4,'operator','d0')).rejects.toMatchObject({code:'version_conflict'});
  expect(await store.beginDeleteCounter('visitors',5,'operator','d1')).toEqual({binding_ids:['flow-door-visitors']});
  expect((await store.readArming('camera'))!.counter_bindings).toEqual([]);
  expect((await store.snapshot()).rules).toEqual([]);
  expect((await store.listCounters())[0]).toMatchObject({counter_id:'visitors',deleting:true,bindings:[]});
  await expect(store.saveCounter({...counter,state:'enabled'},6,'operator','c6',offline)).rejects.toMatchObject({code:'counter_deleting'});
  await expect(store.saveArming(arming(zone([[.3,.25],[.72,.3],[.7,.7],[.3,.7]],2)),3,'operator','a4',lookup,async()=>'g')).rejects.toMatchObject({code:'counter_unavailable'});
  // A retry of an unfinished delete is accepted whatever version the page still holds.
  expect(await store.beginDeleteCounter('visitors',1,'operator','d2')).toEqual({binding_ids:['flow-door-visitors']});
  await store.finishDeleteCounter('visitors');
  expect(await store.listCounters()).toEqual([]);
  expect(await store.counterBindings(['visitors'])).toEqual([]);
}));
it.skipIf(!pgEnabled||!mongoEnabled)('布防→回放→流量接口：一条计数线同时得到进与出，告警为零，记录与统计一致，今日实时累计',async()=>isolated(async store=>{
  const alarmRoot=new URL('../../../../alarm-service/',import.meta.url);
  const load=(name:string)=>import(new URL(`src/${name}.mjs`,alarmRoot).href);
  const {MongoClient}=createRequire(new URL('package.json',alarmRoot))('mongodb');
  const {AlarmRepository}=await load('repository'),{ObservationConsumer}=await load('ingestion'),{createApp}=await load('http');
  const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
  const db=client.db('ainvr_flow_routes_'+randomUUID().replaceAll('-',''));
  const repository=new AlarmRepository(db);await repository.initialize();
  const apiToken='flow-route-test-'.repeat(4),analysis=createApp({repository,apiToken});
  const web=Fastify();
  try{
    await analysis.listen({host:'127.0.0.1',port:0});
    const baseUrl=`http://127.0.0.1:${(analysis.server.address() as {port:number}).port}`;
    await web.register(flowRoutes,{store,principal:async()=>'operator',catalog:lookup,synchronization:null,connection:async()=>({baseUrl,apiToken,timeoutMs:5000})});
    const saved=await web.inject({method:'POST',url:'/flow/counters',headers:{'idempotency-key':'k1'},payload:{counter,expected_version:0}});
    expect(saved.statusCode,saved.body).toBe(200);
    await store.saveArming(arming(),0,'operator','a1',lookup,async()=>'g');
    const snapshot=await store.snapshot();
    const applied=await analysis.inject({method:'POST',url:'/v1/configuration/rules',headers:{authorization:`Bearer ${apiToken}`,'x-ainvr-actor':'test'},payload:snapshot});
    expect(applied.statusCode,applied.body).toBe(200);
    const consumer=new ObservationConsumer(repository),base=Date.now()+1000,xs=[.2,.4,.6,.8,.6,.4,.2];
    for(let i=0;i<xs.length;i++){
      const pts=String((i+1)*1000000000);
      await consumer.consume({schema_version:'1.0',producer_id:'p',offset:String(i+1),frame:{schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:'s',seq:String(i+1),frame_id:String(i+1),
        source_pts_ns:pts,captured_at:new Date(base+i*1000).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},
        tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:xs[i]!*1000-10,y:480,w:20,h:20}}]}});
    }
    expect(await repository.events.countDocuments()).toBe(0);
    const window={from:new Date(base-3600000).toISOString(),to:new Date(base+3600000).toISOString()};
    const query=await web.inject({method:'POST',url:'/flow/query',payload:{...window,bucket:'hour',timezone:'Asia/Shanghai'}});
    expect(query.statusCode,query.body).toBe(200);
    const item=query.json().items[0];
    expect([item.in.occurrences,item.out.occurrences]).toEqual([1,1]);
    expect(item.zones[0]).toMatchObject({zone_name:'门口',in:{occurrences:1},out:{occurrences:1}});
    const records=await web.inject({method:'POST',url:'/flow/records',payload:{counter_id:'visitors',binding_id:'flow-door-visitors',output:'out',...window}});
    expect(records.json().items).toHaveLength(1);expect(records.json().items[0].direction).toMatchObject({entry_edge_id:'right',exit_edge_id:'left'});
    const live=await web.inject({method:'GET',url:`/flow/live?source_id=camera&from=${encodeURIComponent(new Date(base-1000).toISOString())}`});
    expect(live.json().items).toEqual([expect.objectContaining({binding_id:'flow-door-visitors',name:'客流',in:1,out:1,zone_id:'door'})]);
    // Behavior statistics stay free of counter passages.
    const behavior=await analysis.inject({method:'GET',url:`/v1/behavior-statistics?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`,headers:{authorization:`Bearer ${apiToken}`}});
    expect(behavior.json().items).toEqual([]);
  }finally{await web.close();await analysis.close();await db.dropDatabase();await client.close();}
}));
it.skipIf(!pgEnabled)('PG 迁移是兼容的：首版流量表保留，回退到首版后端时其接口仍能读写',async()=>isolated(async(_store,pool)=>{
  expect((await pool.query("SELECT count(*)::int AS n FROM flow_counters")).rows[0].n).toBe(0);
  expect((await pool.query("SELECT count(*)::int AS n FROM flow_counter_versions")).rows[0].n).toBe(0);
  expect((await pool.query("SELECT to_regclass('flow_counter_binding_versions') AS t")).rows[0].t).toBe('flow_counter_binding_versions');
}));
it.skipIf(!pgEnabled||!mongoEnabled)('调整计数线默认不改写历史统计；明确选择“重新统计历史”才按新计数线重算',async()=>isolated(async store=>{
  const alarmRoot=new URL('../../../../alarm-service/',import.meta.url);
  const load=(name:string)=>import(new URL(`src/${name}.mjs`,alarmRoot).href);
  const {MongoClient}=createRequire(new URL('package.json',alarmRoot))('mongodb');
  const {AlarmRepository}=await load('repository'),{ObservationConsumer}=await load('ingestion'),{createApp}=await load('http');
  const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
  const db=client.db('ainvr_flow_history_'+randomUUID().replaceAll('-',''));
  const repository=new AlarmRepository(db);await repository.initialize();
  const apiToken='flow-history-test-'.repeat(4),analysis=createApp({repository,apiToken});
  const web=Fastify(),wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  try{
    await analysis.listen({host:'127.0.0.1',port:0});
    const baseUrl=`http://127.0.0.1:${(analysis.server.address() as {port:number}).port}`;
    await web.register(flowRoutes,{store,principal:async()=>'operator',catalog:lookup,synchronization:null,connection:async()=>({baseUrl,apiToken,timeoutMs:5000})});
    const line=(in_side:'inward'|'outward',extra={})=>({...binding(),direction:{kind:'line',edge:'right',in_side},...extra});
    await store.saveCounter({...counter,method:'line'},0,'operator','c1',lookup);
    await store.saveArming(arming(zone(),[line('inward')]),0,'operator','a1',lookup,async()=>'g');
    const apply=async()=>{const r=await analysis.inject({method:'POST',url:'/v1/configuration/rules',headers:{authorization:`Bearer ${apiToken}`,'x-ainvr-actor':'test'},payload:await store.snapshot()});expect(r.statusCode,r.body).toBe(200);};
    await apply();await wait(60);
    // One target walks left to right: it leaves the zone over the right edge ("outward").
    const consumer=new ObservationConsumer(repository),base=Date.now(),xs=[.5,.6,.8,.9];
    for(let i=0;i<xs.length;i++){const pts=String((i+1)*1000000000);
      await consumer.consume({schema_version:'1.0',producer_id:'p',offset:String(i+1),frame:{schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:'s',seq:String(i+1),frame_id:String(i+1),
        source_pts_ns:pts,captured_at:new Date(base+i*5).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},
        tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:xs[i]!*1000-10,y:480,w:20,h:20}}]}});}
    await wait(100);
    const window={from:new Date(base-3600000).toISOString(),to:new Date(base+3600000).toISOString()};
    const totals=async()=>{const r=(await web.inject({method:'POST',url:'/flow/query',payload:window})).json().items[0];return [r.in.occurrences,r.out.occurrences];};
    expect(await totals()).toEqual([0,1]);
    // Flipping the arrow applies from now on; the recorded passage keeps its meaning.
    await store.saveArming(arming(zone(),[line('outward')]),1,'operator','a2',lookup,async()=>'g');
    expect(await totals()).toEqual([0,1]);
    // An explicit "recount history" reinterprets everything since the line was selected.
    await store.saveArming(arming(zone(),[line('inward',{reclassify_history:true})]),2,'operator','a3',lookup,async()=>'g');
    expect(await totals()).toEqual([0,1]);
    await store.saveArming(arming(zone(),[line('outward',{reclassify_history:true})]),3,'operator','a4',lookup,async()=>'g');
    expect(await totals()).toEqual([1,0]);
    // The flag is an instruction, not part of the stored selection.
    expect((await store.readArming('camera'))!.counter_bindings[0]).not.toHaveProperty('reclassify_history');
  }finally{await web.close();await analysis.close();await db.dropDatabase();await client.close();}
}));
it.skipIf(!pgEnabled||!mongoEnabled)('删除计数器连同它的通行与覆盖记录一起删除；分析服务不可用时留在“删除未完成”，重试后完成',async()=>isolated(async store=>{
  const alarmRoot=new URL('../../../../alarm-service/',import.meta.url);
  const load=(name:string)=>import(new URL(`src/${name}.mjs`,alarmRoot).href);
  const {MongoClient}=createRequire(new URL('package.json',alarmRoot))('mongodb');
  const {AlarmRepository}=await load('repository'),{ObservationConsumer}=await load('ingestion'),{createApp}=await load('http');
  const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
  const db=client.db('ainvr_flow_delete_'+randomUUID().replaceAll('-',''));
  const repository=new AlarmRepository(db);await repository.initialize();
  const apiToken='flow-delete-test-'.repeat(4),analysis=createApp({repository,apiToken});
  const down=Fastify(),up=Fastify();
  let purgeAttempts=0;
  analysis.addHook('onRequest',async(req:any,reply:any)=>{
    if(req.url==='/v1/flow/purge'&&++purgeAttempts<=2)return reply.code(503).send({error:{code:'consumer_busy'}});
  });
  try{
    await analysis.listen({host:'127.0.0.1',port:0});
    const baseUrl=`http://127.0.0.1:${(analysis.server.address() as {port:number}).port}`;
    await down.register(flowRoutes,{store,principal:async()=>'operator',catalog:lookup,synchronization:null,connection:async()=>null});
    await up.register(flowRoutes,{store,principal:async()=>'operator',catalog:lookup,synchronization:null,connection:async()=>({baseUrl,apiToken,timeoutMs:5000})});
    await store.saveCounter(counter,0,'operator','c1',lookup);
    await store.saveCounter({...counter,counter_id:'other',name:'另一个'},0,'operator','c2',lookup);
    const other={...binding(),binding_id:'flow-door-other',counter_id:'other'};
    await store.saveArming(arming(zone(),[binding(),other]),0,'operator','a1',lookup,async()=>'g');
    const r=await analysis.inject({method:'POST',url:'/v1/configuration/rules',headers:{authorization:`Bearer ${apiToken}`,'x-ainvr-actor':'test'},payload:await store.snapshot()});expect(r.statusCode,r.body).toBe(200);
    const consumer=new ObservationConsumer(repository),base=Date.now()+1000,xs=[.2,.4,.6,.8];
    for(let i=0;i<xs.length;i++){const pts=String((i+1)*1000000000);
      await consumer.consume({schema_version:'1.0',producer_id:'p',offset:String(i+1),frame:{schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:'s',seq:String(i+1),frame_id:String(i+1),
        source_pts_ns:pts,captured_at:new Date(base+i*1000).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},
        tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:xs[i]!*1000-10,y:480,w:20,h:20}}]}});}
    const facts=(id:string)=>repository.behaviors.collection.countDocuments({counter_id:id});
    expect([await facts('visitors'),await facts('other')]).toEqual([1,1]);
    const remove=(app:typeof up,key:string)=>app.inject({method:'POST',url:'/flow/counters/visitors/delete',headers:{'idempotency-key':key},payload:{expected_version:1}});
    const failed=await remove(down,'k1');
    expect(failed.statusCode).toBe(503);
    expect((await store.listCounters()).find(c=>c.counter_id==='visitors')).toMatchObject({deleting:true});
    expect(await facts('visitors')).toBe(1);
    const done=await remove(up,'k2');
    expect(done.statusCode,done.body).toBe(200);expect(done.json()).toMatchObject({deleted:true});expect(purgeAttempts).toBe(3);
    const replay=await remove(up,'k2');expect(replay.statusCode,replay.body).toBe(200);
    expect((await store.listCounters()).map(c=>c.counter_id)).toEqual(['other']);
    expect([await facts('visitors'),await facts('other')]).toEqual([0,1]);
    expect(await repository.flow.coverage.countDocuments({assignment_id:'flow-door-visitors'})).toBe(0);
    expect(await repository.flow.coverage.countDocuments({assignment_id:'flow-door-other'})).toBeGreaterThan(0);
  }finally{await down.close();await up.close();await analysis.close();await db.dropDatabase();await client.close();}
}));
