import {describe,expect,it} from 'vitest'
import {createArmingDraft,type ArmingSnapshotInput} from '@/features/armingDraft'

const initial=():ArmingSnapshotInput=>({
  sourceId:'camera',geometryRevision:'generation:1920x1080',revision:7,
  zones:[{id:'zone-a',name:'禁区',points:[[.1,.1],[.8,.1],[.8,.8],[.1,.8]],edgeIds:['a','b','c','d'],version:2}],
  assignments:[{id:'assignment-a',triggerId:'intrusion',processorId:'ai',zoneId:'zone-a',entryEdges:['a'],exitEdges:[],version:3,needsDirectionConfirmation:false}],
  counterBindings:[],
})
describe('布防事务草稿',()=>{
  it('取消恢复区域和选用，修改及读取不会改变原始快照',()=>{
    const source=initial(),draft=createArmingDraft(source)
    draft.renameZone('zone-a','新名称')
    const view=draft.read();view.zones[0]!.name='外部篡改'
    expect(draft.read().zones[0]!.name).toBe('新名称')
    expect(source).toEqual(initial())
    draft.cancel()
    expect(draft.read()).toEqual(source);expect(draft.dirty()).toBe(false)
  })
  it('删除热区同时解除选用，撤销和重做保持一致',()=>{
    const draft=createArmingDraft(initial())
    draft.removeZone('zone-a')
    expect(draft.read().zones).toEqual([]);expect(draft.read().assignments).toEqual([])
    draft.undo();expect(draft.read()).toEqual(initial())
    draft.redo();expect(draft.read().assignments).toEqual([])
    expect(draft.changeSet()).toMatchObject({expectedRevision:7,removedZoneIds:['zone-a'],removedAssignmentIds:['assignment-a']})
  })
  it('同一触发器和处理器可用于多个热区，完全重复选用被拒绝',()=>{
    const draft=createArmingDraft(initial())
    draft.addZone({...initial().zones[0]!,id:'zone-b',name:'后区',version:0})
    draft.putAssignment({...initial().assignments[0]!,id:'assignment-b',zoneId:'zone-b',version:0})
    expect(draft.read().assignments).toHaveLength(2)
    expect(()=>draft.putAssignment({...initial().assignments[0]!,id:'duplicate',version:0})).toThrow('重复选用')
    expect(draft.read().assignments).toHaveLength(2)
  })
  it('移除有方向绑定的边不静默改成不限方向',()=>{
    const draft=createArmingDraft(initial())
    draft.reshapeZone('zone-a',[[.1,.1],[.8,.8],[.1,.8]],['replacement','c','d'])
    expect(draft.read().assignments[0]).toMatchObject({entryEdges:['a'],needsDirectionConfirmation:true})
    expect(()=>draft.changeSet()).toThrow('重新确认方向')
    draft.putAssignment({...draft.read().assignments[0]!,entryEdges:['replacement'],needsDirectionConfirmation:false})
    expect(draft.changeSet().assignments).toHaveLength(1)
  })
  it('保留边编号的移动仍要求确认已绑定方向',()=>{
    const draft=createArmingDraft(initial())
    draft.reshapeZone('zone-a',[[.2,.2],[.9,.2],[.9,.9],[.2,.9]],['a','b','c','d'])
    expect(draft.read().assignments[0]!.needsDirectionConfirmation).toBe(true)
  })
  it('拒绝越界、自交、同名区域，失败不污染草稿或撤销历史',()=>{
    const draft=createArmingDraft(initial())
    expect(()=>draft.reshapeZone('zone-a',[[0,0],[1,1],[0,1],[1,0]],['a','b','c','d'])).toThrow()
    expect(()=>draft.addZone({...initial().zones[0]!,id:'other',version:0})).toThrow('名称')
    expect(draft.dirty()).toBe(false);draft.undo();expect(draft.read()).toEqual(initial())
  })
  it('新增后又删除不产生删除指令；后续编辑清除重做分支',()=>{
    const draft=createArmingDraft(initial())
    draft.addZone({...initial().zones[0]!,id:'temporary',name:'临时',version:0})
    draft.removeZone('temporary');expect(draft.changeSet().removedZoneIds).toEqual([])
    draft.undo();draft.renameZone('temporary','新的名称');draft.redo()
    expect(draft.read().zones.find(z=>z.id==='temporary')!.name).toBe('新的名称')
  })
  it('未变项不发送，提交携带原版本并冻结独立副本',()=>{
    const draft=createArmingDraft(initial())
    expect(draft.changeSet().zones).toEqual([])
    draft.renameZone('zone-a','更新名称')
    const changes=draft.changeSet();draft.renameZone('zone-a','再次修改')
    expect(changes.zones[0]).toMatchObject({id:'zone-a',name:'更新名称',version:2})
    expect(changes).toMatchObject({sourceId:'camera',geometryRevision:'generation:1920x1080',expectedRevision:7})
  })
})
