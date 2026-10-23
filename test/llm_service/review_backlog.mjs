// Isolated Mongo burst/FIFO/restart test. Fake inference avoids loading another model.
import {MongoClient} from '../../alarm-service/node_modules/mongodb/lib/index.js';
import {evaluate} from '../../alarm-service/src/engine.mjs';
import {ReviewWorker} from '../../alarm-service/src/review-worker.mjs';
import {reviewFor} from '../../alarm-service/src/review-worker.mjs';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const mongo=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:5000});await mongo.connect();
const db=mongo.db('ainvr_backlog_test_'+Date.now()),events=db.collection('alarms');
const policy={enabled:true,version:1,profile_id:'alarm-review-zh-v1',description:'核对目标',reject_below:.05,approve_above:.95};
const rule={id:'backlog-test',version:1,name:'backlog',channel_id:'c',state:'enabled',geometry_revision:'g',label_map_version:'l',label_ids:['person'],labels:[{label_id:'person',name:'人'}],behavior:'appearance',review:policy};
const source={width:640,height:320,geometry_revision:'g',coordinate_space:'source_pixels'};
const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:'1',frame_id:'1',source_pts_ns:'1',source_frame_index:'1',captured_at:'2026-10-23T00:00:00Z',source,model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',event_eligible:true,last_observed_pts_ns:'1',bbox:{x:100,y:100,w:50,h:50}}]};
const [base]=evaluate(null,frame,[rule]).events;
let seen=[];
const options={qualification:async()=>true,context:{image:async()=>({data:Buffer.from('fake-model-test')})},invoke:async req=>{seen.push(req.alarm.kind);return {schema:'ainvr.alarm_review.v1',model:{package_sha256:'a'.repeat(64)},real_score:.99}}};
let worker=new ReviewWorker({events},options);
try{
 await worker.initialize();const rows=Array.from({length:200},(_,i)=>{const row=structuredClone(base);row.alarm_id='backlog-'+String(i).padStart(4,'0');row.occurred_at=new Date(1792713600000+i*1000).toISOString();row.review={...reviewFor(row),generation:row.alarm_id,context_state:'ready'};row.handling={state:'unacknowledged',revision:0};return row;});
 // Insert in reverse order: processing must follow occurrence time, not insertion.
 await events.insertMany([...rows].reverse());assert.equal(await events.countDocuments({'handling.state':'unacknowledged'}),200);
 const order=[];const invoke=worker.invoke;worker.invoke=async(body,opts)=>{const active=await events.findOne({'review.state':'running'});order.push(active.alarm_id);return invoke(body,opts);};
 for(let i=0;i<30;i++)assert.equal(await worker.step(),true);
 await worker.close();
 // Human decisions during the backlog must prevent later AI work for these rows.
 await events.updateMany({alarm_id:{$in:rows.slice(50,70).map(r=>r.alarm_id)}},{$set:{'handling.state':'acknowledged','handling.disposition':'false_positive','handling.reviewed_by_kind':'human'},$inc:{'handling.revision':1}});
 const nextOptions={...options,invoke:async(body,opts)=>{const active=await events.findOne({'review.state':'running'});order.push(active.alarm_id);return invoke(body,opts);}};
 worker=new ReviewWorker({events},nextOptions);await worker.initialize();while(await worker.step()){}
 const expected=rows.filter((_,i)=>i<50||i>=70).map(r=>r.alarm_id);assert.deepEqual(order,expected);
 assert.equal(await events.countDocuments({'handling.reviewed_by_kind':'human'}),20);assert.equal(await events.countDocuments({'handling.reviewed_by_kind':'ai'}),180);assert.equal(await events.countDocuments({'handling.state':'unacknowledged'}),0);
 // A waiting model call must not hold up the producer's database write.
 let release,entered;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 worker.invoke=async()=>{entered();await gate;return {schema:'ainvr.alarm_review.v1',model:{package_sha256:'a'.repeat(64)},real_score:.99};};
 const fresh=id=>{const row=structuredClone(rows[0]);delete row._id;row.alarm_id=id;row.review.generation=id;return row;};
 await events.insertOne(fresh('blocked-model'));
 const running=worker.step();await started;
 let timer;
 try{await Promise.race([events.insertOne(fresh('new-while-reviewing')),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('producer blocked')),2000);})]);}
 finally{clearTimeout(timer);release();await running;}
 assert.equal(await events.countDocuments({alarm_id:'new-while-reviewing','handling.state':'unacknowledged'}),1);
 await worker.step();assert.equal((await events.findOne({alarm_id:'new-while-reviewing'})).handling.reviewed_by_kind,'ai');
 const report={passed:true,burst_persisted_before_review:200,ai_reviewed:180,human_reviewed_skipped:20,fifo_by_occurrence:true,restarted_worker_after:30,producer_write_during_waiting_model:true,production_database_modified:false,model_calls:'fake inference; workflow test only'};
 await writeFile('/home/sunrise/ainvr/test/results/review-backlog.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await worker.close();await db.dropDatabase();await mongo.close();}
