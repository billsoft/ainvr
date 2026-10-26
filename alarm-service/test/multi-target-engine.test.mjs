import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {validateRule} from '../src/domain.mjs';
test('one multi-label trigger evaluates each selected target independently and ignores unselected labels',()=>{
 const r=validateRule({id:'vehicles',assignment_id:'vehicles',trigger_id:'vehicles',trigger_version:1,version:1,
  name:'车辆',channel_id:'ai',input_stream_id:'camera',state:'enabled',label_ids:['class:2','class:5','class:7'],
  geometry_revision:'g',label_map_version:'lm',behavior:'appearance',zone_id:null,zone_version:null,
  anchor:'bottom_center',duration_ms:1000});
 let cp=null;
 const step=(seq,seconds)=>{
  const pts=String(BigInt(seconds+1)*1000000000n);
  const out=evaluate(cp,{schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:'s',
   seq:String(seq),frame_id:String(seq),source_pts_ns:pts,captured_at:new Date(1792454400000+seconds*1000).toISOString(),
   source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},
   tracks:['class:2','class:5','class:7','class:0'].map((label_id,i)=>({track_id:`target-${i}`,label_id,state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:100+i*100,y:100,w:30,h:60}}))},[r]);
  cp=out.checkpoint;return out.events;
 };
 assert.equal(step(1,0).length,0);
 assert.equal(step(2,1).length,3);
 assert.equal(step(3,2).length,0);
});
