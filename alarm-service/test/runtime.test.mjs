import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {MongoClient} from 'mongodb';
import {validateConfig,loadConfig} from '../src/runtime.mjs';
const base={schema_version:'1.0',version:3,operation_id:'test-apply',host:'127.0.0.1',port:29999,
  mongo_uri:'mongodb://127.0.0.1:27028',database:'ainvr_alarm_test_config',api_token:'operator-test-'.repeat(4),producer_token:'producer-test-'.repeat(4)};
test('runtime config rejects unsafe listeners, unknown options, shared credentials and public files',async()=>{
  for(const changes of [{host:'0.0.0.0'},{port:0},{database:'admin'},{version:0},{unexpected:true},{producer_token:base.api_token}])assert.throws(()=>validateConfig({...base,...changes}));
  const dir=await mkdtemp(join(tmpdir(),'alarm-config-test-'));
  try{
    const path=join(dir,'config.json');await writeFile(path,JSON.stringify(base),{mode:0o600});
    assert.equal((await loadConfig(path)).version,3);
    await writeFile(join(dir,'public.json'),JSON.stringify(base),{mode:0o644});
    if(process.platform!=='win32')await assert.rejects(()=>loadConfig(join(dir,'public.json')),/private/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('independent process persists across forced restart and reports exact config instance', {skip:process.env.AINVR_ALARM_TEST_MONGO!=='1',timeout:30000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alarm-runtime-test-'));
  const client=new MongoClient(base.mongo_uri,{serverSelectionTimeoutMS:3000});
  const database='ainvr_alarm_test_'+randomUUID().replaceAll('-','');
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const config={...base,port,database};const path=join(dir,'config.json');let child,output='';
  const headers={authorization:`Bearer ${base.api_token}`,'x-ainvr-actor':'test-operator','content-type':'application/json'};
  const request=async(route,method='GET',body)=>{const response=await fetch(`http://127.0.0.1:${port}${route}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const launch=async()=>{
    child=spawn(process.execPath,['src/main.mjs',path],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)throw Error('Service exited before ready');
      try{const r=await request('/readyz');if(r.status===200)return;}catch{}
      await new Promise(r=>setTimeout(r,50));
    }throw Error('Service readiness timed out');
  };
  try{
    await client.connect();await writeFile(path,JSON.stringify(config),{mode:0o600});await launch();
    const before=(await request('/v1/status')).body;
    assert.equal(before.config.applied_version,3);assert.equal(before.config.operation_id,'test-apply');assert.equal(before.storage.writable,true);
    assert.equal(before.input.lag_ms,null);
    const rule={id:'r',version:1,name:'Appearance',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'appearance'};
    assert.equal((await request('/v1/rules','POST',{rule,expected_version:0})).status,405);
    assert.equal((await request('/v1/configuration/rules','POST',{schema_version:'1.0',revision:'1',rules:[rule]})).status,200);
    const envelope={schema_version:'1.0',producer_id:'test-producer',offset:'1',frame:{schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:'1',frame_id:'s:1',source_pts_ns:'1000000000',captured_at:'2026-10-19T00:00:00Z',source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:'1000000000',bbox:{x:100,y:100,w:100,h:200}}]}};
    const produce=async()=>{const response=await fetch(`http://127.0.0.1:${port}/v1/observations`,{method:'POST',headers:{authorization:`Bearer ${base.producer_token}`,'content-type':'application/json'},body:JSON.stringify(envelope)});assert.equal(response.status,200);return response.json();};
    const created=await produce();assert.equal(created.durable,true);assert.equal(created.events.length,1);
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;await launch();
    const after=(await request('/v1/status')).body;
    assert.notEqual(before.instance_id,after.instance_id);assert.notEqual(before.counter_epoch,after.counter_epoch);
    assert.equal((await request('/v1/rules')).body.items.length,1);
    assert.equal((await produce()).outcome,'already_consumed');
    assert.equal(await client.db(database).collection('alarms').countDocuments(),1);
    const persisted=(await request(`/v1/events/${created.events[0]}`)).body;
    assert.equal(persisted.alarm_id,created.events[0]);assert.equal(persisted.logs.length,1);
    assert.equal(output.includes(base.api_token),false);assert.equal(output.includes(base.mongo_uri),false);
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
    await client.db(database).dropDatabase();await client.close();await rm(dir,{recursive:true,force:true});
  }
});
