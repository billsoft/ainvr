// Saved hardware observations only. No inference or production configuration writes.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {evaluate} from '../../alarm-service/src/engine.mjs';
const [input,oldRoot,output]=process.argv.slice(2);
if(!input||!oldRoot||!output)throw Error('TRACKING_REPORT BASELINE_RELEASE OUTPUT required');
const previous=(await import(pathToFileURL(oldRoot+'/src/engine.mjs'))).evaluate;
const bytes=await readFile(input),rows=JSON.parse(bytes).results;
const rule={id:'replay',name:'replay',version:1,channel_id:'p',state:'enabled',label_ids:['class:0'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',anchor:'bottom_center',alarm_enabled:false,points:[[.65,.05],[.75,.05],[.75,.95],[.65,.95]]};
function frames(dropEvery=0){
 const last=new Map();return rows.map((row,i)=>{
  const f=row.frame,a=f.model_extra?.analytics,pts=String(f.frame_pts_ns),visible=new Set(f.detections.filter(d=>d.track_id&&d.class_id===0).map(d=>d.track_id));
  const tracks=(a?.tracks??[]).filter(t=>t.label_id==='class:0'&&t.bbox?.x>=0&&t.bbox.y>=0&&t.bbox.w>0&&t.bbox.h>0&&t.bbox.x+t.bbox.w<=f.frame_width+.001&&t.bbox.y+t.bbox.h<=f.frame_height+.001).map(t=>{
   const eligible=t.observation==='detected'&&visible.has(t.track_id),hidden=eligible&&dropEvery&&i%dropEvery===0&&last.has(t.track_id);
   const copy={...t,event_eligible:eligible&&!hidden};
   if(hidden){copy.observation='predicted';copy.last_observed_pts_ns=last.get(t.track_id);}else if(eligible)last.set(t.track_id,pts);
   return copy;
  });
  return {schema_version:'1.0',channel_id:'p',input_stream_id:'in',stream_session_id:a?.stream_session_id??'initial',seq:String(i+1),frame_id:String(f.frame_index),source_pts_ns:pts,captured_at:new Date(Date.UTC(2026,9,21)+Number(BigInt(pts))/1e6).toISOString(),source:{width:f.frame_width,height:f.frame_height,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks};
 });
}
function run(fn,frames,rules){let cp=null;const events=[],timings=[];for(const f of frames){const start=performance.now(),r=fn(cp,f,rules);timings.push(performance.now()-start);cp=r.checkpoint;events.push(...r.events);}timings.sort((a,b)=>a-b);return {passages:events.length,tracks:[...new Set(events.map(e=>e.track_ids[0].split(':').at(-1)))],p50_ms:timings[Math.floor(timings.length*.5)],p95_ms:timings[Math.floor(timings.length*.95)],mean_ms:timings.reduce((a,b)=>a+b,0)/timings.length};}
const results=[];
for(const dropEvery of [0,10,5]){
 const f=frames(dropEvery);results.push({dropEvery,baseline_zone:run(previous,f,[rule]),zone:run(evaluate,f,[rule]),line:run(evaluate,f,[{...rule,passage:{kind:'line',edges:[3],max_gap_ms:1000}}]),gates:run(evaluate,f,[{...rule,passage:{kind:'gates',edges:[3,1],max_gap_ms:1000}}])});
}
const synthetic=[];
for(let i=0;i<500;i++)synthetic.push({schema_version:'1.0',channel_id:'p',input_stream_id:'in',stream_session_id:'load',seq:String(i+1),frame_id:String(i+1),source_pts_ns:String((i+1)*100000000),captured_at:new Date(Date.UTC(2026,9,21)+i*100).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:Array.from({length:64},(_,t)=>({track_id:String(t),label_id:'class:0',state:'confirmed',observation:'detected',last_observed_pts_ns:String((i+1)*100000000),bbox:{x:800+t,y:400,w:20,h:30}}))});
const points=Array.from({length:32},(_,i)=>[.5+.4*Math.cos(i*Math.PI/16),.5+.4*Math.sin(i*Math.PI/16)]);
const rules=Array.from({length:10},(_,i)=>({...rule,id:'load-'+i,points}));
// Warm both paths before recording; source and hardware are identical.
run(previous,synthetic.slice(0,50),rules);run(evaluate,synthetic.slice(0,50),rules);
const load={rules:10,tracks:64,vertices:32,frames:500,baseline:run(previous,synthetic,rules),candidate:run(evaluate,synthetic,rules)};
const report={input,input_sha256:createHash('sha256').update(bytes).digest('hex'),results,load,limitations:'Saved tracking replay plus deliberately hidden observations and synthetic CPU load. Not a new detector accuracy evaluation or production latency measurement.'};
await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
