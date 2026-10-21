import {it,expect} from 'vitest';
import {convertLegacyTrigger} from '../store/alarmLegacyConversion.js';
const points:[[number,number],[number,number],[number,number],[number,number]]=[[.2,.2],[.8,.2],[.8,.8],[.2,.8]];
const zone={zone_id:'zone',channel_id:'camera',geometry_revision:'g',version:2,state:'active',name:'门前',points};
const source={stream_fingerprint:'a'.repeat(64),width:1920,height:1080,not_before:'2026-10-20T00:00:00Z',
 input_stream_id:'camera',label_map_version:'lm',geometry_revision:'g'};
const legacy={trigger_id:'t',name:'进入',behavior:'region_enter',labels:[{label_id:'person',name:'人员'}],duration_ms:0,
 alarm_enabled:true,state:'enabled',schedule:{mode:'always'},bindings:[{channel_id:'ai',input_stream_id:'camera',
 label_map_version:'lm',geometry_revision:'g',zone_id:'zone',zone_version:2,direction:{entry_edges:[2],exit_edges:[]},
 source_binding:source,zone_snapshot:{zone_id:'zone',name:'门前',points,version:2}}]};
it('等价转换保留进入边与启用状态，稳定生成选用编号',()=>{
 const first=convertLegacyTrigger(legacy,4,[zone]);
 expect(first.status).toBe('converted');
 if(first.status!=='converted')return;
 expect(first.definition.state).toBe('enabled');
 expect(first.assignments[0]?.document.entry_edges).toEqual(['edge-2']);
 expect(first.assignments[0]?.rule).toMatchObject({trigger_version:4,entry_edges:[2],version:1});
 expect(convertLegacyTrigger(legacy,4,[zone])).toEqual(first);
});
it('旧像素范围按每个来源宽度精确转成百分比',()=>{
 const input={...legacy,behavior:'region_approach',bindings:[{...legacy.bindings[0],approach_px:60}]};
 const result=convertLegacyTrigger(input,1,[zone]);
 expect(result.status).toBe('converted');
 if(result.status==='converted'){
  expect(result.definition.approach_width_percent).toBe(3.125);
  expect(result.assignments[0]?.document.approach_width_percent).toBe(3.125);
  expect(result.assignments[0]?.rule?.approach_px).toBe(60);
 }
});
it('已改热区或缺失来源证据必须要求确认，不改成不限方向',()=>{
 const changed=convertLegacyTrigger(legacy,1,[{...zone,version:3}]);
 expect(changed).toMatchObject({status:'review',reason:expect.stringContaining('热区')});
 const missing=convertLegacyTrigger({...legacy,bindings:[{...legacy.bindings[0],source_binding:null}]},1,[zone]);
 expect(missing).toMatchObject({status:'review',reason:expect.stringContaining('来源')});
});
it('保留旧迁移的待确认状态，不绕过006保护',()=>{
 expect(convertLegacyTrigger({...legacy,migration_review:{required:true,reason:'旧方向需确认'}},2,[zone]))
  .toMatchObject({status:'review',reason:'旧方向需确认'});
});
it('全画面出现不凭空生成热区，暂停记录不执行',()=>{
 const result=convertLegacyTrigger({...legacy,behavior:'appearance',duration_ms:3000,state:'paused',
 bindings:[{...legacy.bindings[0],zone_id:null,zone_version:null,zone_snapshot:null,direction:{entry_edges:[],exit_edges:[]}}]},1,[]);
 expect(result.status).toBe('converted');
 if(result.status==='converted'){
  expect(result.zones).toEqual([]);
  expect(result.assignments[0]?.document.zone_id).toBeNull();
  expect(result.assignments[0]?.rule).toBeNull();
 }
});
