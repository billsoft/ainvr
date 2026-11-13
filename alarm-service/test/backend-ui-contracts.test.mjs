import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {AlarmRepository,boundedFaceSummary} from '../src/repository.mjs';
import {alarmRepositoryFor} from '../src/alarm-access.mjs';
import {makeFaceWatchlistAlarm} from '../src/face-watchlist-candidate.mjs';
import {candidate} from './face-watchlist-fixture.mjs';

test('face list summary has a bounded allowlist and rejects malformed values',()=>{
  const id='12345678-1234-1234-1234-123456789abc';
  assert.deepEqual(boundedFaceSummary({record_id:id,library_name:'库'.repeat(256),member_name:'成员',similarity:0.9,threshold:0.8,embedding:[1,2],space_id:'secret',url:'https://private'}),
    {record_id:id,library_name:'库'.repeat(256),member_name:'成员',similarity:0.9,threshold:0.8});
  for(const bad of [null,[],{record_id:'../../private',library_name:'x'.repeat(257),member_name:'name\nsecret',similarity:Infinity,threshold:'0.8'},
    {record_id:123,library_name:'  ',member_name:'a\x7fb',similarity:-1.1,threshold:1.1}])assert.equal(boundedFaceSummary(bad),undefined);
  assert.deepEqual(boundedFaceSummary({similarity:-1,threshold:1}),{similarity:-1,threshold:1});
});

// Fixed isolated port and unique database; never consume a production URI.
test('Mongo lists normalize default/filter/drilldown categories and emit only authorized face summaries',
  {skip:process.env.AINVR_BACKEND_FIX_TEST_MONGO!=='1',timeout:30000},async t=>{
  const client=new MongoClient('mongodb://127.0.0.1:27932/?directConnection=true',{serverSelectionTimeoutMS:3000});
  const name='ainvr_backend_ui_test_'+randomUUID().replaceAll('-','');
  assert.match(name,/^ainvr_backend_ui_test_[a-f0-9]{32}$/);
  let db;t.after(async()=>{try{if(db)await db.dropDatabase();}finally{await client.close();}});
  await client.connect();db=client.db(name);
  const from='2026-11-12T00:00:00.000Z',to='2026-11-13T00:00:00.000Z';
  const repository=new AlarmRepository(db,{clock:()=>to});await repository.initialize();
  const face={...makeFaceWatchlistAlarm(candidate()),occurred_at:from,ingested_at:from};
  face.analysis_evidence.face.library_name='测试名单';face.analysis_evidence.face.member_name='测试成员';
  face.analysis_evidence.face.embedding=['DO_NOT_LEAK'];face.analysis_evidence.face.extra='DO_NOT_LEAK';
  face.face_summary={member_name:'FORGED_SUMMARY'};
  const record=(id,extra={})=>({alarm_id:id,dedup_key:id,channel_id:'camera',occurred_at:from,ingested_at:from,behavior:'appearance',rule:{id:'r',version:1,snapshot:{zone_id:'z'}},handling:{state:'unacknowledged',revision:0},face_summary:{member_name:'FORGED_SUMMARY'},...extra});
  await repository.events.insertMany([face,record('legacy'),record('plate',{analysis_evidence:{vehicle:{reason:'watchlist_match'}}}),record('ocr',{analysis_evidence:{vehicle:{reason:'ocr_candidate'}}}),record('fire',{event_kind:'fire_smoke'})]);
  const ordinary=alarmRepositoryFor(repository,'console-local'),scope={from,to,timezone:'UTC',bucket:'day'};
  for(const filters of [{},{event_kind:'face_watchlist'},{analytics:JSON.stringify({...scope,event_kind:'face_watchlist'})}]){
    const page=await repository.list({status:'all',...filters});
    const row=page.items.find(x=>x.alarm_id===face.alarm_id);
    assert.deepEqual(row.face_summary,boundedFaceSummary(face.analysis_evidence.face));
    assert.equal(row.evidence.refs[0].record_id,row.face_summary.record_id);
    assert.ok(page.items.every(x=>!Object.hasOwn(x,'analysis_evidence')));
    assert.equal(JSON.stringify(page).includes('DO_NOT_LEAK'),false);
    assert.equal(JSON.stringify(page).includes('FORGED_SUMMARY'),false);
    const local=await ordinary.list({status:'all',...filters});
    assert.ok(local.items.every(x=>!x.face_summary&&x.alarm_id!==face.alarm_id));
    assert.equal(JSON.stringify(local).includes('测试成员'),false);
  }
  const expected={legacy:'spatial',plate:'vehicle_watchlist',ocr:'spatial',fire:'fire_smoke',[face.alarm_id]:'face_watchlist'};
  const seen=[];let cursor;
  do{
    const page=await repository.list({status:'all',limit:2,cursor});
    for(const row of page.items){assert.equal(row.event_kind,expected[row.alarm_id]);seen.push(row.alarm_id);}
    cursor=page.next_cursor;assert.ok(seen.length<=5);
  }while(cursor);
  assert.equal(new Set(seen).size,5);
  for(const [kind,count] of [['spatial',2],['vehicle_watchlist',1],['fire_smoke',1]]){
    const query={...scope,event_kind:kind};
    const filtered=await repository.list({status:'all',event_kind:kind});
    const drilldown=await repository.list({status:'all',analytics:JSON.stringify(query)});
    assert.equal(filtered.items.length,count);assert.deepEqual(filtered.items.map(x=>x.alarm_id),drilldown.items.map(x=>x.alarm_id));
    assert.equal((await repository.analytics(query)).total,count);
  }
  // Details retain their original evidence contract.
  assert.equal((await repository.get(face.alarm_id)).analysis_evidence.face.record_id,face.analysis_evidence.face.record_id);
});
