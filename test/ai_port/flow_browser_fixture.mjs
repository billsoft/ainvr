// Isolated browser acceptance: real arming routes/store, fixture AI catalog.
// Read-only live FLV from two fixed SRS paths; all configuration writes stay in isolated PG.
import {createRequire} from 'node:module';
import {Readable} from 'node:stream';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root='/home/sunrise/ainvr';
const candidate=process.argv[2];
if(!/^\/mnt\/ainvr-ssd\/(ainvr-alarm-refactor-web-|ainvr-passage-web-|ainvr-flow-counter-web-)/.test(candidate??'')||path.resolve(candidate)!==candidate)throw Error('Isolated candidate path required');
const status=JSON.parse(await readFile(path.join(candidate,'status.json'),'utf8'));
if(status.phase!=='passed'||status.deployment_performed!==false)throw Error('Verified undeployed candidate required');
const backend=path.join(candidate,'source/srs-web-console/backend');
const frontend=path.join(candidate,'source/srs-web-console/frontend/dist');
const require=createRequire(path.join(backend,'package.json'));
const Fastify=require('fastify'),{Pool}=require('pg');
const {AlarmArmingStore}=await import(pathToFileURL(path.join(backend,'dist/store/alarmArmingStore.js')));
const {alarmArmingRoutes}=await import(pathToFileURL(path.join(backend,'dist/routes/alarmArmingRoutes.js')));
const connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
const schema='browser_'+randomUUID().replaceAll('-','');
const admin=new Pool(connection);await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({...connection,options:`-c search_path=${schema}`});
for(const name of ['003_alarm_zones.sql','004_alarm_monitors.sql','005_alarm_triggers.sql','006_alarm_migration_review.sql','007_alarm_arming_storage.sql'])
 await pool.query(await readFile(path.join(backend,'dist/store/migrations',name),'utf8'));
const store=new AlarmArmingStore(pool);
for(const name of ['009_flow_counters.sql','010_flow_counter_library.sql','011_flow_counter_history.sql'])await pool.query(await readFile(path.join(backend,'dist/store/migrations',name),'utf8'));
const {flowRoutes}=await import(pathToFileURL(path.join(backend,'dist/routes/flowRoutes.js')));
const {AlarmRuleSync}=await import(pathToFileURL(path.join(backend,'dist/services/alarmRuleSync.js')));
const alarmRequire=createRequire(root+'/alarm-service/package.json');
const {MongoClient}=alarmRequire('mongodb');
const {AlarmRepository}=await import(pathToFileURL(root+'/alarm-service/src/repository.mjs'));
const {ObservationConsumer}=await import(pathToFileURL(root+'/alarm-service/src/ingestion.mjs'));
const {createApp}=await import(pathToFileURL(root+'/alarm-service/src/http.mjs'));
const mongo=new MongoClient('mongodb://127.0.0.1:27028');await mongo.connect();
const mongoDb=mongo.db('ainvr_flow_browser_'+randomUUID().replaceAll('-',''));
const repository=new AlarmRepository(mongoDb);await repository.initialize();
const consumer=new ObservationConsumer(repository),apiToken=randomUUID()+randomUUID();
const analysis=createApp({repository,apiToken});await analysis.listen({host:'127.0.0.1',port:28448});
const flowConnection=async()=>({baseUrl:'http://127.0.0.1:28448',apiToken,timeoutMs:15000});
const synchronization=new AlarmRuleSync(store,flowConnection);
const live=await (await fetch('http://127.0.0.1:1985/api/v1/streams/',{signal:AbortSignal.timeout(5000)})).json();
const liveInput=live.streams.find(s=>s.app==='live'&&s.name==='xm'&&s.publish.active);
const liveOutput=live.streams.find(s=>s.app==='live'&&s.name==='ai-n2q08c'&&s.publish.active);
if(!liveInput||!liveOutput)throw Error('Both existing live streams required; this fixture never creates them');
const {width,height}=liveInput.video;
if(liveOutput.video.width!==width||liveOutput.video.height!==height)throw Error('Expected unscaled AI output');
const geometry=`source-frame-v2:fixture-camera:g:${width}x${height}`;
const source={channel_id:'fixture-ai',channel_name:'验收处理器',input_stream_id:'fixture-camera',input_name:'验收画面',
 label_map_version:'fixture-labels',geometry_revision:geometry,tracking_available:true,width,height,
 stream_fingerprint:'a'.repeat(64),observed_at:'2026-10-20T00:00:00Z',
 labels:[{class_id:0,label_id:'person',name:'人员',description:''},{class_id:1,label_id:'fire',name:'火情',description:''},{class_id:2,label_id:'car',name:'车辆',description:''}]};
const app=Fastify({logger:false});
app.get('/__fixture/tablet',async(_req,reply)=>reply.type('text/html').send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe title="1024x768平板布局验收" src="/flow-statistics" style="width:1024px;height:768px;border:0;display:block"></iframe></body></html>')); 
await app.register(alarmArmingRoutes,{prefix:'/api',store,principal:async()=>'isolated-browser-test',
 catalog:async id=>id===source.channel_id?source:null,sourceGeometry:async id=>id===source.input_stream_id?geometry:null,
 synchronization});
await app.register(flowRoutes,{prefix:'/api',store,principal:async()=>'isolated-browser-test',catalog:async id=>id===source.channel_id?source:null,synchronization,connection:flowConnection});
await store.saveArming({source_id:source.input_stream_id,geometry_revision:geometry,zones:[{zone_id:'flow-door',channel_id:source.input_stream_id,geometry_revision:geometry,version:1,state:'active',name:'门口通行区',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],edge_ids:['top','right','bottom','left']}],assignments:[]},0,'fixture','initial-zone',async()=>source,async()=>geometry);
let seq=0;
app.post('/__fixture/replay',async req=>{
 const rules=(await store.snapshot()).rules;if(!rules.length)throw Error('Select a counter onto the zone in the UI first');
 await synchronization.synchronize();const base=Date.now();
 const coast=req.body?.coast===true,xs=coast?[.2,.4,.5,.6,.8,.6,.4,.2]:[.2,.4,.6,.8,.6,.4,.2];let index=0;
 for(const x of xs){
  const hidden=coast&&index++===3;
  seq++;const pts=String(seq*100000000),at=new Date(base+seq*100).toISOString();
  const envelope={schema_version:'1.0',producer_id:'fixture-producer',offset:String(seq),frame:{schema_version:'1.0',channel_id:source.channel_id,input_stream_id:source.input_stream_id,stream_session_id:'fixture-passage',seq:String(seq),frame_id:'fixture-'+seq,source_pts_ns:pts,captured_at:at,source:{width,height,coordinate_space:'source_pixels',geometry_revision:geometry},model:{label_map_version:source.label_map_version},tracks:[{track_id:'fixture-person',label_id:'person',state:'confirmed',observation:hidden?'predicted':'detected',last_observed_pts_ns:hidden?String((seq-1)*100000000):pts,event_eligible:!hidden,bbox:{x:x*width-10,y:.5*height-20,w:20,h:20}}]}};
  await consumer.consume(envelope);await consumer.consume(envelope);
 }
 return {facts:await repository.behaviors.collection.countDocuments(),alarms:await repository.events.countDocuments(),first_at:new Date(base).toISOString(),last_at:new Date(base+seq*100).toISOString()};
});
app.get('/api/auth/status',async()=>({code:0,data:{required:false}}));
app.post('/api/auth/media-session',async()=>({code:0,data:{}}));
app.get('/api/branding',async()=>({code:0,data:{productName:'AINVR · 隔离交互验收'}}));
// FIXTURE_PROTOCOL=flv plays over HTTP, which also works through an SSH port forward (WebRTC needs UDP).
const channels=[['fixture-camera','隔离验收 · 大门原画面','xm'],['fixture-output','隔离验收 · AI 输出','ai-n2q08c']].map(([id,name,streamName])=>({id,name,upstreamProtocol:'rtmp',streamName,app:'live',downstreamProtocols:['webrtc','flv'],primaryProtocol:process.env.FIXTURE_PROTOCOL==='flv'?'flv':'webrtc',inputGeneration:'g',createdAt:1792454400000,updatedAt:1792454400000,status:{online:true,clients:1,srsOnline:true,videoCodec:'H264',videoWidth:width,videoHeight:height}}));
app.get('/api/channels',async()=>({code:0,data:channels}));
app.get('/api/settings',async()=>({code:0,data:{monitorHardLimit:2,monitorSoftLimit:2,adminPasswordSet:false,aiService:{pollIntervalMs:15000}}}));
app.get('/api/summary',async()=>({code:0,data:{srsOnline:true,srsRtcHevc:false,serverTime:Date.now(),streams:{total:2,online:2,totalClients:0,totalBitrateKbps:0},channels:{total:2,online:2,offline:0}}}));
app.get('/api/ai/streams',async()=>({streams:[]}));
app.get('/api/ai/channels',async()=>({channels:[{id:source.channel_id,name:source.channel_name,state:'running',config:{stream:{url:'rtmp://127.0.0.1:1935/live/xm'},publish:{enabled:true,effective_target_url:'rtmp://127.0.0.1:1935/live/ai-n2q08c'}}}]}));
app.post('/rtc/v1/play/',async(req,reply)=>{
 const body=req.body;
 if(!body||typeof body.sdp!=='string'||body.sdp.length>200000||!['webrtc://127.0.0.1/live/xm','webrtc://127.0.0.1/live/ai-n2q08c'].includes(body.streamurl))return reply.code(422).send({error:'Only existing fixture streams allowed'});
 const upstream=await fetch('http://127.0.0.1:1985/rtc/v1/play/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({api:'http://127.0.0.1:1985/rtc/v1/play/',streamurl:body.streamurl,sdp:body.sdp}),signal:AbortSignal.timeout(10000)});
 return reply.code(upstream.status).send(await upstream.json());
});
app.get('/media/live/:file',async(req,reply)=>{
 if(!['xm.flv','ai-n2q08c.flv'].includes(req.params.file))return reply.code(404).send();
 const controller=new AbortController();reply.raw.on('close',()=>controller.abort());
 const response=await fetch(`http://127.0.0.1:8080/live/${req.params.file}`,{signal:controller.signal});
 if(!response.ok)return reply.code(502).send();
 return reply.type('video/x-flv').send(Readable.fromWeb(response.body));
});
app.get('/api/alarms/sources/:id',async(req,reply)=>req.params.id===source.channel_id?source:reply.code(404).send({error:'fixture source not found'}));
app.get('/api/alarms/zones',async()=>({items:[]}));
app.get('/api/alarms/behavior-statistics',async req=>({schema_version:'1.0',from:req.query.from,to:req.query.to,items:[],coverage:{state:'unknown',reason:'isolated UI fixture has no observations'}}));
app.get('/__fixture/evidence',async()=>({schema,definitions:await store.listDefinitions(),arming:await store.readArming(source.input_stream_id),snapshot:await store.snapshot(),counters:await store.listCounters(),facts:await repository.behaviors.collection.find({},{projection:{_id:0,analysis_evidence:0}}).toArray()}));
app.setNotFoundHandler(async(req,reply)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname.startsWith('/api/'))return reply.code(503).send({error:'Not provided by isolated UI fixture'});
 if(pathname.startsWith('/__arming/')){
  const harness=path.join(candidate,'arming-harness/dist');
  const target=path.resolve(harness,pathname.slice('/__arming/'.length)||'index.html');
  if(!target.startsWith(harness+path.sep))return reply.code(404).send();
  const type=target.endsWith('.html')?'text/html; charset=utf-8':target.endsWith('.js')?'text/javascript; charset=utf-8':target.endsWith('.css')?'text/css':'application/octet-stream';
  return reply.type(type).send(await readFile(target));
 }
 let file=path.resolve(frontend,'.'+pathname);
 if(!file.startsWith(frontend+path.sep))file=path.join(frontend,'index.html');
 try{if(!(await stat(file)).isFile())file=path.join(frontend,'index.html');}catch{file=path.join(frontend,'index.html');}
 const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
 reply.type(types[path.extname(file)]??'application/octet-stream');return await readFile(file);
});
let closing=false;
async function close(){if(closing)return;closing=true;await app.close();await analysis.close();await mongoDb.dropDatabase();await mongo.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
process.on('SIGTERM',()=>void close().then(()=>process.exit(0)));
process.on('SIGINT',()=>void close().then(()=>process.exit(0)));
await app.listen({host:'127.0.0.1',port:28447});
console.log(JSON.stringify({pid:process.pid,url:'http://127.0.0.1:28447/monitor',schema,candidate,fixture:true}));
