import {expect,it} from 'vitest';
import {bindingFilters,compileBinding,parseCounterBinding,parseCounterDefinition,validateBindingSet} from '../store/flowCounters.js';
const definition={counter_id:'visitors',name:'客流',labels:[{label_id:'person',name:'人员'}],method:'line' as const,outputs:'both' as const,
  names:{in:'进',out:'出'},occupancy:true,max_gap_ms:1000,state:'enabled' as const};
const source={channel_id:'ai',input_stream_id:'camera',geometry_revision:'g',label_map_version:'lm',tracking_available:true,
  labels:[{label_id:'person',name:'人员'}],width:1920,height:1080,stream_fingerprint:'a'.repeat(64),observed_at:'2026-10-21T00:00:00Z'};
const zone={zone_id:'door',channel_id:'camera',geometry_revision:'g',version:1,state:'active',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]] as [number,number][],edge_ids:['top','right','bottom','left']};
const binding=(direction:unknown)=>({binding_id:'flow-1',counter_id:'visitors',input_stream_id:'camera',processor_id:'ai',zone_id:'door',zone_version:1,geometry_revision:'g',label_map_version:'lm',direction});
it('一个计数选用编译成一条只统计的执行规则，编号等于选用编号，并带冻结来源证据',async()=>{
  const {validateRule}=await import(new URL('../../../../alarm-service/src/domain.mjs',import.meta.url).href);
  const rule=compileBinding(definition,3,binding({kind:'line',edge:'right',in_side:'inward'}),source,zone,1)!;
  expect(rule).toMatchObject({id:'flow-1',assignment_id:'flow-1',counter_id:'visitors',trigger_version:3,alarm_enabled:false,behavior:'region_traverse',
    passage:{kind:'line',edges:[1],max_gap_ms:1000},edge_ids:['top','right','bottom','left'],source_binding:{stream_fingerprint:'a'.repeat(64)}});
  // The analysis service accepts exactly this rule.
  expect(validateRule(JSON.parse(JSON.stringify(rule))).passage.kind).toBe('line');
  expect(compileBinding({...definition,state:'paused'},3,binding({kind:'line',edge:'right',in_side:'inward'}),source,zone,1)).toBeNull();
});
it('计数线必须与计数方式一致，且引用的边仍在热区上',()=>{
  expect(()=>compileBinding(definition,1,binding({kind:'gates',from:'left',to:'right'}),source,zone,1)).toThrow(/计数方式/);
  expect(()=>compileBinding(definition,1,binding({kind:'line',edge:'gone',in_side:'inward'}),source,zone,1)).toThrow(/重新确认计数线/);
  expect(()=>compileBinding(definition,1,binding({kind:'line',edge:'right',in_side:'inward'}),source,{...zone,version:2},1)).toThrow(/热区已变化/);
  expect(()=>compileBinding(definition,1,binding({kind:'line',edge:'right',in_side:'inward'}),{...source,stream_fingerprint:undefined},zone,1)).toThrow(/来源证据/);
});
it('进/出由同一条规则的事实在查询时分类：越线按侧，双线和区域按边编号对调',()=>{
  expect(bindingFilters({kind:'line',edge:'right',in_side:'outward'})).toEqual({in:{kind:'line',side:'outward'},out:{kind:'line',side:'inward'}});
  expect(bindingFilters({kind:'gates',from:'left',to:'right'})).toEqual({in:{kind:'edges',entry:['left'],exit:['right']},out:{kind:'edges',entry:['right'],exit:['left']}});
  expect(bindingFilters({kind:'edges',entry:['left','top'],exit:['right']}).out).toEqual({kind:'edges',entry:['right'],exit:['left','top']});
  expect(bindingFilters({kind:'angle',entry:{from:225,to:315},exit:{from:45,to:135}}).out).toEqual({kind:'angle',entry:{from:45,to:135},exit:{from:225,to:315}});
});
it('定义和选用拒绝含糊或重复的配置',()=>{
  expect(()=>parseCounterDefinition({...definition,names:{in:'进',out:'进'}})).toThrow(/名称/);
  expect(()=>parseCounterDefinition({...definition,outputs:'in'})).toThrow(/在场/);
  expect(parseCounterDefinition({...definition,outputs:'in',occupancy:false}).outputs).toBe('in');
  expect(()=>parseCounterBinding({...binding({kind:'gates',from:'left',to:'left'})})).toThrow(/两条不同/);
  expect(()=>parseCounterBinding({...binding({kind:'line',edge:'right',in_side:'inward'}),binding_id:'x-1'})).toThrow();
  expect(()=>validateBindingSet([binding({kind:'line',edge:'right',in_side:'inward'}),{...binding({kind:'line',edge:'left',in_side:'inward'}),binding_id:'flow-2'}])).toThrow(/重复选用/);
});
