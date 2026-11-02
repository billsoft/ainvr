import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {EvidenceImages} from '../src/evidence-images.mjs';

// Capacity pruning runs on every image put. It must not pull the stored JPEGs
// off disk: the server profiler is the witness for what the real prune() asks.
const enabled=process.env.AINVR_ALARM_TEST_MONGO==='1';
const KB2=2048;
async function fixture(fn){
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI??'mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_prune_cost_'+randomUUID().replaceAll('-',''));
 try{await fn(db);}finally{await db.dropDatabase();await client.close();}
}
const row=(id,at)=>({_id:'context:'+id,pool:'context',key:id,data:Buffer.alloc(16),bytes:KB2,sha256:'x',created_at:new Date(at),occurred_at:'x',expires_at:new Date(Date.now()+1e7)});
async function finds(db){
 const entries=await db.collection('system.profile').find({ns:/alarm_evidence_images$/,op:'query'}).toArray();
 return entries.filter(e=>e.command?.sort);
}
const profiled=async(db,fn)=>{await db.command({profile:0});await db.collection('system.profile').drop().catch(()=>{});await db.command({profile:2});try{await fn();}finally{await db.command({profile:0});}};

test('a pool already within its byte budget is not scanned at all',{skip:!enabled,timeout:30000},()=>fixture(async db=>{
 const images=new EvidenceImages(db);await images.initialize();
 await images.rows.insertMany(Array.from({length:40},(_,i)=>row('a'+i,1e12+i)));
 await profiled(db,async()=>assert.equal(await images.prune('context',100*KB2,1e12),true));
 assert.deepEqual((await finds(db)).map(e=>e.planSummary),[],'prune opened an eviction scan although nothing needs evicting');
}));

test('eviction deletes the oldest first, ties by id, reading index keys only',{skip:!enabled,timeout:60000},()=>fixture(async db=>{
 const images=new EvidenceImages(db);await images.initialize();
 // Production databases still carry the former {pool,created_at} index next to the new one.
 await images.rows.createIndex({pool:1,created_at:1});
 const docs=[];
 for(let i=0;i<6;i++)docs.push(row('t0-'+i,1e12));            // same timestamp: order falls back to _id
 for(let i=0;i<3000;i++)docs.push(row('n'+String(i).padStart(4,'0'),1e12+1000+i));
 await images.rows.insertMany(docs);
 const total=docs.length;
 await profiled(db,async()=>assert.equal(await images.prune('context',(total-3)*KB2,1e12),true));
 const left=new Set((await images.rows.find({},{projection:{_id:1}}).toArray()).map(d=>d._id));
 assert.equal(left.size,total-3);
 for(const gone of ['context:t0-0','context:t0-1','context:t0-2'])assert.equal(left.has(gone),false,gone+' should be evicted first');
 for(const kept of ['context:t0-3','context:t0-5','context:n0000'])assert.equal(left.has(kept),true,kept+' must survive');
 const scans=await finds(db);
 assert.equal(scans.length>=1,true,'an over-budget pool must run one eviction scan');
 for(const s of scans){
  assert.equal(s.hasSortStage??false,false,'eviction sort must come from the index, not memory');
  assert.equal(s.docsExamined??0,0,'eviction scan must be answered from the index without fetching JPEG documents');
  assert.ok((s.keysExamined??0)<=600,'eviction scan must stay bounded by its batch, saw '+s.keysExamined+' keys');
 }
}));
