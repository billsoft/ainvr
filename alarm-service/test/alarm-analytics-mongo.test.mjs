import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {AlarmRepository} from '../src/repository.mjs';
import {queryAlarmAnalytics,ANALYTICS_LIMITS} from '../src/alarm-analytics.mjs';
const enabled=process.env.AINVR_ALARM_TEST_MONGO==='1';
const scope={from:'2026-10-01T00:00:00.000Z',to:'2026-10-02T00:00:00.000Z',timezone:'Asia/Shanghai',bucket:'hour'};
const now='2026-12-01T00:00:00.000Z';
const event=(id,extra={})=>({alarm_id:id,dedup_key:id,channel_id:'a',occurred_at:scope.from,ingested_at:now,behavior:'region_enter',rule:{id:'r',version:2,name:'历史规则',snapshot:{zone_id:'x',zone_name:'历史入口',sensitive:'not-public'}},handling:{state:'unacknowledged',revision:0},...extra});
async function isolated(run){
 const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI??'mongodb://127.0.0.1:27029',{serverSelectionTimeoutMS:3000});await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{const repo=new AlarmRepository(db,{clock:()=>now});await repo.initialize();await run(repo,db)}finally{try{await db.dropDatabase()}finally{await client.close()}}
}
test('Mongo: exact association, current audit, bounded catalog, immutable human timing and shared drilldown',{skip:!enabled},()=>isolated(async(repo,db)=>{
 const human=(disposition,ms)=>({state:'acknowledged',reviewed_by_kind:'human',disposition,acknowledged_at:new Date(Date.parse(scope.from)+ms).toISOString()});
 const rows=[
  event('multi',{trigger_id:'t1',stages:[{zone_id:'x',trigger_id:'t1'},{zone_id:'x',trigger_id:'t1'},{zone_id:'y',trigger_id:'t2'}],handling:human('handled',1000)}),
  event('human-false',{handling:human('false_positive',3000)}),
  event('pending'),
  event('ai',{handling:{state:'acknowledged',reviewed_by_kind:'ai'}}),
  event('unknown-person',{handling:{state:'acknowledged',disposition:'handled',acknowledged_at:scope.from}}),
  event('unknown-disposition',{handling:{state:'acknowledged',reviewed_by_kind:'human'}}),
  event('unacked-false',{handling:{state:'unacknowledged',disposition:'false_positive'}}),
  event('cross-channel',{channel_id:'b',trigger_id:'t1'}),
  event('unassociated',{rule:{id:'r',version:3,snapshot:{}},stages:[{zone_id:'',trigger_id:'nozone'}]}),
  event('bad-human-time',{handling:{state:'acknowledged',reviewed_by_kind:'human',disposition:'handled',acknowledged_at:'invalid'}}),
  event('human-negative',{handling:human('handled',-1)}),
  event('end',{occurred_at:scope.to}),event('before',{occurred_at:'2026-09-30T23:59:59.999Z'}),event('late',{ingested_at:'2026-12-01T00:00:00.001Z'})
 ];
 await repo.events.insertMany(rows);
 await db.collection('alarm_rule_snapshot').insertOne({_id:'active',rules:[{id:'current',trigger_id:'new-trigger',channel_id:'c',zone_id:'new-zone',zone_name:'现有入口',name:'现有规则',behavior:'appearance',alarm_enabled:true,secret:'nope'},{id:'r',channel_id:'a',zone_id:'x',zone_name:'入口已改名',name:'规则已改名',behavior:'region_enter'}]});
 const all=await repo.analytics(scope);
 assert.equal(all.total,11);assert.equal(all.pending,3);assert.equal(all.human_confirmed,3);assert.equal(all.human_false_positive,1);assert.equal(all.ai_reviewed,1);assert.equal(all.unknown_review,3);
 assert.equal(all.quality.wait.samples,2);assert.equal(all.quality.wait.unknown,2);assert.equal(all.quality.wait.median_ms,2000);assert.equal(all.quality.wait.p90_ms,3000);
 assert.equal(all.quality.false_positive_ratio,0.25);assert.equal(all.association.unassociated,1);assert.equal(all.trend.reduce((n,x)=>n+x.total,0),11);assert.equal(all.week[3][8],11);
 assert.ok(all.catalog.zones.some(x=>x.channel_id==='c'));assert.ok(all.catalog.zones.some(x=>x.channel_id==='a'&&x.zone_id==='y'));assert.ok(all.catalog.triggers.some(x=>x.trigger_id==='r'));
 assert.equal(all.catalog.triggers.find(x=>x.trigger_id==='r').name,'规则已改名');assert.equal(all.triggers.find(x=>x.trigger_id==='r').name,'历史规则');
 assert.equal(all.catalog.zones.find(x=>x.channel_id==='a'&&x.zone_id==='x').name,'入口已改名');assert.equal(all.zones.find(x=>x.channel_id==='a'&&x.zone_id==='x').name,'历史入口');
 assert.ok(!JSON.stringify(all).includes('sensitive'));assert.ok(!JSON.stringify(all).includes('secret'));
 const q={...scope,locations:[{channel_id:'a',zone_id:'x'}],trigger_id:'t1'};
 const a=await repo.analytics(q);assert.equal(a.total,1);assert.deepEqual(a.zones.map(x=>x.zone_id),['x']);assert.deepEqual(a.triggers.map(x=>x.trigger_id),['t1']);assert.equal(a.zones[0].total,1);assert.ok(a.catalog.zones.some(x=>x.zone_id==='y'));
 assert.equal((await repo.analytics({...q,trigger_id:'t2'})).total,0);
 assert.equal((await repo.analytics({...scope,locations:[{channel_id:'b',zone_id:'x'}],trigger_id:'t1'})).total,1);
 assert.equal((await repo.analytics({...scope,primary_type:'region_traverse'})).total,0);
 for(const audit of ['pending','human_confirmed','human_false_positive','ai_reviewed','unknown']){
  const query={...scope,audit};const r=await repo.analytics(query),l=await repo.list({status:'all',analytics:JSON.stringify(query)});assert.equal(l.items.length,r.total,audit);
 }
 const un=await repo.list({status:'all',analytics:JSON.stringify({...scope,association:'unassociated'})});assert.deepEqual(un.items.map(x=>x.alarm_id),['unassociated']);
 const humanList=await repo.list({status:'human',analytics:JSON.stringify(scope)});
 assert.ok(humanList.items.length>0);assert.ok(humanList.items.every(x=>x.handling.reviewed_by_kind==='human'));assert.ok(!humanList.items.some(x=>x.alarm_id==='unknown-person'));
 assert.ok((await repo.list({status:'human'})).items.some(x=>x.alarm_id==='unknown-person'),'legacy global human list remains compatible');
 const list=await repo.list({status:'all',analytics:JSON.stringify(q)});assert.deepEqual(list.items[0].rule.snapshot,{zone_id:'x'});assert.equal(list.items.length,a.total);
 assert.equal((await repo.list({status:'pending',analytics:JSON.stringify(q)})).items.length,0);
 assert.equal((await repo.list({status:'all',channel_id:'b',analytics:JSON.stringify(q)})).items.length,0);
 assert.equal((await repo.list({status:'all',from:scope.to,analytics:JSON.stringify(q)})).items.length,0);
 const first=await repo.list({status:'all',analytics:JSON.stringify(scope),limit:3});assert.ok(first.next_cursor);
 const second=await repo.list({status:'all',analytics:JSON.stringify({...scope,to:'2026-10-02T00:00:00Z'}),limit:3,cursor:first.next_cursor});assert.equal(new Set([...first.items,...second.items].map(x=>x.alarm_id)).size,6);
 await assert.rejects(()=>repo.list({status:'all',analytics:JSON.stringify({...scope,audit:'pending'}),cursor:first.next_cursor}),e=>e.code==='invalid_cursor');
 await assert.rejects(()=>queryAlarmAnalytics(repo,scope,{limits:{...ANALYTICS_LIMITS,facts:2}}),e=>e.code==='analytics_capacity');
 await assert.rejects(()=>queryAlarmAnalytics(repo,scope,{limits:{...ANALYTICS_LIMITS,groups:1}}),e=>e.code==='analytics_capacity');
 await assert.rejects(()=>queryAlarmAnalytics(repo,scope,{limits:{...ANALYTICS_LIMITS,catalog:1}}),e=>e.code==='analytics_capacity');
  await assert.rejects(()=>queryAlarmAnalytics(repo,scope,{limits:{...ANALYTICS_LIMITS,bytes:1}}),e=>e.code==='analytics_capacity');
}));
test('Mongo: DST buckets, timezone weekday/hour, clipped boundaries and nearest-rank percentiles',{skip:!enabled},()=>isolated(async(repo)=>{
 const q={from:'2026-11-01T04:15:00.000Z',to:'2026-11-01T09:15:00.000Z',timezone:'America/New_York',bucket:'hour'};
 const times=['2026-11-01T04:15:00.000Z','2026-11-01T05:10:00.000Z','2026-11-01T06:10:00.000Z','2026-11-01T07:10:00.000Z','2026-11-01T09:14:59.999Z',q.to];
 await repo.events.insertMany(times.map((at,i)=>event('dst'+i,{occurred_at:at,handling:{state:'acknowledged',reviewed_by_kind:'human',disposition:'handled',acknowledged_at:new Date(Date.parse(at)+(i+1)*1000).toISOString()}})));
 const r=await repo.analytics(q);assert.equal(r.total,5);assert.deepEqual(r.trend.map(x=>x.total),[1,1,1,1,0,1]);assert.equal(r.quality.wait.median_ms,3000);assert.equal(r.quality.wait.p90_ms,5000);
 const repeated={...q,weekday:6,hour:1};const rr=await repo.analytics(repeated);assert.equal(rr.total,2);assert.equal((await repo.list({status:'all',analytics:JSON.stringify(repeated)})).items.length,2);
 const day=await repo.analytics({...q,bucket:'day',from:'2026-11-01T04:00:00.000Z',to:'2026-11-02T05:00:00.000Z'});assert.equal(day.trend.length,1);assert.equal(Date.parse(day.trend[0].to)-Date.parse(day.trend[0].from),25*3600000);
 await repo.events.insertMany([event('spring1',{occurred_at:'2026-03-08T06:30:00.000Z'}),event('spring2',{occurred_at:'2026-03-08T07:30:00.000Z'})]);
 const spring=await repo.analytics({...q,from:'2026-03-08T05:00:00.000Z',to:'2026-03-08T09:00:00.000Z'});assert.deepEqual(spring.trend.map(x=>x.total),[0,1,1,0]);
 const nepal={...scope,timezone:'Asia/Kathmandu',from:'2026-10-01T00:10:00.000Z',to:'2026-10-01T02:20:00.000Z'};
 await repo.events.insertMany([event('nepal1',{occurred_at:'2026-10-01T00:14:00.000Z'}),event('nepal2',{occurred_at:'2026-10-01T00:16:00.000Z'})]);
 assert.deepEqual((await repo.analytics(nepal)).trend.map(x=>x.total),[1,1,0,0]);
 const lordHowe={...scope,timezone:'Australia/Lord_Howe',from:'2026-04-04T14:00:00.000Z',to:'2026-04-04T16:30:00.000Z'};
 await repo.events.insertMany(['2026-04-04T14:15:00.000Z','2026-04-04T14:45:00.000Z','2026-04-04T15:15:00.000Z','2026-04-04T15:45:00.000Z','2026-04-04T16:15:00.000Z'].map((at,i)=>event('lord'+i,{occurred_at:at})));
 const lord=await repo.analytics(lordHowe);assert.deepEqual(lord.trend.map(x=>x.total),[2,1,2]);
}));
