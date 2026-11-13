import {describe,it,expect} from 'vitest';
import {parseTriggerDefinition,compileAssignment} from '../store/alarmTriggerDefinition.js';
const definition={trigger_id:'region',name:'人数不足',behavior:'appearance' as const,labels:[{label_id:'person',name:'person'}],duration_ms:0,alarm_enabled:true,state:'enabled' as const,schedule:{mode:'always' as const},
 region_state:{operator:'count_below' as const,threshold:1,duration_ms:1000,recovery_ms:1000,event_kind:'region_absence' as const}};
const assignment={assignment_id:'a',trigger_id:'region',input_stream_id:'camera',processor_id:'ai',zone_id:'z',zone_version:1,geometry_revision:'g',label_map_version:'lm',entry_edges:[],exit_edges:[]};
const source={channel_id:'ai',input_stream_id:'camera',geometry_revision:'g',label_map_version:'lm',tracking_available:true,labels:[{label_id:'person',name:'person'}],width:1000,height:1000,stream_fingerprint:'a'.repeat(64),observed_at:'2026-11-12T00:00:00Z'};
const zone={zone_id:'z',channel_id:'camera',geometry_revision:'g',version:1,state:'active',points:[[.1,.1],[.9,.1],[.9,.9],[.1,.9]] as [number,number][],edge_ids:['a','b','c','d']};
describe('region definition uses original JSON document and assignment compiler',()=>{
 it('round-trips JSON and emits the same region contract plus event kind',()=>{
  const parsed=parseTriggerDefinition(JSON.parse(JSON.stringify(definition)));
  const compiled=compileAssignment(parsed,1,assignment,source,zone,1);
  expect(compiled?.region_state).toEqual(definition.region_state);expect(compiled?.event_kind).toBe('region_absence');
  expect(compiled?.review).toEqual({enabled:false});expect(compiled?.label_ids).toEqual(['person']);
 });
 it('unbound draft is allowed but an enabled assignment must select a real zone',()=>{
  expect(parseTriggerDefinition({...definition,state:'draft'}).state).toBe('draft');
  expect(compileAssignment({...definition,state:'draft'},1,{...assignment,zone_id:null,zone_version:null},source,null,1)).toBeNull();
  expect(()=>compileAssignment(definition,1,{...assignment,zone_id:null,zone_version:null},source,null,1)).toThrow(/热区/);
 });
 it('rejects missing tracking, fake labels, unsupported semantic capability and automatic review',()=>{
  expect(()=>compileAssignment(definition,1,assignment,{...source,tracking_available:false,detection_available:true},zone,1)).toThrow(/跟踪/);
  expect(()=>compileAssignment({...definition,labels:[{label_id:'fake',name:'fake'}]},1,assignment,source,zone,1)).toThrow(/目标/);
  const presence={...definition,region_state:{...definition.region_state,operator:'presence' as const,event_kind:'suspected_down' as const}};
  expect(()=>compileAssignment(presence,1,assignment,source,zone,1)).toThrow(/观测能力/);
  expect(compileAssignment(presence,1,assignment,{...source,region_capabilities:[{event_kind:'suspected_down',ready:true,label_ids:['person']}]},zone,1)?.event_kind).toBe('suspected_down');
  expect(()=>parseTriggerDefinition({...definition,review:{enabled:true,description:'test',reject_below:.05,approve_above:.95}})).toThrow(/人工审核/);
 });
 it.each([{behavior:'region_enter'},{duration_ms:1000},{group:{labels:'any',minimum:2,window_ms:0}},{region_state:{...definition.region_state,threshold:0}},{region_state:{...definition.region_state,operator:'count_at_least'}}])('rejects contradictory region contract %j',patch=>{
  expect(()=>parseTriggerDefinition({...definition,...patch})).toThrow();
 });
});
