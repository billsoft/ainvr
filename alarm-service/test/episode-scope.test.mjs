import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
const rule=(id,label,version=1)=>({id,monitor_id:id,version,name:id,channel_id:'c',state:'enabled',label_ids:[label],geometry_revision:'g',label_map_version:'l',behavior:'appearance',anchor:'center',max_gap_ms:60000});
const frame=seq=>({schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:String(seq),source_pts_ns:String(seq*1000000000),captured_at:new Date(Date.UTC(2026,9,19,2,0,seq)).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(seq*1000000000),bbox:{x:490,y:490,w:20,h:20}}]});
test('editing a trigger the activity never used keeps the alarm open (no duplicate alarm)',()=>{
 const first=evaluate(null,frame(1),[rule('a','person'),rule('b','car')]);
 assert.equal(first.events.length,1);
 const next=evaluate(first.checkpoint,frame(2),[rule('a','person'),rule('b','car',2)]);
 assert.deepEqual(next.ended_episodes,[]);
 assert.ok(next.checkpoint.episodes.t);
});
test('adding another trigger to the channel keeps the open activity',()=>{
 const first=evaluate(null,frame(1),[rule('a','person')]);
 const next=evaluate(first.checkpoint,frame(2),[rule('a','person'),rule('b','car')]);
 assert.deepEqual(next.ended_episodes,[]);
});
test('changing a trigger the activity used still ends it',()=>{
 const first=evaluate(null,frame(1),[rule('a','person'),rule('b','car')]);
 const next=evaluate(first.checkpoint,frame(2),[rule('a','person',2),rule('b','car')]);
 assert.equal(next.ended_episodes[0].end_reason,'configuration_changed');
});


test('upgrading a legacy activity cannot forget an earlier rule when a later stage fires',()=>{
 const rules=[rule('a','person'),{...rule('b','person'),duration_ms:1000}];
 const first=evaluate(null,frame(1),rules);
 assert.equal(first.events.length,1);
 // Pre-upgrade checkpoints only know the channel-wide rule/window signatures.
 const legacy=first.checkpoint.episodes.t;
 delete legacy.used;
 legacy.rules_key=JSON.stringify([['a',1],['b',1]]);
 legacy.window_key=JSON.stringify(['always','always']);
 const later=evaluate(first.checkpoint,frame(2),rules);
 assert.equal(later.events.length,1);
 assert.equal(later.events[0].rule.id,'b');
 const changed=evaluate(later.checkpoint,frame(3),[{...rules[0],version:2},rules[1]]);
 assert.equal(changed.ended_episodes.length,1);
 assert.equal(changed.ended_episodes[0].end_reason,'configuration_changed');
});
