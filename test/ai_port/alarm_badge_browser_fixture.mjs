// Isolated acceptance using frozen HTTP, proxy and UI; never production databases.
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {readFile,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [web,service]=process.argv.slice(2);
for(const candidate of [web,service]){
 if(!candidate?.startsWith('/mnt/ainvr-ssd/ainvr-alarm-refactor-')||path.resolve(candidate)!==candidate)throw Error('Frozen SSD candidate required');
 const s=JSON.parse(await readFile(path.join(candidate,'status.json'),'utf8'));if(s.phase!=='passed'||s.deployment_performed!==false)throw Error('Undeployed verified candidate required');
}
const backend=path.join(web,'source/srs-web-console/backend'),frontend=path.join(web,'source/srs-web-console/frontend/dist');
const require=createRequire(path.join(backend,'package.json')),Fastify=require('fastify');
const serviceRequire=createRequire(path.join(service,'release/package.json')),{MongoClient}=serviceRequire('mongodb');
const {AlarmRepository}=await import(pathToFileURL(path.join(service,'release/src/repository.mjs')));
const {createApp}=await import(pathToFileURL(path.join(service,'release/src/http.mjs')));
const {alarmProxyRoutes}=await import(pathToFileURL(path.join(backend,'dist/routes/alarmProxy.js')));
const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
const db=client.db('ainvr_alarm_browser_'+randomUUID().replaceAll('-','')),repo=new AlarmRepository(db);await repo.initialize();
for(let i=0;i<250;i++)await repo.insert({alarm_id:`browser-${String(i).padStart(3,'0')}`,dedup_key:`browser-${i}`,channel_id:'fixture-ai',occurred_at:'2020-01-01T00:00:00.000Z',last_seen_at:'2020-01-01T00:00:01.000Z',behavior:'appearance',rule:{id:'fixture-trigger',name:'浏览器验收触发器'},severity:'warning',lifecycle:{state:'ended'},handling:{state:i<10?'acknowledged':'unacknowledged',revision:0,disposition:i>=10&&i<20?'false_positive':'unset'},review:{state:i>=20&&i<30?'not_supported':'skipped'},version:1});
const apiToken=randomUUID()+randomUUID();
const alarm=createApp({repository:repo,apiToken});await alarm.listen({host:'127.0.0.1',port:28447});
const app=Fastify({logger:false});await app.register(alarmProxyRoutes,{prefix:'/api',connection:async()=>({baseUrl:'http://127.0.0.1:28447',apiToken,timeoutMs:5000}),principal:async()=>'isolated-browser-test'});
app.get('/api/auth/status',async()=>({code:0,data:{required:false}}));
app.post('/api/auth/media-session',async()=>({code:0,data:{}}));
app.get('/api/branding',async()=>({code:0,data:{productName:'AINVR · 隔离告警验收'}}));
app.get('/api/ai/channels',async()=>({channels:[{id:'fixture-ai',name:'验收处理器',state:'running',config:{}}]}));
app.get('/api/alarms/triggers',async()=>({items:[]}));
app.get('/__fixture/evidence',async()=>({database:db.databaseName,summary:await repo.pendingSummary(),acknowledged:await repo.events.countDocuments({'handling.state':'acknowledged'}),audits:await repo.events.countDocuments({'logs.actor':'isolated-browser-test'})}));
app.setNotFoundHandler(async(req,reply)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname.startsWith('/api/'))return reply.code(503).send({error:'Not provided in this isolated fixture'});
 let file=path.resolve(frontend,'.'+pathname);if(!file.startsWith(frontend+path.sep))file=path.join(frontend,'index.html');
 try{if(!(await stat(file)).isFile())file=path.join(frontend,'index.html');}catch{file=path.join(frontend,'index.html');}
 return reply.type(({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'})[path.extname(file)]??'application/octet-stream').send(await readFile(file));
});
let closing=false;async function close(){if(closing)return;closing=true;
 await writeFile('/home/sunrise/ainvr/test/results/alarm-badge-browser-evidence.json',JSON.stringify({web,service,production_changed:false,initial_pending:220,final_summary:await repo.pendingSummary(),acknowledged:await repo.events.countDocuments({'handling.state':'acknowledged'}),audits:await repo.events.countDocuments({'logs.actor':'isolated-browser-test'})},null,2));
 await app.close();await alarm.close();await db.dropDatabase();await client.close();}
process.on('SIGTERM',()=>void close().then(()=>process.exit(0)));
await app.listen({host:'127.0.0.1',port:28446});console.log(JSON.stringify({pid:process.pid,url:'http://127.0.0.1:28446/alarms',database:db.databaseName,initial_pending:220}));
