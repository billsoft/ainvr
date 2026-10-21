// Isolated browser acceptance: real arming routes/store, fixture AI catalog.
// Never import production settings, call hardware services or bind publicly.
import {createRequire} from 'node:module';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root='/home/sunrise/ainvr';
const candidate=process.argv[2];
if(!candidate?.startsWith('/mnt/ainvr-ssd/ainvr-alarm-refactor-web-')||path.resolve(candidate)!==candidate)throw Error('Isolated candidate path required');
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
const geometry='source-frame-v2:fixture-camera:g:1920x1080';
const source={channel_id:'fixture-ai',channel_name:'验收处理器',input_stream_id:'fixture-camera',input_name:'验收画面',
 label_map_version:'fixture-labels',geometry_revision:geometry,tracking_available:true,width:1920,height:1080,
 stream_fingerprint:'a'.repeat(64),observed_at:'2026-10-20T00:00:00Z',
 labels:[{class_id:0,label_id:'person',name:'人员',description:''},{class_id:1,label_id:'fire',name:'火情',description:''},{class_id:2,label_id:'car',name:'车辆',description:''}]};
const app=Fastify({logger:false});
await app.register(alarmArmingRoutes,{prefix:'/api',store,principal:async()=>'isolated-browser-test',
 catalog:async id=>id===source.channel_id?source:null,sourceGeometry:async id=>id===source.input_stream_id?geometry:null,
 synchronization:null});
app.get('/api/auth/status',async()=>({code:0,data:{required:false}}));
app.post('/api/auth/media-session',async()=>({code:0,data:{}}));
app.get('/api/branding',async()=>({code:0,data:{productName:'AINVR · 隔离交互验收'}}));
app.get('/api/ai/channels',async()=>({channels:[{id:source.channel_id,name:source.channel_name}]}));
app.get('/api/alarms/sources/:id',async(req,reply)=>req.params.id===source.channel_id?source:reply.code(404).send({error:'fixture source not found'}));
app.get('/api/alarms/zones',async()=>({items:[]}));
app.get('/api/alarms/behavior-statistics',async req=>({schema_version:'1.0',from:req.query.from,to:req.query.to,items:[],coverage:{state:'unknown',reason:'isolated UI fixture has no observations'}}));
app.get('/__fixture/evidence',async()=>({schema,definitions:await store.listDefinitions(),arming:await store.readArming(source.input_stream_id),snapshot:await store.snapshot()}));
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
async function close(){if(closing)return;closing=true;await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
process.on('SIGTERM',()=>void close().then(()=>process.exit(0)));
process.on('SIGINT',()=>void close().then(()=>process.exit(0)));
await app.listen({host:'127.0.0.1',port:28446});
console.log(JSON.stringify({pid:process.pid,url:'http://127.0.0.1:28446/alarm-analysis',schema,candidate,fixture:true}));
