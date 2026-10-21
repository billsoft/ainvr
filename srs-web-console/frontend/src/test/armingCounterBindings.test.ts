import {describe,expect,it} from 'vitest'
import {carryEdgeIds,createArmingDraft,edgeIdsAfterEdit} from '@/features/armingDraft'
import {buildArmingRequest,readArmingSnapshot,type ArmingDocument} from '@/features/armingDocument'
const document:ArmingDocument={source_id:'cam',geometry_revision:'g',revision:3,assignments:[],
 zones:[{zone_id:'door',channel_id:'cam',geometry_revision:'g',version:1,state:'active',name:'门口',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],edge_ids:['top','right','bottom','left']}],
 counter_bindings:[{binding_id:'flow-1',counter_id:'visitors',input_stream_id:'cam',processor_id:'ai',zone_id:'door',zone_version:1,geometry_revision:'g',label_map_version:'lm',direction:{kind:'line',edge:'right',in_side:'inward'}}]}
describe('热区上的计数选用',()=>{
 it('读取与保存往返保留计数线和标签版本，热区改形状时带上新版本',()=>{
  const snapshot=readArmingSnapshot('cam','g',document)
  expect(snapshot.counterBindings).toEqual([{id:'flow-1',counterId:'visitors',processorId:'ai',zoneId:'door',direction:{kind:'line',edge:'right',in_side:'inward'},needsConfirmation:false}])
  const draft=createArmingDraft(snapshot)
  draft.reshapeZone('door',[[.3,.25],[.72,.3],[.7,.7],[.3,.7]],['top','right','bottom','left'])
  const request=buildArmingRequest(draft.read(),document)
  expect(request.counterBindings).toEqual([{...document.counter_bindings![0],zone_version:2}])
 })
 it('拖动顶点保留边编号，计数线无需确认即可保存',()=>{
  const draft=createArmingDraft(readArmingSnapshot('cam','g',document))
  draft.reshapeZone('door',[[.3,.25],[.72,.3],[.7,.7],[.3,.7]],['top','right','bottom','left'])
  expect(draft.read().counterBindings[0]!.needsConfirmation).toBe(false)
  expect(()=>draft.changeSet()).not.toThrow()
 })
 it('计数边消失时标记需确认并阻止保存，重新设置后可保存',()=>{
  const draft=createArmingDraft(readArmingSnapshot('cam','g',document))
  draft.reshapeZone('door',[[.3,.3],[.5,.2],[.7,.3],[.7,.7],[.3,.7]],['a','b','c','d','e'])
  expect(draft.read().counterBindings[0]!.needsConfirmation).toBe(true)
  expect(()=>draft.changeSet()).toThrow(/重新确认计数线/)
  draft.putCounterBinding({...draft.read().counterBindings[0]!,direction:{kind:'line',edge:'c',in_side:'outward'},needsConfirmation:false})
  expect(()=>draft.changeSet()).not.toThrow()
 })
 it('移除热区一并移除它的计数选用；同一热区不能重复选用同一计数器',()=>{
  const draft=createArmingDraft(readArmingSnapshot('cam','g',document))
  expect(()=>draft.putCounterBinding({id:'flow-2',counterId:'visitors',processorId:'ai',zoneId:'door',direction:{kind:'line',edge:'left',in_side:'inward'},needsConfirmation:false})).toThrow(/重复选用/)
  draft.removeZone('door')
  expect(draft.read().counterBindings).toEqual([])
  expect(draft.changeSet().removedCounterBindingIds).toEqual(['flow-1'])
 })
 it('增加顶点只让被拆开的边换编号，其余计数线保持有效',()=>{
  const old:[number,number][]=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],ids=['top','right','bottom','left']
  let n=0;const next=carryEdgeIds(old,ids,[[.3,.3],[.7,.3],[.7,.5],[.7,.7],[.3,.7]],()=>`new-${++n}`)
  expect(next).toEqual(['top','new-1','new-2','bottom','left'])
  expect(carryEdgeIds(old,ids,[[.3,.25],[.7,.3],[.7,.7],[.3,.7]],()=>'x')).toEqual(ids)
 })
 it('重画的热区全部换新边编号，原计数线需要重新设置；拖动与增删顶点按端点沿用',()=>{
  const old:[number,number][]=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],ids=['top','right','bottom','left']
  let n=0;const fresh=()=>`new-${++n}`
  expect(edgeIdsAfterEdit(old,ids,[[.7,.3],[.7,.7],[.3,.7],[.3,.3]],true,fresh)).toEqual(['new-1','new-2','new-3','new-4'])
  expect(edgeIdsAfterEdit(old,ids,[[.3,.25],[.7,.3],[.7,.7],[.3,.7]],false,fresh)).toEqual(ids)
  const draft=createArmingDraft(readArmingSnapshot('cam','g',document))
  draft.replaceZone({...draft.read().zones[0]!,points:[[.7,.3],[.7,.7],[.3,.7],[.3,.3]],edgeIds:edgeIdsAfterEdit(old,ids,[[.7,.3],[.7,.7],[.3,.7],[.3,.3]],true,fresh)})
  expect(draft.read().counterBindings[0]!.needsConfirmation).toBe(true)
 })
 it('调整计数线时“重新统计历史”只随这次保存发送，不保存在选用里',()=>{
  const draft=createArmingDraft(readArmingSnapshot('cam','g',document))
  draft.putCounterBinding({...draft.read().counterBindings[0]!,direction:{kind:'line',edge:'right',in_side:'outward'},reclassifyHistory:true})
  const request=buildArmingRequest(draft.read(),document)
  expect(request.counterBindings[0]).toMatchObject({direction:{kind:'line',edge:'right',in_side:'outward'},reclassify_history:true})
  const plain=createArmingDraft(readArmingSnapshot('cam','g',document))
  plain.putCounterBinding({...plain.read().counterBindings[0]!,direction:{kind:'line',edge:'right',in_side:'outward'}})
  expect(buildArmingRequest(plain.read(),document).counterBindings[0]).not.toHaveProperty('reclassify_history')
 })
 it('计数线只是字段顺序不同时不发送重新统计',()=>{
  const reordered={...document,counter_bindings:[{...document.counter_bindings![0]!,direction:{edge:'right',kind:'line',in_side:'inward'} as never}]}
  const draft=createArmingDraft(readArmingSnapshot('cam','g',reordered))
  draft.putCounterBinding({...draft.read().counterBindings[0]!,direction:{kind:'line',edge:'right',in_side:'inward'},reclassifyHistory:true})
  expect(buildArmingRequest(draft.read(),reordered).counterBindings[0]).not.toHaveProperty('reclassify_history')
 })
})
