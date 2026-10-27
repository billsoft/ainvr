/** Isolated browser/integration fixture. Never reads production settings or media APIs. */
import Fastify from '../../srs-web-console/backend/node_modules/fastify/fastify.js';
import pgPackage from '../../srs-web-console/backend/node_modules/pg/lib/index.js';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync,writeFileSync,mkdirSync,openSync,createReadStream} from 'node:fs';
import {resolve,join} from 'node:path';
import {PgConfigStore} from '../../srs-web-console/backend/src/store/pgStore.js';
import {JsonStore} from '../../srs-web-console/backend/src/store/jsonStore.js';
import {OnvifStore,defaultOnvifSettings} from '../../srs-web-console/backend/src/store/onvifStore.js';
import {OnvifManager} from '../../srs-web-console/backend/src/services/onvifManager.js';
import {ChannelService} from '../../srs-web-console/backend/src/services/channelService.js';
import {DEFAULT_SETTINGS} from '../../srs-web-console/backend/src/types/channel.js';
import {PtzStore} from '../../srs-web-console/backend/src/store/ptzStore.js';
import {PtzManager} from '../../srs-web-console/backend/src/services/ptzManager.js';
import {preparePtzAdapter} from '../../srs-web-console/backend/src/services/ptzAdapter.js';
import {PtzGuardedSnapshot} from '../../srs-web-console/backend/src/services/ptzGuardedSnapshot.js';
import {ptzAi} from '../../srs-web-console/backend/src/services/ptzAi.js';
import {AlarmRuleSync} from '../../srs-web-console/backend/src/services/alarmRuleSync.js';
import {ptzRoutes} from '../../srs-web-console/backend/src/routes/ptz.js';
import {onvifRoutes} from '../../srs-web-console/backend/src/routes/onvif.js';
const root=resolve(import.meta.dirname,'../..');
const directory=join(root,'test/results/ptz-20261027/fixture');mkdirSync(directory,{recursive:true});
const {Pool}=pgPackage,connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
const schema='ptz_fixture_'+randomUUID().replaceAll('-','');
const admin=new Pool(connection);await admin.query(`CREATE SCHEMA ${schema}`);
const pg=new PgConfigStore({poolConfig:{...connection,options:`-c search_path=${schema}`},masterKeyPath:join(directory,'master.key')});await pg.init();
const app=Fastify({logger:false});
const token='ptz-isolated-fixture-service-token-20261027';
const bootstrap=join(directory,'onvif-bootstrap.json');writeFileSync(bootstrap,JSON.stringify({listen:'127.0.0.1:28150',token}),{mode:0o600});
let protocol:any;
async function startProtocol(){
 protocol=spawn(join(root,'test/results/ptz-20261027/ainvr_onvif_fixture'),[bootstrap],{stdio:['ignore',openSync(join(directory,'protocol.log'),'a'),openSync(join(directory,'protocol.log'),'a')]});
 for(let n=0;n<100;n++){if(protocol.exitCode!==null)throw Error('Fixture protocol exited');try{const r=await fetch('http://127.0.0.1:28150/health',{headers:{'x-service-token':token},signal:AbortSignal.timeout(200)});if(r.ok)return}catch{}await new Promise(r=>setTimeout(r,50))}
 throw Error('Fixture protocol did not start');
}
await startProtocol();
const cameraIP=process.env.AINVR_PTZ_FIXTURE_CAMERA_IP??'192.168.100.189';
const store=new PtzStore(pg.pool),onvifStore=new OnvifStore(pg);
const channelStore=new JsonStore({filePath:join(directory,'channels-'+schema+'.json'),defaultData:{channels:[] as any[]},version:1});
const settings={...DEFAULT_SETTINGS,monitorHardLimit:9,aiService:{...DEFAULT_SETTINGS.aiService,baseUrl:'http://127.0.0.1:28088',apiKey:'fixture-ai-key'}};
const settingsStore=new JsonStore({filePath:join(directory,'settings-'+schema+'.json'),defaultData:settings,version:1});
const channels=new ChannelService({store:channelStore,settingsStore,srsClient:{listStreams:async()=>[],isOnline:async()=>false} as any,secrets:()=>pg});
const onvif=new OnvifManager(onvifStore,channels);
await onvifStore.saveSettings({...defaultOnvifSettings,enabled:true,serviceUrl:'http://127.0.0.1:28150',allowedCIDRs:[cameraIP+'/32']},1,token,'fixture');await onvif.apply();
const device=await onvifStore.saveDevice({name:'隔离模拟摄像头',url:`http://${cameraIP}:28551/device`,username:'fixture',password:'fixture-only',certificateSHA256:''},'fixture');
await onvif.probe(device.id);
const inputs:Record<string,any>={};
for(const [profileToken,videoSource]of [['main','camera-a'],['sub','camera-b'],['other','camera-c'],['zoom','camera-z'],['fixed','camera-f']]){
 const saved=await onvif.saveChannel({deviceId:device.id,deviceVersion:1,service:'media1',profileToken,videoSource},{name:{main:'入口主码流',sub:'入口子码流',other:'另一台云台',zoom:'仅变焦镜头',fixed:'固定摄像头'}[profileToken]!,downstreamProtocols:['hls','flv'],primaryProtocol:'hls',inputEnabled:true});inputs[profileToken]=await channels.getChannel(saved.id);
}
const aiChannels:any[]=[];
for(const [profile,id]of [['main','ai-a'],['sub','ai-b'],['other','ai-c']]){
 const out=await channels.createChannel({name:`${inputs[profile].name} AI 输出`,upstreamProtocol:'rtmp',streamName:'fixture-'+id,downstreamProtocols:['hls'],primaryProtocol:'hls'});
 aiChannels.push({id,name:id,state:'idle',analytics_reset_supported:true,config:{enabled:true,stream:{url:`rtmp://127.0.0.1:1935/live/${inputs[profile].streamName}`},publish:{enabled:true,effective_target_url:`rtmp://127.0.0.1:1935/live/${out.streamName}`}}});inputs[id]=out;
}
const rules=aiChannels.map((a,index)=>({id:a.id,name:a.id,version:1,channel_id:a.id,input_stream_id:inputs[['main','sub','other'][index]].id,state:'enabled',behavior:'appearance',duration_ms:0,label_ids:['person'],label_map_version:'fixture-labels',geometry_revision:'fixture-geometry',anchor:'center'}));
for(const profile of ['main','sub','other'])await pg.pool.query('INSERT INTO alarm_arming_sources(source_id,revision,document) VALUES($1,1,$2)',[inputs[profile].id,{source_id:inputs[profile].id}]);
delete (rules[1] as any).input_stream_id; // Exercise legacy protection through the actual source graph.
const resets:{id:string;generation:string;at:string}[]=[];let applied:any={schema_version:'1.0',revision:'0',rules:[]},hash='';
const {digest,validateRule}=await import(new URL('../../alarm-service/src/domain.mjs',import.meta.url).href);
app.post('/api/v1/channels/:id/analytics/reset',async(req,reply)=>{
 if(req.headers['x-api-key']!=='fixture-ai-key')return reply.code(401).send({});const b=req.body as any;if(b.reason!=='ptz_view_change'||typeof b.generation!=='string')return reply.code(422).send({});resets.push({id:(req.params as any).id,generation:b.generation,at:new Date().toISOString()});return {reset:true};
});
app.get('/api/v1/channels',()=>({channels:aiChannels}));
app.post('/v1/configuration/rules',async(req,reply)=>{if(req.headers.authorization!==`Bearer ${token}`)return reply.code(401).send({});const s=req.body as any;s.rules.forEach(validateRule);applied=structuredClone(s);hash=digest(s);return {applied:true,revision:s.revision,digest:hash}});
app.get('/v1/configuration/rules',()=>({state:'applied',revision:applied.revision,digest:hash}));
const source={snapshot:async()=>({schema_version:'1.0',revision:String((await pg.pool.query('SELECT revision FROM alarm_configuration_revision WHERE singleton')).rows[0].revision),rules})};
const guarded=new PtzGuardedSnapshot(source,pg.pool,async()=>({channels:(await channelStore.read()).channels,ai:aiChannels})),sync=new AlarmRuleSync(guarded,async()=>({baseUrl:'http://127.0.0.1:28088',apiToken:token,timeoutMs:2000}));
const ai=ptzAi(async()=>settings,pg,'http://127.0.0.1:28088');
const deps={channels:async()=>(await channelStore.read()).channels,ai:()=>ai.list(),prepare:root=>preparePtzAdapter(root,store,onvif,null),synchronize:()=>sync.synchronize(),resetProcessors:(ids:string[])=>ai.reset(ids),checkProcessors:(ids:string[])=>ai.checkReset(ids)};
let manager=new PtzManager(store,deps);
const principal=async(req:any)=>!req.headers['x-console-token']||req.headers['x-console-token']==='fixture-a'?'fixture-a':req.headers['x-console-token']==='fixture-b'?'fixture-b':null;
const options={manager,store,principal,channels:deps.channels};
await app.register(ptzRoutes,{...options,prefix:'/api'}); // closure below retains the registered manager for the test lifetime
await app.register(onvifRoutes,{store:onvifStore,manager:onvif,principal,ptzStore:store,ptzManager:manager,prefix:'/api'});
app.get('/api/channels',async()=>({code:0,data:(await channels.listChannels()).map(c=>({...c,status:{online:false,clients:0,srsOnline:false}}))}));
app.get('/api/ai/channels',()=>({channels:aiChannels}));app.get('/api/ai/streams',()=>({streams:[]}));
app.get('/api/gb28181/bindings',()=>({items:[]}));
app.get('/api/settings',()=>({code:0,data:{...settings,adminPasswordSet:false}}));
app.get('/api/summary',()=>({code:0,data:{srsOnline:false,srsVersion:'test-only',srsVersionLive:false,serverTime:Date.now()}}));
app.get('/api/ingest/capabilities',()=>({rtmp:{enabled:true},rtsp:{enabled:true},srt:{enabled:false},webrtc:{enabled:false}}));
app.get('/__fixture/protection',async()=>({rules:applied.rules,resetIds:resets.map(r=>r.id),resets,guards:await store.guards()}));
app.get('/__fixture/info',()=>({schema,inputs,device,protocolPID:protocol.pid}));
app.post('/__fixture/reset-support',async(req)=>{aiChannels[0].analytics_reset_supported=(req.body as any).supported===true;return {updated:true}});
app.post('/__fixture/rearm',async()=>{await pg.pool.query('UPDATE alarm_arming_sources SET updated_at=now()');return {saved:true}});
app.post('/__fixture/reconcile',async()=>{await manager.invalidate().catch(()=>undefined);await manager.observe();return {guards:await store.guards()}});
app.post('/__fixture/restart-protocol',async()=>{const stopped=once(protocol,'exit');protocol.kill('SIGKILL');await stopped;await startProtocol();await onvif.apply();return {restarted:true}});
app.get('/media/fixture/sample.m3u8',(_req,reply)=>reply.type('application/vnd.apple.mpegurl').send('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:60\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:60,\nsample.ts\n#EXT-X-ENDLIST\n'));
app.get('/media/fixture/sample.ts',(_req,reply)=>reply.type('video/mp2t').send(createReadStream(join(root,'out/gb28181/h264-aac.ts'))));
app.get('/health',()=>({fixture:true,ready:true}));
await app.listen({host:'127.0.0.1',port:28088});
writeFileSync(join(directory,'state.json'),JSON.stringify({schema,inputs,device,pid:process.pid,protocolPID:protocol.pid},null,2));
console.log('Isolated PTZ fixture ready');
let closing=false;async function close(){if(closing)return;closing=true;await app.close();if(protocol.exitCode===null){const stopped=once(protocol,'exit');protocol.kill('SIGTERM');await stopped}await pg.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();process.exit(0)}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
