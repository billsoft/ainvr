// Cross-service integration, deliberately outside alarm-service's standalone npm test.
// Requirements: Node.js 26+, alarm-service dependencies, and backend dependencies
// INCLUDING devDependencies (TypeScript). Run from the repository root:
// node --test --test-concurrency=1 test/ptz/preset-pause-engine-regression.mjs
// Optional real Mongo: AINVR_ALARM_TEST_MONGO=1; default endpoint 127.0.0.1:27028.
// Mongo tests create/drop ONLY their own random ainvr_alarm_test_* database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {registerHooks,createRequire} from 'node:module';
import ts from '../../srs-web-console/backend/node_modules/typescript/lib/typescript.js';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {evaluate} from '../../alarm-service/src/engine.mjs';
import {dwellStep} from '../../alarm-service/src/dwell-visits.mjs';
import {measuredCoverage,FlowStatistics} from '../../alarm-service/src/flow-statistics.mjs';
import {RuleSnapshots} from '../../alarm-service/src/rule-snapshots.mjs';
import {createApp} from '../../alarm-service/src/http.mjs';
const alarmRequire=createRequire(new URL('../../alarm-service/package.json',import.meta.url));
const {MongoClient}=alarmRequire('mongodb');

// Execute current backend source, not a stale dist or a copied guard algorithm.
// PG I/O uses a fixture. Mongo I/O is in-memory unless explicitly enabled above.
// Never controls cameras or starts/restarts any service.
const backend=new URL('../../srs-web-console/backend/src/',import.meta.url).href;
const hooks=registerHooks({
  resolve(specifier,context,next){
    if(context.parentURL?.startsWith(backend)&&specifier.startsWith('.')&&specifier.endsWith('.js')){
      const ts=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
      if(existsSync(ts))return next(ts.href,context);
    }
    return next(specifier,context);
  },
  load(url,context,next){
    if(url.startsWith(backend)&&url.endsWith('.ts'))return {format:'module',shortCircuit:true,
      source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};
    return next(url,context);
  },
});
const {PtzGuardedSnapshot}=await import('../../srs-web-console/backend/src/services/ptzGuardedSnapshot.ts');
hooks.deregister();
const at=n=>new Date(Date.UTC(2026,10,21)+n*1000).toISOString();
const points=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
const rule=(kind='region_enter',channel='ptz')=>({id:`${channel}-${kind}`,name:kind,version:1,
  channel_id:channel,input_stream_id:`source-${channel}`,state:'enabled',label_ids:['person'],
  label_map_version:'labels',geometry_revision:'geometry',anchor:'center',behavior:kind,
  zone_id:'zone',zone_version:1,points,duration_ms:kind==='appearance'?2000:0,
  ...(kind==='region_traverse'?{alarm_enabled:false,counter_id:'counter',assignment_id:`${channel}-${kind}`,trigger_version:1,edge_ids:['top','right','bottom','left']}:{}),
});
const frame=(seq,x=.5,channel='ptz')=>({schema_version:'1.0',channel_id:channel,input_stream_id:`source-${channel}`,
  stream_session_id:`session-${channel}`,seq:String(seq),frame_id:`${channel}:${seq}`,source_frame_index:String(seq),
  source_pts_ns:String(BigInt(seq)*1000000000n),captured_at:at(seq),
  source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'geometry'},
  model:{label_map_version:'labels'},tracks:[{track_id:'same-id',label_id:'person',state:'confirmed',observation:'detected',
    last_observed_pts_ns:String(BigInt(seq)*1000000000n),bbox:{x:x*1000-10,y:490,w:20,h:20}}]});
function fixture(rules){
  let revision=1,sceneRevision=1,changed=0,state='matched',hasScene=true;
  const history=[];
  const epoch=createHash('sha256').update('motor:1').digest('hex');
  const pool={async query(sql){
    if(sql.includes('arming_scene_history'))return {rows:structuredClone(history)};
    if(sql.includes('SELECT * FROM arming_scene_zones'))return {rows:hasScene?[{
      source_id:'source-ptz',processor_id:'ptz',zone_id:'zone',zone_version:1,geometry_revision:'geometry',
      binding_mode:'preset',state,epoch,resource:'motor',revision:sceneRevision,current_points:state==='matched'?points:null,changed_at:new Date(at(changed)),
    }]:[]};
    if(sql.includes('FROM alarm_configuration_revision'))return {rows:[{revision:String(revision),guards:[{
      resource:'motor',epoch:'1',blocked:true,sources:['source-ptz'],restored:null,changed:at(0),
    }]}]};
    throw Error('Unexpected SQL: '+sql);
  }};
  const source={async snapshot(){return {schema_version:'1.0',revision:String(revision),rules:structuredClone(rules)};}};
  const guard=new PtzGuardedSnapshot(source,pool,undefined,{invalidate:async()=>{}},async()=>{});
  return {snapshot:()=>guard.snapshot(),transition(next,n){state=next;changed=n;revision++;sceneRevision++;},
    unbind(n){hasScene=false;revision++;history.push({id:'9001',source_id:'source-ptz',processor_id:'ptz',
      zone_id:'zone',revision:sceneRevision,operation:'DELETE',recorded_at:new Date(at(n)),
      document:{source_id:'source-ptz',processor_id:'ptz',zone_id:'zone',resource:'motor',
        changed_at:at(changed),epoch,state,binding_mode:'preset'}});}};
}
function memorySnapshots(){
  let row=null;
  return new RuleSnapshots({collection:()=>({
    async findOne(){return structuredClone(row);},
    async insertOne(value){assert.equal(row,null);row=structuredClone(value);},
    async replaceOne(filter,value){assert.equal(row.revision,filter.revision);row=structuredClone(value);return {modifiedCount:1};},
  })},{clock:()=>at(0)});
}
async function step(cp,fixture,n,x=.5,channel='ptz'){
  const snapshot=await fixture.snapshot(),f=frame(n,x,channel);
  const out=evaluate(cp,f,snapshot.rules);
  const dwell=dwellStep(cp?.dwell,f,snapshot.rules,{previous:cp});
  out.checkpoint.dwell=dwell.state;out.dwell=dwell;
  return out;
}

test('count-only guard pauses the actual counter rule; fixed camera snapshot stays unchanged',async()=>{
  const counter=rule('region_traverse'),fixed=rule('appearance','fixed'),fx=fixture([counter,fixed]);
  fx.transition('pending',2);
  const snapshot=await fx.snapshot();
  assert.equal(snapshot.rules[0].alarm_enabled,false);
  assert.equal(snapshot.rules[0].state,'paused');
  assert.match(snapshot.rules[0].view_epoch,/^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.rules[1],fixed);
});

test('REGRESSION: count-only paused production snapshot must be accepted by execution snapshot API',async()=>{
  const fx=fixture([rule('region_traverse')]),execution=memorySnapshots();
  await execution.apply(await fx.snapshot(),'isolated-test');
  fx.transition('pending',2);
  const accepted=await execution.apply(await fx.snapshot(),'isolated-test');
  assert.equal(accepted.applied,true);
  assert.equal((await execution.current()).rules[0].state,'paused');
});

test('REGRESSION: new matched scene revision must apply without changing user rule version',async()=>{
  const fx=fixture([rule('region_traverse')]),execution=memorySnapshots();
  await execution.apply(await fx.snapshot(),'isolated-test');
  fx.transition('pending',2);fx.transition('matched',3);
  assert.equal((await execution.apply(await fx.snapshot(),'isolated-test')).applied,true);
});

test('actual snapshot HTTP route publishes enabled -> guarded paused -> preset matched at one authored version',async()=>{
  const base={...rule('region_traverse'),source_binding:{stream_fingerprint:'f'.repeat(64),input_stream_id:'source-ptz',
    geometry_revision:'geometry',label_map_version:'labels',width:1000,height:1000,not_before:at(0)}};
  const fx=fixture([base]),execution=memorySnapshots();
  const apiToken='isolated-operator-'.repeat(4),producerToken='isolated-producer-'.repeat(4);
  const app=createApp({apiToken,producerToken,consumer:{},repository:{ruleSnapshots:execution}});
  const publish=async body=>{
    const response=await app.inject({method:'POST',url:'/v1/configuration/rules',payload:body,
      headers:{authorization:`Bearer ${apiToken}`,'x-ainvr-actor':'isolated-test'}});
    assert.equal(response.statusCode,200,response.body);assert.equal(response.json().applied,true);
    return response.json();
  };
  try{
    await publish(await fx.snapshot());
    fx.transition('pending',2);await publish(await fx.snapshot());
    assert.equal((await execution.current()).rules[0].state,'paused');
    assert.equal((await execution.status()).rule_count,1,'counter-only is an execution rule');
    fx.transition('matched',3);
    const restored=await fx.snapshot();
    // Formal same-view recovery must retain the canonical authored polygon.
    assert.deepEqual(restored.rules[0].points,points);
    await publish(restored);
    assert.equal((await execution.current()).rules[0].version,1);
    assert.deepEqual((await execution.current()).rules[0].points,restored.rules[0].points);
    assert.equal((await execution.current()).rules[0].source_binding.not_before,at(3));
    await publish(restored); // byte-identical retry is idempotent
    fx.transition('matched',4);await publish(await fx.snapshot());
    assert.deepEqual((await execution.current()).rules[0].points,points);
  }finally{await app.close();}
});

const protectedRule=()=>({...rule('region_traverse'),view_epoch:'a'.repeat(64),view_not_before:at(1),
  source_binding:{stream_fingerprint:'f'.repeat(64),input_stream_id:'source-ptz',geometry_revision:'geometry',
    label_map_version:'labels',width:1000,height:1000,not_before:at(1)}});
const snapshot=(r,revision='1')=>({schema_version:'1.0',revision,rules:[r]});
for(const [name,mutate] of Object.entries({
  name:r=>{r.name='edited';},labels:r=>{r.label_ids=['car'];},anchor:r=>{r.anchor='bottom_center';},
  geometry:r=>{r.points=points.map(([x,y])=>[x+.001,y]);},
  duration:r=>{r.duration_ms=500;},zoneVersion:r=>{r.zone_version++;},zoneIdentity:r=>{r.zone_id='another';},
  counter:r=>{r.counter_id='other';},alarmPolicy:r=>{r.alarm_enabled=true;},
  triggerVersion:r=>{r.trigger_version++;},edgeIdentity:r=>{r.edge_ids=['a','b','c','d'];},
  sourceIdentity:r=>{r.source_binding.stream_fingerprint='e'.repeat(64);},
  sourceDimensions:r=>{r.source_binding.width=1920;},sourceBindingRemoval:r=>{delete r.source_binding;},
  viewTimeRegression:r=>{r.view_not_before=at(0);},sourceTimeRegression:r=>{r.source_binding.not_before=at(0);},
  viewTimeRemoval:r=>{delete r.view_not_before;},versionRegression:r=>{r.version=1;},
}))test(`authored/fence change remains rejected even with a new view epoch: ${name}`,async()=>{
  const execution=memorySnapshots(),base={...protectedRule(),version:2};
  await execution.apply(snapshot(base),'isolated-test');
  const edited={...structuredClone(base),view_epoch:'b'.repeat(64)};mutate(edited);
  await assert.rejects(execution.apply(snapshot(edited,'2'),'isolated-test'),e=>e.code==='rule_version_conflict');
  assert.equal((await execution.current()).revision,'1');
});

test('runtime exceptions cannot bypass same/global stale revisions or missing/unchanged epochs',async()=>{
  const execution=memorySnapshots(),base=protectedRule();await execution.apply(snapshot(base,'2'),'isolated-test');
  const changed={...base,state:'paused',view_epoch:'b'.repeat(64)};
  await assert.rejects(execution.apply(snapshot(changed,'2'),'isolated-test'),e=>e.code==='revision_conflict');
  await assert.rejects(execution.apply(snapshot(changed,'1'),'isolated-test'),e=>e.code==='stale_revision');
  for(const epoch of [base.view_epoch,undefined]){
    const edited={...base,points:points.map(([x,y])=>[x+.01,y]),view_epoch:epoch};
    await assert.rejects(execution.apply(snapshot(edited,'3'),'isolated-test'),e=>e.code==='rule_version_conflict');
  }
});

test('first guarded epoch is allowed; author edits still work with an incremented author version',async()=>{
  const execution=memorySnapshots(),base=rule('region_traverse');
  await execution.apply(snapshot(base),'isolated-test');
  const guarded={...base,state:'paused',view_epoch:'a'.repeat(64),view_not_before:at(2)};
  await execution.apply(snapshot(guarded,'2'),'isolated-test');
  const authored={...guarded,version:2,name:'new authored name'};
  assert.equal((await execution.apply(snapshot(authored,'3'),'isolated-test')).applied,true);
  for(const state of ['draft','archived'])await assert.rejects(
    execution.apply(snapshot({...authored,state},'4'),'isolated-test'),e=>e.code==='unsupported_rule');
});

test('REGRESSION: unbind matched preset to plain blocked guard keeps monotonic execution fences',async()=>{
  const base=protectedRule();delete base.view_epoch;delete base.view_not_before;
  const fixed=rule('appearance','fixed'),fx=fixture([base,fixed]),execution=memorySnapshots();
  fx.transition('matched',5);
  const bound=await fx.snapshot();await execution.apply(bound,'isolated-test');
  assert.equal(bound.rules[0].state,'enabled');assert.equal(bound.rules[0].view_not_before,at(5));
  fx.unbind(6);
  const unbound=await fx.snapshot();
  assert.equal(unbound.rules[0].state,'paused');
  assert.notEqual(unbound.rules[0].view_epoch,bound.rules[0].view_epoch);
  assert.equal(unbound.rules[0].version,bound.rules[0].version);
  assert.deepEqual(unbound.rules[0].points,bound.rules[0].points);
  assert.deepEqual(unbound.rules[1],fixed);
  assert.equal(unbound.rules[0].view_not_before,at(6),'unbind must publish its persisted time boundary');
  assert.equal(unbound.rules[0].source_binding.not_before,at(6));
  assert.equal((await execution.apply(unbound,'isolated-test')).applied,true);
});

test('real isolated Mongo persists count-only guard lifecycle and reloads paused/resumed/unbound snapshots',
  {skip:process.env.AINVR_ALARM_TEST_MONGO!=='1',timeout:15000},async()=>{
  const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI??'mongodb://127.0.0.1:27028',
    {serverSelectionTimeoutMS:3000});
  const dbName='ainvr_alarm_test_'+randomUUID().replaceAll('-','');
  await client.connect();const db=client.db(dbName);
  try{
    const base=protectedRule();delete base.view_epoch;delete base.view_not_before;
    const fx=fixture([base]),execution=new RuleSnapshots(db);
    const enabled=await fx.snapshot();await execution.apply(enabled,'isolated-test');
    fx.transition('pending',2);await execution.apply(await fx.snapshot(),'isolated-test');
    const reloadedPaused=await new RuleSnapshots(db).current();
    assert.equal(reloadedPaused.rules.length,1);assert.equal(reloadedPaused.rules[0].state,'paused');
    assert.equal(reloadedPaused.rules[0].alarm_enabled,false);
    fx.transition('matched',3);const resumed=await fx.snapshot();
    await new RuleSnapshots(db).apply(resumed,'isolated-test');
    const reloaded=new RuleSnapshots(db),row=await reloaded.current();
    assert.equal((await reloaded.status()).state,'applied');
    assert.equal(row.revision,resumed.revision);assert.equal(row.rules[0].state,'enabled');
    assert.equal(row.rules[0].version,base.version);assert.deepEqual(row.rules[0].points,points);
    fx.unbind(4);await reloaded.apply(await fx.snapshot(),'isolated-test');
    const unbound=await new RuleSnapshots(db).current();
    assert.equal(unbound.rules[0].state,'paused');assert.equal(unbound.rules[0].view_not_before,at(4));
    assert.equal(unbound.rules[0].source_binding.not_before,at(4));
    await assert.rejects(reloaded.apply(enabled,'isolated-test'),e=>e.code==='stale_revision');
    assert.equal(await db.collection('alarm_rule_snapshot').countDocuments(),1);
  }finally{
    // Only this randomly named test database belongs to this test.
    try{await db.dropDatabase();}finally{await client.close();}
  }
});

for(const pausedFrame of [true,false])test(`resume inside never invents entry/traversal/line (${pausedFrame?'with':'without'} paused observation)`,async()=>{
  for(const kind of ['region_enter','region_traverse','line']){
    const r=rule(kind==='line'?'region_traverse':kind);
    if(kind==='line')r.passage={kind:'line',edges:[3],max_gap_ms:1000};
    const fx=fixture([r]);let cp=(await step(null,fx,1,.2)).checkpoint;
    cp=(await step(cp,fx,2,kind==='region_traverse'?.5:.2)).checkpoint;
    fx.transition('pending',3);
    if(pausedFrame){const out=await step(cp,fx,3,.8);assert.equal(out.events.length,0);cp=out.checkpoint;}
    fx.transition('matched',pausedFrame?4:3);
    for(let n=pausedFrame?4:3;n<8;n++){
      const out=await step(cp,fx,n,.5);assert.equal(out.events.length,0,kind);cp=out.checkpoint;
    }
    if(kind==='region_traverse')assert.equal((await step(cp,fx,8,.8)).events.length,0,'inside at resume cannot prove prior entry');
  }
});

test('pause breaks alarm dwell and measured visits, while another fixed camera keeps its dwell',async()=>{
  const fx=fixture([rule('appearance'),rule('region_traverse'),rule('appearance','fixed')]);
  let ptz=null,fixed=null;
  for(let n=1;n<=2;n++){ptz=(await step(ptz,fx,n)).checkpoint;fixed=(await step(fixed,fx,n,.5,'fixed')).checkpoint;}
  fx.transition('pending',3);
  const paused=await step(ptz,fx,3);ptz=paused.checkpoint;
  assert.equal(paused.events.length,0);assert.equal(paused.dwell.facts.length,1);
  assert.equal(paused.dwell.facts[0].observed_ms,1000);
  assert.equal(paused.dwell.facts[0].ended_at,at(2));
  assert.equal(Object.keys(ptz.dwell.visits).length,0);
  const unaffected=await step(fixed,fx,3,.5,'fixed');assert.equal(unaffected.events.length,1);
  fx.transition('matched',4);
  for(let n=4;n<=6;n++){
    const out=await step(ptz,fx,n);ptz=out.checkpoint;
    assert.equal(out.events.length,n===6?1:0);
    assert.equal(Object.values(ptz.dwell.visits)[0].observed_ms,(n-4)*1000);
  }
});

test('paused interval has no measured coverage; resumed real crossing counts once',async()=>{
  const fx=fixture([rule('region_traverse')]);let cp=null;const segments=new Map();
  const consume=async(n,x)=>{const out=await step(cp,fx,n,x);cp=out.checkpoint;for(const s of out.coverage)segments.set(s.segment_id,s);return out;};
  await consume(1,.2);await consume(2,.5);fx.transition('pending',3);
  assert.equal((await consume(3,.8)).events.length,0);await consume(4,.2);
  assert.equal(Object.keys(cp.flow_coverage).length,0);
  const unknown=measuredCoverage([...segments.values()],at(3),at(5));
  assert.equal(unknown.state,'no_data');assert.equal(unknown.covered_ms,0);
  fx.transition('matched',5);
  assert.equal((await consume(5,.2)).events.length,0);
  assert.equal((await consume(6,.5)).events.length,0);
  assert.equal((await consume(7,.8)).events.length,1);
});

test('REGRESSION: unobserved pause/resume must split counter coverage at scene epoch',async()=>{
  const fx=fixture([rule('region_traverse')]);let cp=(await step(null,fx,1,.5)).checkpoint;
  cp=(await step(cp,fx,2,.5)).checkpoint;
  fx.transition('pending',2);fx.transition('matched',3);
  const resumed=await step(cp,fx,3,.5);
  assert.ok(resumed.issues.includes('view_changed'));
  assert.equal(Object.values(resumed.checkpoint.flow_coverage)[0].from,at(3));
  assert.equal(resumed.dwell.facts[0].observed_ms,1000);
  assert.equal(Object.values(resumed.checkpoint.dwell.visits)[0].observed_ms,0);
});

test('epoch break flushes throttled coverage tail, leaves unknown time, and keeps fixed counter continuous',async()=>{
  const fx=fixture([rule('region_traverse'),rule('region_traverse','fixed')]);
  let cp=null,fixed=null;const segments=new Map();
  const save=out=>{for(const s of out.coverage)segments.set(s.segment_id,s);cp=out.checkpoint;};
  for(let n=1;n<=3;n++){
    save(await step(cp,fx,n));fixed=(await step(fixed,fx,n,.5,'fixed')).checkpoint;
  }
  assert.equal([...segments.values()][0].to,at(2),'third sample is a throttled tail');
  fx.transition('pending',3);fx.transition('matched',4);
  const resumed=await step(cp,fx,4);save(resumed);
  assert.equal(resumed.coverage.length,2,'flush old tail and begin new segment');
  assert.equal([...segments.values()].find(s=>s.from===at(1)).to,at(3));
  assert.equal(measuredCoverage([...segments.values()],at(3),at(4)).state,'no_data');
  assert.equal(Object.values(cp.flow_coverage)[0].from,at(4));
  const unaffected=await step(fixed,fx,4,.5,'fixed');
  assert.equal(Object.values(unaffected.checkpoint.flow_coverage)[0].from,at(1));
  assert.ok(!unaffected.issues.includes('view_changed'));
  save(await step(cp,fx,5));
  assert.equal(measuredCoverage([...segments.values()],at(4),at(5)).covered_ms,1000);
  assert.equal(measuredCoverage([...segments.values()],at(3),at(4)).covered_ms,0);

  // Query the real statistics formatter with isolated storage I/O. Zero facts
  // must carry no_data, never the complete coverage needed for an observed zero.
  const cursor=rows=>({limit(){return this;},async toArray(){return rows;}});
  const stats=new FlowStatistics({collection:name=>({
    find:()=>cursor(name==='flow_coverage'?[...segments.values()]:[]),
    aggregate:()=>cursor([{totals:[]}]),
  })});
  const result=await stats.query({series:[{key:'paused',rule_id:'ptz-region_traverse',label_ids:['person'],
    filter:{kind:'edges',entry:['left'],exit:['right']},
    from:at(3),to:at(4)}]});
  assert.equal(result.items[0].occurrences,0);
  assert.equal(result.items[0].coverage.state,'no_data');
  assert.equal(result.items[0].coverage.ratio,0);
});
