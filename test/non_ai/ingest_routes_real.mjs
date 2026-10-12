// AINVR: production channel/WHIP modules with real SRS and isolated PostgreSQL.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {readFile, writeFile, unlink, open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(root, '/home/sunrise/ainvr');
const result=process.env.AINVR_INGEST_TEST_RESULT;
const work=process.env.AINVR_INGEST_TEST_WORK;
assert(result?.startsWith(root+'/test/results/ingest-routes-'));
assert(work?.startsWith('/mnt/ainvr-ssd/test-media/ingest-routes-'));
const pgUser=process.env.AINVR_INGEST_TEST_PG_USER;
assert(/^ainvr_whip_[a-f0-9]{16}$/.test(pgUser));
const require=createRequire(root+'/srs-web-console/backend/package.json');
const Fastify=require('fastify');
const dist=root+'/srs-web-console/backend/dist';
const {JsonStore}=await import(dist+'/store/jsonStore.js');
const {PgConfigStore}=await import(dist+'/store/pgStore.js');
const {ChannelService}=await import(dist+'/services/channelService.js');
const {SrsClient}=await import(dist+'/services/srsClient.js');
const {WhipSessions}=await import(dist+'/services/whipSessions.js');
const {channelRoutes}=await import(dist+'/routes/channels.js');
const {ingestRoutes}=await import(dist+'/routes/ingest.js');
const {DEFAULT_SETTINGS}=await import(dist+'/types/channel.js');
const pg=new PgConfigStore({poolConfig:{host:'127.0.0.1',port:5432,
  user:pgUser,password:process.env.AINVR_INGEST_TEST_PG_PASSWORD,database:pgUser},
  masterKeyPath:work+'/private-test-master.key'});
const channels=new JsonStore({filePath:work+'/channels.json',defaultData:{channels:[]},version:1});
const settings=new JsonStore({filePath:work+'/settings.json',defaultData:DEFAULT_SETTINGS,version:1});
const children=[];
const owned=[];
const extraStreams=[];
const credentialFiles=[];
let app, sessions, base, relayPort, shuttingDown=false;
const records=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const limits=AbortSignal.timeout;
async function wait(predicate,seconds,message) {
  const until=performance.now()+seconds*1000;
  while(performance.now()<until) {
    if(shuttingDown)throw new Error('Fixture cancelled');
    const value=await predicate(); if(value)return value; await sleep(200);
  }
  throw new Error(message);
}
async function streams() {
  const r=await fetch('http://127.0.0.1:1985/api/v1/streams/',{signal:limits(5000)});
  assert.equal(r.status,200); return (await r.json()).streams;
}
async function published(name) {
  return (await streams()).find(s=>s.app==='live' && s.name===name && s.publish?.active);
}
function groupAlive(child) {
  if(!child.pid)return false;
  try {process.kill(-child.pid,0);return true;}
  catch(error){if(error.code==='ESRCH')return false;throw error;}
}
async function stop(child) {
  if(!groupAlive(child))return;
  try {process.kill(-child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
  let deadline=performance.now()+5000;
  while(groupAlive(child) && performance.now()<deadline)await sleep(100);
  if(groupAlive(child)) {
    process.kill(-child.pid,'SIGKILL');
    deadline=performance.now()+5000;
    while(groupAlive(child) && performance.now()<deadline)await sleep(100);
  }
  assert(!groupAlive(child),'Owned media process group survived cleanup');
}
process.on('SIGTERM',()=>{shuttingDown=true;});
process.on('SIGINT',()=>{shuttingDown=true;});
async function launch(args,label) {
  const log=await open(result+'/'+label+'.log','w',0o600);
  const env={...process.env,LD_LIBRARY_PATH:'/usr/hobot/lib',GSETTINGS_BACKEND:'memory'};
  delete env.AINVR_INGEST_TEST_PG_PASSWORD;
  const child=spawn(args[0],args.slice(1),{env,detached:true,stdio:['ignore',log.fd,log.fd]});
  await log.close(); children.push(child);
  child.on('error',()=>{});
  return child;
}
async function run(args,label,seconds) {
  const child=await launch(args,label);
  try {
    await wait(()=>child.exitCode!==null || child.signalCode!==null,seconds,label+' timeout');
    assert.equal(child.exitCode,0,label+' failed; see fixture log');
  } finally {await stop(child);}
}
async function buildRelay() {
  const local=Fastify();
  sessions=new WhipSessions(()=>pg,'http://127.0.0.1:1985');
  const client=new SrsClient({apiHost:'127.0.0.1:1985',cacheTtlMs:0,timeoutMs:3000});
  const service=new ChannelService({store:channels,settingsStore:settings,srsClient:client,
    secrets:()=>pg,stopPublisher:id=>sessions.terminate(id),
    withPublisherLock:(id,action)=>sessions.exclusive(id,action)});
  // This is an isolated route fixture. Production console authentication and
  // license hooks are distinct gates; neither is changed or bypassed here.
  await local.register(channelRoutes,{prefix:'/api',channelService:service,
    inputReady:async protocol=>protocol==='webrtc' && !!pg});
  await local.register(ingestRoutes,{channels,settings,secrets:()=>pg,
    token:randomBytes(32).toString('hex'),workerUrl:'http://127.0.0.1:1',
    srsUrl:'http://127.0.0.1:1985',srtEnabled:true,sessions});
  await local.listen({host:'127.0.0.1',port:relayPort??0});
  relayPort=local.server.address().port;
  base='http://127.0.0.1:'+relayPort;
  app=local;
}
let lanIp;
async function request(route,method='GET',body,authorization) {
  const headers={host:lanIp+':'+relayPort};
  if(authorization)headers.authorization=authorization;
  if(body!==undefined)headers['content-type']='application/json';
  const r=await fetch(base+route,{method,headers,
    body:body===undefined?undefined:JSON.stringify(body),signal:limits(12000)});
  const text=await r.text();return {status:r.status,body:text?JSON.parse(text):null};
}
async function offer(route,token,sdp) {
  const headers={host:lanIp+':'+relayPort,'content-type':'application/sdp'};
  if(token)headers.authorization='Bearer '+token;
  const r=await fetch(base+route,{method:'POST',headers,body:sdp,signal:limits(12000)});
  await r.text();return r.status;
}
async function sender(id,token,label,codec) {
  const credential=work+'/'+label+'.credential';credentialFiles.push(credential);
  await writeFile(credential,token,{flag:'wx',mode:0o600});
  // Match nginx preserving the real LAN Host used to choose ICE candidates.
  // The isolated HTTP listener itself stays on loopback.
  return launch(['/usr/bin/python3',root+'/ingest-service/tests/media_probe.py',
    'whip','--codec',codec,'--url',base+'/ingest/whip/'+id,'--http-host',lanIp+':'+relayPort,
    '--credential-file',credential,'--seconds','150',
    '--result',result+'/'+label+'-sender.json'],label+'-sender');
}
const report={passed:false,cases:records,production_route_modules:true,
  real_postgresql:true,real_srs:true,synthetic_cpu_encoder_is_fixture_only:true,
  inference_executed:false,production_console_login_verified:false,
  actual_browser_playback_verified:false};
try {
  await pg.init();
  const ipChild=await launch(['/sbin/ip','-j','address','show','eth0'],'interface');
  await wait(()=>ipChild.exitCode!==null,5,'IP query failed');assert.equal(ipChild.exitCode,0);
  const interfaces=JSON.parse(await readFile(result+'/interface.log','utf8'));
  lanIp=interfaces.flatMap(x=>x.addr_info).find(x=>x.family==='inet').local;
  await buildRelay();
  for(const codec of ['h264','h265']) {
    const name='ainvr-route-'+pgUser.slice(-16)+'-'+codec;
    assert(!(await published(name)));
    const created=await request('/api/channels','POST',{name:'TEST ONLY '+codec,
      upstreamProtocol:'webrtc',streamName:name,downstreamProtocols:['webrtc','flv']});
    assert.equal(created.status,201);const id=created.body.data.id;owned.push({id,name});
    const route='/api/channels/'+id;
    assert.equal((await request('/api/channels','POST',{name:'duplicate',
      upstreamProtocol:'webrtc',streamName:name,downstreamProtocols:['flv']})).status,409);
    const credential=await request(route+'/publish-credential','POST');
    assert.equal(credential.status,200);const token=credential.body.data.token;
    assert.equal(await pg.getSecret('backend/ingest-publish/'+id),token);
    const encrypted=await pg.pool.query('SELECT ciphertext FROM config_secrets WHERE key_path=$1',
      ['backend/ingest-publish/'+id]);
    assert.equal(encrypted.rows.length,1);
    assert(!String(encrypted.rows[0].ciphertext).includes(token));
    const whip='/ingest/whip/'+id;
    assert.equal(await offer(whip,null,'v=0\r\n'),401);
    assert.equal(await offer(whip,'invalid-token','v=0\r\n'),401);
    assert.equal(await offer(whip,token,'a=rtpmap:96 VP8/90000\r\n'),415);
    const first=await sender(id,token,codec+'-initial',codec);
    const active=await wait(async()=>{
      assert(first.exitCode===null && first.signalCode===null,'Sender exited before publishing');
      const s=await published(name);return s?.video_frames>=30?s:false;
    },30,'Initial real WHIP video absent');
    const expected=codec==='h264'?'H264':'HEVC';
    assert.equal(active.video.codec.toUpperCase(),expected);
    const view=await request(route);assert.equal(view.status,200);
    assert(view.body.data.status.online && view.body.data.status.inputState==='streaming');
    assert.equal(view.body.data.status.videoWidth,640);assert.equal(view.body.data.status.videoHeight,320);
    const transport=result+'/'+codec+'-transport.json';
    await run(['runuser','-u','sunrise','--',root+'/out/build/ai-ffmpeg8/ainvr_stream_source_sei_probe',
      'rtmp://127.0.0.1:1935/live/'+name,transport],codec+'-transport',75);
    const evidence=JSON.parse(await readFile(transport,'utf8'));
    extraStreams.push(evidence.temporary_output_stream);
    assert(evidence.passed && evidence.source_hardware_decoded_frames>=12);
    assert(evidence.output_evidence.verified_sei_frames>=12 && evidence.output_evidence.vpu_decoded_frames>=3);
    assert(evidence.vcl_payloads_match_after_annexb_padding_normalization && !evidence.video_reencoded);
    const parser=result+'/'+codec+'-browser-parser.json';
    await run([process.execPath,'--experimental-strip-types',root+'/test/ai_port/verify_browser_sei.mts',
      transport,parser],codec+'-parser',20);
    assert(JSON.parse(await readFile(parser,'utf8')).passed);
    const oldSession=await sessions.get(id);assert(oldSession);
    await app.close();app=null;await buildRelay();
    assert.equal((await sessions.get(id)).key,oldSession.key);
    await wait(async()=>{
      const s=await published(name);return s?.publish.cid===active.publish.cid && s.video_frames>active.video_frames?s:false;
    },10,'Video interrupted by isolated relay restart');
    const rotated=await request(route+'/publish-credential','POST');assert.equal(rotated.status,200);
    const newToken=rotated.body.data.token;assert.notEqual(newToken,token);
    await wait(async()=>!(await published(name)),10,'Rotation did not revoke real SRS publisher');
    assert.equal(await offer(whip,token,'a=rtpmap:96 H264/90000\r\n'),401);
    await stop(first);
    const firstEvidence=JSON.parse(await readFile(result+'/'+codec+'-initial-sender.json','utf8'));
    assert.equal(firstEvidence.status,201);
    const second=await sender(id,newToken,codec+'-rotated',codec);
    const republished=await wait(async()=>{
      const s=await published(name);return s?.video_frames>=30 && s.publish.cid!==active.publish.cid?s:false;
    },30,'New credential did not publish');
    assert.equal(republished.video.codec.toUpperCase(),expected);
    assert.equal((await request(route)).body.data.status.online,true);
    const deleted=await request(route,'DELETE');assert.equal(deleted.status,204);
    await wait(async()=>!(await published(name)),10,'Channel deletion did not stop its publisher');
    assert.equal(await pg.getSecret('backend/ingest-publish/'+id),null);
    assert.equal(await sessions.get(id),null);
    assert.equal((await request(route)).status,404);
    await stop(second);
    const secondEvidence=JSON.parse(await readFile(result+'/'+codec+'-rotated-sender.json','utf8'));
    assert.equal(secondEvidence.status,201);
    // Sender DELETE after credential rotation/channel deletion must be rejected.
    assert.equal(firstEvidence.delete_status,undefined);assert.equal(firstEvidence.delete_error,'HTTPError');
    assert.equal(secondEvidence.delete_status,undefined);assert.equal(secondEvidence.delete_error,'HTTPError');
    assert(!firstEvidence.errors.length && !secondEvidence.errors.length);
    const record={codec,passed:true,channel_created_http:201,duplicate_stream_http:409,
      wrong_and_absent_credentials_http:401,unsupported_codec_http:415,
      initial_publish_http:201,rotated_publish_http:201,credential_encrypted_in_pg:true,
      relay_instance_recreated:true,same_publisher_survived_relay_restart:true,
      credential_rotation_stopped_publisher:true,old_credential_rejected:true,
      channel_delete_http:204,channel_delete_stopped_publisher:true,secrets_removed:true,
      source_vpu_frames:evidence.source_hardware_decoded_frames,
      output_vpu_frames:evidence.output_evidence.vpu_decoded_frames,
      sei_frames:evidence.output_evidence.verified_sei_frames,
      production_browser_parser:true,compressed_vcl_unchanged:true,transport_evidence:transport};
    records.push(record);console.log(JSON.stringify(record));
  }
  assert.equal((await channels.read()).channels.length,0);
  const row=await pg.pool.query('SELECT count(*)::int AS n FROM config_secrets');
  assert.equal(row.rows[0].n,0);
  report.passed=true;
} catch(error) {
  // Log only our assertion/fixture errors, never tokens, SDP, SQL parameters.
  report.error_type=error.constructor.name;
  report.error_message=error.message;
  console.error(error.stack);
} finally {
  let cleanup=true;
  for(const child of children)await stop(child).catch(()=>{cleanup=false;});
  for(const {id,name} of owned) {
    await sessions?.terminate(id).catch(()=>{cleanup=false;});
    if(await published(name))cleanup=false;
  }
  if((await streams()).some(s=>extraStreams.includes(s.name) && s.publish?.active))cleanup=false;
  for(const file of credentialFiles)await unlink(file).catch(e=>{if(e.code!=='ENOENT')cleanup=false;});
  await app?.close().catch(()=>{cleanup=false;});
  await pg.close().catch(()=>{cleanup=false;});
  report.all_owned_processes_and_publishers_stopped=cleanup && children.every(c=>!groupAlive(c));
  report.temporary_credential_files_removed=cleanup;
  report.passed=report.passed && report.all_owned_processes_and_publishers_stopped;
  const hashes={};
  for(const file of ['routes/channels.js','routes/ingest.js','services/whipSessions.js','services/channelService.js','store/pgStore.js'])
    hashes[file]=createHash('sha256').update(await readFile(dist+'/'+file)).digest('hex');
  report.production_module_sha256=hashes;
  report.sender_shutdown_diagnostics=[];
  for(const {codec} of records)for(const phase of ['initial','rotated']) {
    const label=codec+'-'+phase;
    const log=await readFile(result+'/'+label+'-sender.log','utf8');
    if(log.includes('GStreamer-CRITICAL'))report.sender_shutdown_diagnostics.push(label);
  }
  await writeFile(result+'/summary.json',JSON.stringify(report,null,2)+'\n');
}
process.exitCode=report.passed?0:1;
