import test from 'node:test';
import assert from 'node:assert/strict';
import {AlarmRepository} from '../src/repository.mjs';

// Review checkpoints hold raw model responses (including base64 JPEGs) for
// retry reuse only. They and the worker lease token must never reach clients.
const stored=()=>({_id:'x',alarm_id:'a1',occurred_at:'2026-10-31T00:00:00.000Z',ingested_at:'2026-10-31T00:00:01.000Z',
 handling:{state:'unacknowledged',revision:0},operations:[{id:'op'}],
 review:{state:'running',generation:1,token:'lease-token',checkpoint:{version:1,binding:'b',entries:[{response:{prepared_image:{jpeg_base64:'AAAA'}}}]}}});
// Minimal emulation of Mongo exclusion projections, including dotted paths.
const exclude=(doc,projection)=>{
 const out=structuredClone(doc);
 for(const [path,flag] of Object.entries(projection)){
  if(flag!==0)continue;
  const keys=path.split('.'),last=keys.pop();let node=out;
  for(const k of keys)node=node?.[k];
  if(node&&typeof node==='object')delete node[last];
 }
 return out;
};
const assertPrivate=review=>{
 assert.ok(review,'review is still returned');
 assert.equal(review.state,'running');
 assert.equal('checkpoint' in review,false,'review.checkpoint leaked');
 assert.equal('token' in review,false,'review.token leaked');
};

test('get never returns the review checkpoint or lease token',async()=>{
 const events={findOne:async()=>stored()};
 const repo=new AlarmRepository({collection:()=>events},{clock:()=>'2026-10-31T00:00:05.000Z'});
 assertPrivate((await repo.get('a1')).review);
});

test('plain list projection hides the review checkpoint and lease token',async()=>{
 let pipeline;
 const events={aggregate:p=>{pipeline=p;return {toArray:async()=>[exclude(stored(),pipeline.find(s=>s.$project).$project)]}}};
 const repo=new AlarmRepository({collection:()=>events},{clock:()=>'2026-10-31T00:00:05.000Z'});
 const result=await repo.list({status:'all',limit:10});
 assertPrivate(result.items[0].review);
});

test('analytics-scoped list pipeline hides the review checkpoint and lease token',async()=>{
 let pipeline;
 const events={aggregate:p=>{pipeline=p;return {toArray:async()=>[exclude(stored(),pipeline.find(s=>s.$project).$project)]}}};
 const repo=new AlarmRepository({collection:()=>events},{clock:()=>'2026-10-31T00:00:05.000Z'});
 const result=await repo.list({status:'all',limit:10,analytics:JSON.stringify({from:'2026-10-31T00:00:00Z',to:'2026-11-01T00:00:00Z',timezone:'UTC',bucket:'hour'})});
 assertPrivate(result.items[0].review);
});

// Isolated integration database only; never read a production URI.
test('real Mongo excludes private review data from detail and both list scopes', {skip: process.env.AINVR_ALARM_ACCESS_TEST_MONGO !== '1', timeout:15000}, async t=>{
 const {MongoClient}=await import('mongodb');
 const {randomUUID}=await import('node:crypto');
 const client=new MongoClient('mongodb://127.0.0.1:27932/?directConnection=true',{serverSelectionTimeoutMS:3000});
 let db;
 t.after(async()=>{try{if(db)await db.dropDatabase()}finally{await client.close()}});
 await client.connect();db=client.db('ainvr_privacy_test_'+randomUUID().replaceAll('-',''));
 const repo=new AlarmRepository(db,{clock:()=>'2026-10-31T00:00:05.000Z'});
 await repo.events.insertOne(stored());
 const scopes=[{status:'all',limit:10},{status:'all',limit:10,analytics:JSON.stringify({from:'2026-10-31T00:00:00Z',to:'2026-11-01T00:00:00Z',timezone:'UTC',bucket:'hour'})}];
 const responses=[await repo.get('a1')];
 for(const scope of scopes){const result=await repo.list(scope);assert.equal(result.items.length,1);responses.push(result.items[0])}
 for(const response of responses){assertPrivate(response.review);assert.equal(JSON.stringify(response).includes('lease-token'),false);assert.equal(JSON.stringify(response).includes('jpeg_base64'),false)}
});
