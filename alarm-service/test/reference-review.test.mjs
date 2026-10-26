import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {ReferenceReviewWorker} from '../src/reference-review.mjs';
import {AlarmRepository} from '../src/repository.mjs';
const uri=process.env.AINVR_REVIEW_TEST_MONGO_URI;
test('reference worker is newest first, fenced against humans, bounded and never acknowledges',{skip:!uri},async()=>{
 const client=new MongoClient(uri);await client.connect();const db=client.db('ainvr_reference_test_'+randomUUID().replaceAll('-','')),rows=db.collection('alarms');
 const make=(id,at)=>({alarm_id:id,occurred_at:at,handling:{state:'unacknowledged',revision:0},review:{state:'waiting_validation',policy:{enabled:true}},version:1});
 let clock=1000,effect=async()=>{},score=.99;const seen=[];
 const worker=new ReferenceReviewWorker({rows,clock:()=>clock,image:async r=>{seen.push(r.alarm_id);return {label:'人',sha256:'a'}},prepare:async()=>({data:Buffer.from('jpeg'),sha256:'b',key:'b'}),invoke:async()=>{await effect();return {schema:'ainvr.alarm_review.v1',real_score:score,model:{package_sha256:'a'.repeat(64)}}}});
 try{
  await rows.insertMany([{...make('disabled','2026-10-26T00:00:00Z'),review:{policy:{enabled:false}}},{...make('full','2026-10-26T00:00:00Z'),review:{policy:{enabled:true},context_state:'ready'}}]);
  await rows.insertMany([make('b','2026-10-25T02:00:00Z'),make('a','2026-10-25T03:00:00Z')]);
  await worker.step();assert.equal(seen[0],'a');let row=await rows.findOne({alarm_id:'a'});assert.equal(row.handling.state,'unacknowledged');assert.equal(row.review.state,'waiting_validation');assert.equal(row.review.reference.state,'completed');
  effect=()=>rows.updateOne({alarm_id:'b'},{$set:{'handling.state':'acknowledged','handling.reviewed_by_kind':'human','handling.disposition':'handled'},$inc:{'handling.revision':1}});
  await worker.step();row=await rows.findOne({alarm_id:'b'});assert.equal(row.handling.reviewed_by_kind,'human');assert.equal(row.review.reference.state,'skipped');
  effect=async()=>{};score=.001;await rows.insertOne(make('c','2026-10-25T03:00:00Z'));await worker.step();row=await rows.findOne({alarm_id:'c'});assert.equal(row.review.reference.score,.001);assert.equal(row.handling.state,'unacknowledged');
  await rows.insertOne(make('d','2026-10-25T04:00:00Z'));effect=async()=>{throw Error('offline')};await worker.step();assert.equal((await rows.findOne({alarm_id:'d'})).review.reference.state,'queued');assert.equal(await worker.step(),false);
  clock+=40000;await worker.step();clock+=80000;await worker.step();assert.equal((await rows.findOne({alarm_id:'d'})).review.reference.state,'failed');assert.equal(await worker.step(),false);
  await rows.insertOne({...make('expired','2026-10-25T05:00:00Z'),review:{policy:{enabled:true},reference:{state:'running',lease_until:0,attempt:1}}});effect=async()=>{};await worker.step();assert.equal((await rows.findOne({alarm_id:'expired'})).review.reference.state,'completed');
 }finally{await db.dropDatabase();await client.close()}
});
test('alarm filters combine status, source, conclusion, channel, behavior and dates',{skip:!uri},async()=>{
 const client=new MongoClient(uri);await client.connect();const db=client.db('ainvr_filter_test_'+randomUUID().replaceAll('-',''));const repo=new AlarmRepository(db);
 try{
  const docs=[];for(const channel of ['front','back'])for(const behavior of ['appearance','region_approach','region_enter','region_traverse'])for(const kind of ['pending','human','ai'])for(const disposition of ['handled','false_positive'])docs.push({alarm_id:randomUUID(),channel_id:channel,behavior,occurred_at:'2026-10-20T10:00:00Z',ingested_at:'2026-10-20T10:00:01Z',handling:kind==='pending'?{state:'unacknowledged',disposition:'unset'}:{state:'acknowledged',reviewed_by_kind:kind,disposition},version:1});
  await repo.events.insertMany(docs);
  const summary=await repo.pendingSummary();assert.equal(summary.pending,16);assert.equal(summary.reference.counts.waiting,16);assert.equal(summary.reference.active,false);
  await db.collection('alarm_reference_runtime').insertOne({_id:'reference',expires_at:Date.now()+30000});assert.equal((await repo.pendingSummary()).reference.active,true);
  await repo.events.updateOne({'handling.state':'unacknowledged'},{$set:{'review.state':'running','review.reference.state':'completed'}});
  assert.equal((await repo.pendingSummary()).reference.counts.running,1);
  for(const status of ['pending','human','ai','all'])for(const channel_id of ['front','back'])for(const behavior of ['appearance','region_approach','region_enter','region_traverse']){
   const page=await repo.list({status,channel_id,behavior,from:'2026-10-20T00:00:00Z',to:'2026-10-21T00:00:00Z'});assert.equal(page.items.length,status==='all'?6:2);assert.ok(page.items.every(r=>r.channel_id===channel_id&&r.behavior===behavior));
   if(status==='human'||status==='ai')for(const disposition of ['handled','false_positive']){const p=await repo.list({status,channel_id,behavior,disposition});assert.equal(p.items.length,1);assert.equal(p.items[0].handling.reviewed_by_kind,status);assert.equal(p.items[0].handling.disposition,disposition)}
  }
  assert.equal((await repo.list({from:'2026-10-21T00:00:00Z'})).items.length,0);
  assert.equal((await repo.list({status:'pending',disposition:'handled'})).items.length,0);
  const first=await repo.list({status:'all',limit:7});const second=await repo.list({status:'all',limit:7,cursor:first.next_cursor});assert.equal(new Set([...first.items,...second.items].map(r=>r.alarm_id)).size,14);
  await assert.rejects(repo.list({status:'human',cursor:first.next_cursor}),/Cursor/);
 }finally{await db.dropDatabase();await client.close()}
});
