// Replay saved hardware detections/tracks through the same production evaluator.
// No inference, recording interruption or changes to production configuration.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {evaluate} from '../../alarm-service/src/engine.mjs';
const input=process.argv[2],output=process.argv[3];
if(!input||!output)throw Error('Usage: node flow_replay_quality.mjs TRACKING_REPORT OUTPUT');
const bytes=await readFile(input),report=JSON.parse(bytes),events=[],issues={},skipped={};
const rule={id:'flow-corridor',assignment_id:'flow-corridor',trigger_id:'flow-corridor-trigger',trigger_version:1,version:1,name:'楼梯通行区',channel_id:'replay',input_stream_id:'replay-camera',state:'enabled',label_ids:['class:0'],geometry_revision:'replay-geometry',label_map_version:'replay-labels',behavior:'region_traverse',anchor:'bottom_center',zone_id:'zone70',zone_version:1,points:[[.65,.05],[.75,.05],[.75,.95],[.65,.95]],alarm_enabled:false};
let checkpoint=null,seq=0;
for(const row of report.results){
 const f=row.frame,analytics=f.model_extra?.analytics,pts=String(f.frame_pts_ns),W=f.frame_width,H=f.frame_height;
 const visible=new Set(f.detections.filter(d=>d.track_id&&d.class_id===0).map(d=>d.track_id));
 const tracks=(analytics?.tracks??[]).filter(t=>t.label_id==='class:0').filter(t=>{
  const b=t.bbox;const valid=b&&b.x>=0&&b.y>=0&&b.w>0&&b.h>0&&b.x+b.w<=W+.001&&b.y+b.h<=H+.001;
  if(!valid)skipped.invalid_box=(skipped.invalid_box??0)+1;return valid;
 }).map(t=>({...t,event_eligible:t.observation==='detected'&&visible.has(t.track_id)}));
 const result=evaluate(checkpoint,{schema_version:'1.0',channel_id:'replay',input_stream_id:'replay-camera',stream_session_id:analytics?.stream_session_id??'initial',seq:String(++seq),frame_id:String(f.frame_index),source_pts_ns:pts,captured_at:new Date(Date.UTC(2026,9,21)+Number(BigInt(pts))/1e6).toISOString(),source:{width:W,height:H,coordinate_space:'source_pixels',geometry_revision:'replay-geometry'},model:{label_map_version:'replay-labels'},tracks},[rule]);
 checkpoint=result.checkpoint;events.push(...result.events);
 for(const issue of result.issues)issues[issue]=(issues[issue]??0)+1;
}
const counted=events.map(e=>({track:e.track_ids[0].split(':').at(-1),entry_frame:e.analysis_evidence.traversal.entry.frame_id,exit_frame:e.analysis_evidence.traversal.exit.frame_id,direction:e.direction}));
const result={scope:'Saved VPU/BPU tracking replay, not a new hardware inference test',input,input_sha256:createHash('sha256').update(bytes).digest('hex'),frames:seq,
 zone:rule.points,anchor:rule.anchor,visually_reviewed_clip_people:6,annotation_scope:'Existing manual identity review of six people; not per-frame crossing ground truth',
 confirmed_passages:events.length,unique_counted_tracks:new Set(counted.map(e=>e.track)).size,counted,issues,skipped,
 limitation:'Strict observed crossings may undercount interruptions. Six reviewed people is a clip reference, not proof all satisfy this particular zone.'};
await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
