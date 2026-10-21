import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRule} from '../src/domain.mjs';
import {evaluate} from '../src/engine.mjs';
import {behaviorEvent} from '../src/behavior-events.mjs';
const points=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
const rule=(extra={})=>({id:'a',assignment_id:'a',trigger_id:'t',trigger_version:1,version:1,
 name:'出现',channel_id:'ai',input_stream_id:'camera',state:'enabled',label_ids:['person'],
 geometry_revision:'g',label_map_version:'lm',behavior:'appearance',zone_id:'z',zone_version:1,
 points,anchor:'bottom_center',duration_ms:1000,...extra});
function run(rules){
 let cp=null,seq=0;
 return (seconds,x=.5,y=.5,predicted=false)=>{
   const pts=String(BigInt(Math.round(seconds*1e9)+1e9));
   const b={x:x*1000-10,y:y*1000-20,w:20,h:20};
   const output=evaluate(cp,{schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:'s',
     seq:String(++seq),frame_id:String(seq),source_pts_ns:pts,captured_at:new Date(1792454400000+seconds*1000).toISOString(),
     source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},
     tracks:[{track_id:'person1',label_id:'person',state:'confirmed',observation:predicted?'lost':'detected',
       last_observed_pts_ns:predicted?String(BigInt(pts)-1n):pts,bbox:b,...(predicted?{predicted_bbox:b}:{})}]},rules);
   cp=output.checkpoint;return output.events;
 };
}
test('选用身份和区域版本不能静默丢弃',()=>{
 assert.equal(validateRule(rule()).zone_id,'z');
 assert.throws(()=>validateRule(rule({assignment_id:'other'})));
 assert.throws(()=>validateRule(rule({zone_version:null})));
 assert.throws(()=>validateRule(rule({trigger_version:0})));
});
test('热区内出现只累计区内时间，使用底边中点，保留区域身份',()=>{
 const step=run([rule()]);
 assert.equal(step(0,.1).length,0);assert.equal(step(1,.1).length,0);
 assert.equal(step(2,.5,.305).length,0); // center y=.295 outside, feet inside
 const events=step(3,.5,.305);assert.equal(events.length,1);assert.equal(behaviorEvent(events[0]).zone_id,'z');
 assert.equal(step(4,.5).length,0);
});
test('预测只能续接已在区域内的出现，不能证明进入区域或触发',()=>{
 const step=run([rule()]);
 step(0,.1);step(.5,.5,.5,true);
 assert.equal(step(1,.5).length,0);assert.equal(step(1.5,.5,.5,true).length,0);
 assert.equal(step(2,.5).length,1);
 const departure=run([rule()]);departure(0);departure(.5,.8,.5,true);
 assert.equal(departure(1).length,0);assert.equal(departure(2).length,1);
});
test('同一触发器多个区域只产生实际命中的选用事实',()=>{
 const step=run([rule({duration_ms:0}),rule({id:'b',assignment_id:'b',zone_id:'other',duration_ms:0,
 points:[[.8,.3],[.95,.3],[.95,.7],[.8,.7]]})]);
 assert.deepEqual(step(0).map(e=>e.rule.id),['a']);
});
test('新百分比距离保留小数并以原画宽度编译，旧像素规则仍保持约束',()=>{
 const input=rule({behavior:'region_approach',duration_ms:0,approach_px:19.2,approach_width_percent:1,
 source_binding:{stream_fingerprint:'a'.repeat(64),not_before:'2026-10-20T00:00:00Z',width:1920,height:1080,
 input_stream_id:'camera',geometry_revision:'g',label_map_version:'lm'}});
 assert.equal(validateRule(input).approach_px,19.2);
 assert.throws(()=>validateRule({...input,approach_px:20}));
 assert.throws(()=>validateRule({...input,approach_width_percent:101}));
});
