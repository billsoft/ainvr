import {it,expect} from 'vitest';
import {compileAssignment,parseTriggerDefinition} from '../store/alarmTriggerDefinition.js';
const source={channel_id:'ai',input_stream_id:'camera',geometry_revision:'g',label_map_version:'lm',tracking_available:true,
 labels:[{label_id:'person',name:'人员'}],width:1920,height:1080,stream_fingerprint:'a'.repeat(64),observed_at:'2026-10-20T00:00:00Z'};
const zone={zone_id:'zone',channel_id:'camera',geometry_revision:'g',version:1,state:'active',points:[[.1,.1],[.8,.1],[.8,.8]] as [number,number][],edge_ids:['a','b','c']};
const assignment={assignment_id:'selection',trigger_id:'trigger',input_stream_id:'camera',processor_id:'ai',zone_id:'zone',zone_version:1,geometry_revision:'g',label_map_version:'lm',entry_edges:[],exit_edges:[]};
const definition=(behavior:string)=>parseTriggerDefinition({trigger_id:'trigger',name:'人员',behavior,labels:source.labels,duration_ms:0,alarm_enabled:true,state:'enabled',schedule:{mode:'always'},...(behavior==='region_approach'?{approach_width_percent:1}:{} )});
it('four generated rules are accepted by actual alarm engine with exact selection identity and distance',async()=>{
 const {validateRule}=await import(new URL('../../../../alarm-service/src/domain.mjs',import.meta.url).href);
 for(const behavior of ['appearance','region_approach','region_enter','region_traverse']){
  const rule=compileAssignment(definition(behavior),2,assignment,source,zone,3);
  const accepted=validateRule(JSON.parse(JSON.stringify(rule)));
  expect(accepted).toMatchObject({id:'selection',assignment_id:'selection',version:3,trigger_version:2,zone_version:1});
  if(behavior==='region_approach')expect(accepted.approach_px).toBe(19.2);
 }
});
it('incomplete source evidence is rejected before saving a rule the engine cannot use',()=>{
 expect(()=>compileAssignment(definition('region_approach'),1,assignment,{...source,stream_fingerprint:undefined},zone,1)).toThrow();
 expect(()=>compileAssignment(definition('appearance'),1,assignment,{...source,observed_at:'invalid'},zone,1)).toThrow();
});
it('UI edge identities compile into actual entry/passage gates without invented lower-stage facts',async()=>{
 const {evaluate}=await import(new URL('../../../../alarm-service/src/engine.mjs',import.meta.url).href);
 const rectangle={...zone,points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]] as [number,number][],edge_ids:['top','right','bottom','left']};
 const compile=(behavior:string,entry:string[]=[],exit:string[]=[])=>compileAssignment(definition(behavior),2,
  {...assignment,entry_edges:entry,exit_edges:exit},source,rectangle,3);
 function run(rule:unknown,xs:number[],change:(frame:any,index:number)=>void=()=>{}){
  let cp=null;const events:any[]=[];
  xs.forEach((x,i)=>{
   const pts=String((i+1)*200000000),bbox={x:x*1920-10,y:.5*1080-20,w:20,h:20};
   const frame={schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:'session',
    seq:String(i+1),frame_id:String(i+1),source_pts_ns:pts,captured_at:new Date(Date.parse(source.observed_at)+i*200).toISOString(),
    source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},
    tracks:[{track_id:'target',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox}]};
   change(frame,i);const result=evaluate(cp,frame,[rule]);cp=result.checkpoint;events.push(...result.events);
  });
  return events;
 }
 const enter=run(compile('region_enter',['left']),[.2,.4,.5]);
 expect(enter).toHaveLength(1);expect(enter[0].direction.entry_edge).toBe(3);
 expect(run(compile('region_enter',['right']),[.2,.4,.5])).toEqual([]);
 expect(run(compile('region_enter',['left']),[.4,.5])).toEqual([]);
 const passage=compile('region_traverse',['left'],['right']);
 const events=run(passage,[.2,.4,.6,.8]);
 expect(events).toHaveLength(1);
 expect(events[0]).toMatchObject({rule:{id:'selection',version:3},direction:{entry_edge:3,exit_edge:1}});
 expect(run(passage,[.8,.6,.4,.2])).toEqual([]);
 expect(run(passage,[.2,.4,.2])).toEqual([]);
 expect(run(passage,[.2,.4,.6,.8],(f,i)=>{if(i===2){f.tracks[0].observation='lost';f.tracks[0].predicted_bbox=f.tracks[0].bbox;}})).toEqual([]);
 expect(run(passage,[.2,.4,.6,.8],(f,i)=>{if(i===2)f.tracks[0].event_eligible=false;})).toEqual([]);
 expect(run(compile('region_approach',['left']),[.2,.295,.295])).toHaveLength(1);
 expect(run(compile('region_approach',['right']),[.2,.295])).toEqual([]);
 expect(run(compile('appearance'),[.2,.4,.4])).toHaveLength(1);
});
