import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
const base={id:'r',version:1,name:'r',channel_id:'c',state:'enabled',label_ids:['p'],geometry_revision:'g',label_map_version:'l',anchor:'center',behavior:'appearance'};
function run(rule=base){let cp=null,n=0;return (time,x=.2,state='confirmed',id='t',extra={})=>{
 const pts=String(Math.round((time+1)*1e9));const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(++n),frame_id:String(n),source_pts_ns:pts,captured_at:new Date(1760000000000+time*1000).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:x===null?[]:[{track_id:id,label_id:'p',state,observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1000-10,y:490,w:20,h:20}}],...extra};const out=evaluate(cp,frame,[rule]);cp=out.checkpoint;return out;};}
const traversal={...base,behavior:'region_traverse',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]]};
test('same identity brief absence retains alarm latch, expiry permits a new activity',()=>{
 const step=run(),first=step(0).events[0];assert.ok(first);
 assert.equal(step(.1,null).ended_episodes.length,0);assert.equal(step(1).events.length,0);
 step(2,null);const expired=step(5);assert.equal(expired.ended_episodes.length,1);assert.equal(expired.events.length,1);assert.notEqual(expired.events[0].episode_id,first.episode_id);
});
test('other identity never inherits an alarm or review identity',()=>{
 const step=run(),first=step(0).events[0];step(.1,null);const other=step(.2,.2,'confirmed','other').events[0];assert.notEqual(other.episode_id,first.episode_id);
});
test('grace retains no dwell or crossing evidence',()=>{
 const dwell=run({...base,duration_ms:1000});dwell(0);dwell(.5,null);assert.equal(dwell(.6).events.length,0);assert.equal(dwell(1.1).events.length,0);assert.equal(dwell(1.6).events.length,1);
 const pass=run(traversal);pass(0,.2);pass(.1,.4);pass(.2,null);assert.equal(pass(.3,.8).events.length,0);
});
test('real tentative outside and inside can support passage only after same ID confirms',()=>{
 for(const alarm_enabled of [true,false]){const step=run({...traversal,alarm_enabled});assert.equal(step(0,.2,'tentative').events.length,0);assert.equal(step(.1,.4,'tentative').events.length,0);assert.equal(step(.2,.5).events.length,0);assert.equal(step(.3,.8).events.length,1);}
});
test('unconfirmed, disappeared, stale or interrupted candidates cannot create a passage',()=>{
 const unconfirmed=run(traversal);for(const [i,x] of [.2,.4,.8].entries())assert.equal(unconfirmed(i/10,x,'tentative').events.length,0);assert.equal(unconfirmed(.4,.9).events.length,0);
 for(const kind of ['missing','stale','gap','identity']){const step=run(traversal);step(0,.2,'tentative');step(.1,.4,'tentative');if(kind==='missing')step(.2,null);const id=kind==='identity'?'other':'t';assert.equal(step(kind==='stale'?2:.3,.5,'confirmed',id,kind==='gap'?{gap:true}:{}).events.length,0);assert.equal(step(kind==='stale'?2.1:.4,.8,'confirmed',id).events.length,0,kind);}
});
