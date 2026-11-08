// AINVR. Known synthetic truth -> real C++ tracker -> existing alarm/counter engine.
// No live database writes. Usage: node business-replay.mjs replay-output.jsonl
import fs from 'node:fs';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import {evaluate} from '../../alarm-service/src/engine.mjs';
const states=new Map();
for await(const line of readline.createInterface({input:fs.createReadStream(process.argv[2])})){
 const r=JSON.parse(line),a=r.model_extra.analytics,c=r.channel_id;
 if(!states.has(c))states.set(c,{cp:null,seq:0,ids:new Map(),sessions:new Set(),counts:{},frames:0});
 const s=states.get(c);s.frames++;s.sessions.add(a.stream_session_id);
 r.detections.forEach((d,i)=>{
  const id=r.assigned_ids[i];if(!id)return;
  if(s.ids.has(d.truth_id))assert.equal(id,s.ids.get(d.truth_id),'same observed target must retain identity');
  else s.ids.set(d.truth_id,id);
 });
 const base={version:1,name:'synthetic',channel_id:c,state:'enabled',label_ids:['class:0'],geometry_revision:'g',label_map_version:'l',anchor:'center',entry_edges:[],exit_edges:[],duration_ms:0};
 const points=[[.3,0],[.7,0],[.7,1],[.3,1]];
 const rules=[{...base,id:'appearance',behavior:'appearance'},{...base,id:'intrusion',behavior:'region_enter',points},{...base,id:'traverse',behavior:'region_traverse',points},{...base,id:'counter',behavior:'region_traverse',points,alarm_enabled:false,passage:{kind:'line',edges:[3],max_gap_ms:1000}}];
 const f={schema_version:'1.0',channel_id:c,input_stream_id:'test',stream_session_id:a.stream_session_id,seq:String(++s.seq),frame_id:'f'+s.seq,source_pts_ns:String(r.frame_pts_ns),captured_at:new Date(r.timestamp*1000).toISOString(),source:{width:r.frame_width,height:r.frame_height,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:a.tracks,...(a.continuity_gap?{gap:true}:{})};
 const out=evaluate(s.cp,f,rules);s.cp=out.checkpoint;
 for(const e of out.events){const id=e.rule.id;s.counts[id]=(s.counts[id]??0)+1;}
}
for(const [channel,s] of states){
 assert.equal(s.sessions.size,1);assert.equal(s.ids.size,4);
 assert.deepEqual(s.counts,process.argv.includes('--gap')?{appearance:4,intrusion:4,counter:4}:{appearance:4,intrusion:4,counter:4,traverse:4},channel);
}
assert.equal(states.size,16);
console.log(JSON.stringify({channels:16,targets_per_channel:4,expected_events:{appearance:64,intrusion:64,counter:64,traverse:process.argv.includes('--gap')?0:64},explicit_gap:process.argv.includes('--gap'),status:'passed',basis:'synthetic truth; not real-video accuracy'}));