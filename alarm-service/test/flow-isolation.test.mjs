import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
const rule=(id,alarm_enabled=true,version=1)=>({id,version,name:id,channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'appearance',alarm_enabled});
const frame=seq=>({schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:String(seq),source_pts_ns:String(seq*1000000000),captured_at:new Date(Date.UTC(2026,9,21,0,0,seq)).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(seq*1000000000),bbox:{x:10,y:10,w:10,h:10}}]});
test('statistics facts never create an alarm activity',()=>{
 const r=evaluate(null,frame(1),[rule('stats',false)]);
 assert.equal(r.events.length,1);assert.equal(r.events[0].episode_id,undefined);
 assert.deepEqual(r.checkpoint.episodes,{});
});
test('editing a used statistics source leaves the alarm activity unchanged',()=>{
 const r=evaluate(null,frame(1),[rule('alarm'),rule('stats',false)]);
 const next=evaluate(r.checkpoint,frame(2),[rule('alarm'),rule('stats',false,2)]);
 assert.deepEqual(next.ended_episodes,[]);
 assert.equal(next.checkpoint.episodes.t.id,r.checkpoint.episodes.t.id);
 assert.deepEqual(Object.keys(next.checkpoint.episodes.t.used),['alarm']);
});
test('legacy used map drops statistics references without discarding the open alarm',()=>{
 const r=evaluate(null,frame(1),[rule('alarm')]);
 r.checkpoint.episodes.t.used.stats={version:1,period:'"always"'};
 const next=evaluate(r.checkpoint,frame(2),[rule('alarm'),rule('stats',false,2)]);
 assert.deepEqual(next.ended_episodes,[]);
 assert.ok(next.checkpoint.episodes.t);
});
