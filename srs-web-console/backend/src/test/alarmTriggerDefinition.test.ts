import {expect,it} from 'vitest';
import {parseTriggerDefinition,compileAssignment,validateAssignmentSet} from '../store/alarmTriggerDefinition.js';

const definition=(behavior='appearance')=>parseTriggerDefinition({
  trigger_id:'trigger',name:'测试',behavior,labels:[{label_id:'person',name:'人员'}],
  duration_ms:behavior==='appearance'?3000:0,alarm_enabled:true,state:'enabled',schedule:{mode:'always'},
  ...(behavior==='region_approach'?{approach_width_percent:5}:{}),
});
const source={stream_fingerprint:'a'.repeat(64),observed_at:'2026-10-20T00:00:00Z',channel_id:'processor',input_stream_id:'camera',label_map_version:'lm',geometry_revision:'g',
  tracking_available:true,labels:[{label_id:'person',name:'人员'}],width:3840,height:2160};
const zone={zone_id:'zone',channel_id:'camera',geometry_revision:'g',version:2,state:'active',
  points:[[.1,.1],[.8,.1],[.8,.8],[.1,.8]] as [number,number][],edge_ids:['a','b','c','d']};
const assignment=(zoneId:string|null=null)=>({assignment_id:'selection',trigger_id:'trigger',input_stream_id:'camera',
  processor_id:'processor',zone_id:zoneId,geometry_revision:'g',label_map_version:'lm',zone_version:zoneId?2:null,
  entry_edges:[] as string[],exit_edges:[] as string[]});
it('定义可无通道创建；拒绝把绑定和碰撞子模式塞回定义',()=>{
  expect(definition()).toMatchObject({behavior:'appearance'});
  expect(()=>parseTriggerDefinition({...definition(),bindings:[]})).toThrow();
  expect(()=>parseTriggerDefinition({...definition('region_enter'),contact_mode:'touch'})).toThrow();
});
it('接近使用宽度百分比，其他行为拒绝误带距离或持续参数',()=>{
  expect(()=>parseTriggerDefinition({...definition('region_approach'),approach_width_percent:0})).toThrow();
  expect(()=>parseTriggerDefinition({...definition(),approach_width_percent:5})).toThrow();
  expect(()=>parseTriggerDefinition({...definition('region_enter'),duration_ms:1000})).toThrow();
});
it('出现可以绑定热区；同处理器多热区以独立选用编号生成规则',()=>{
  const a=compileAssignment(definition(),4,assignment('zone'),source,zone,10);
  const b=compileAssignment(definition(),4,{...assignment('other'),assignment_id:'selection-2'},source,{...zone,zone_id:'other'},11);
  expect(a.id).not.toBe(b.id);
  expect(a).toMatchObject({id:'selection',trigger_id:'trigger',assignment_id:'selection',trigger_version:4,version:10,anchor:'bottom_center',points:zone.points});
  validateAssignmentSet([assignment('zone'),{...assignment('other'),assignment_id:'selection-2'}]);
  expect(()=>validateAssignmentSet([assignment('zone'),{...assignment('zone'),assignment_id:'duplicate'}])).toThrow();
});
it('按原图宽度换算距离，稳定边编号转换到引擎索引',()=>{
  const rule=compileAssignment(definition('region_approach'),1,{...assignment('zone'),entry_edges:['d'],approach_width_percent:2.5},source,zone,1);
  expect(rule).toMatchObject({approach_px:96,entry_edges:[3]});
});
it('缺少区域、不兼容处理器、变更来源或标签均拒绝执行',()=>{
  expect(()=>compileAssignment(definition('region_enter'),1,assignment(),source,null,1)).toThrow();
  expect(()=>compileAssignment(definition(),1,assignment(),{...source,channel_id:'another'},null,1)).toThrow();
  expect(()=>compileAssignment(definition(),1,assignment(),{...source,tracking_available:false},null,1)).toThrow();
  expect(()=>compileAssignment(definition(),1,assignment(),{...source,labels:[{label_id:'person',name:'火焰'}]},null,1)).toThrow();
  expect(()=>compileAssignment(definition(),1,assignment('zone'),source,{...zone,version:3},1)).toThrow();
});
it('过期边引用不能改成不限方向；暂停定义不产生执行规则',()=>{
  expect(()=>compileAssignment(definition('region_enter'),1,{...assignment('zone'),entry_edges:['missing']},source,zone,1)).toThrow();
  expect(compileAssignment({...definition(),state:'paused'},1,assignment(),source,null,1)).toBeNull();
});

it('detection-only allows zero-dwell presence and approach; crossings and dwell stay paused',()=>{
 const s={...source,tracking_available:false,detection_available:true};
 expect(compileAssignment({...definition(),duration_ms:0},1,assignment('zone'),s,zone,1)).toMatchObject({behavior:'appearance'});
 expect(compileAssignment(definition('region_approach'),1,assignment('zone'),s,zone,1)).toMatchObject({behavior:'region_approach'});
 for(const d of [definition(),definition('region_enter'),definition('region_traverse')])
   expect(()=>compileAssignment(d,1,assignment('zone'),s,zone,1)).toThrow();
 expect(()=>compileAssignment(definition('region_approach'),1,{...assignment('zone'),entry_edges:['a']},s,zone,1)).toThrow();
});


it('model-scoped targets reject same labels from another model, compile multiple classes without changing engine schema',()=>{
 const model={name:'yolo26x',adapter:'yolo26_bpu',mode:'fixed' as const};
 const labels=[{label_id:'class:2',name:'car'},{label_id:'class:7',name:'truck'},{label_id:'class:5',name:'bus'}];
 const d=parseTriggerDefinition({...definition(),target_model:model,labels});
 const s={...source,target_model:model,labels};
 expect(compileAssignment(d,1,assignment(),s,null,1)).toMatchObject({labels,label_ids:labels.map(l=>l.label_id)});
 expect(()=>compileAssignment(d,1,assignment(),{...s,target_model:{...model,name:'other'}},null,1)).toThrow('相同模型');
 expect(()=>compileAssignment(d,1,assignment(),{...source,labels},null,1)).toThrow('相同模型');
 expect(()=>compileAssignment(d,1,assignment(),{...s,labels:labels.slice(1)},null,1)).toThrow('所选目标');
});
it('open vocabulary requires matching prompt as well as ID and name; metadata never leaks into engine labels',()=>{
 const model={name:'yoloe-26x',adapter:'yoloe_bpu',mode:'open' as const};
 const labels=[{label_id:'truck',name:'卡车',description:'a red truck'}];
 const d=parseTriggerDefinition({...definition(),target_model:model,labels});
 const s={...source,target_model:model,labels};
 expect(compileAssignment(d,1,assignment(),s,null,1).labels).toEqual([{label_id:'truck',name:'卡车'}]);
 expect(()=>compileAssignment(d,1,assignment(),{...s,labels:[{...labels[0]!,description:'a toy truck'}]},null,1)).toThrow('所选目标');
 expect(()=>parseTriggerDefinition({...d,labels:[{label_id:'truck',name:'卡车'}]})).toThrow();
 expect(()=>parseTriggerDefinition({...d,labels:[...labels,...labels]})).toThrow();
 expect(()=>parseTriggerDefinition({...d,target_model:{...model,mode:'fixed'}})).toThrow();
 expect(()=>parseTriggerDefinition({...d,labels:Array.from({length:9},(_,i)=>({...labels[0],label_id:`label${i}`}))})).toThrow();
});
