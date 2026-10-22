import {render,screen,fireEvent} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {AssignmentPicker} from './WorkspaceEditorHarness'
import {createArmingDraft} from '@/features/armingDraft'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
const definitions:TriggerDefinition[]=['t1','t2'].map(id=>({trigger_id:id,name:id,behavior:'appearance',labels:[{label_id:'person',name:'人'}],duration_ms:0,alarm_enabled:true,state:'enabled',schedule:{mode:'always'},version:1}))
const source={channel_id:'ai',channel_name:'检测',input_stream_id:'cam',input_name:'门',label_map_version:'l',geometry_revision:'g',tracking_available:true,labels:[{class_id:0,label_id:'person',name:'人',description:''}]}
it('configures multiple selections independently then applies one atomic batch',()=>{
 const apply=vi.fn()
 render(<AssignmentPicker sourceId="cam" geometryRevision="g" zone={null} definitions={definitions} sources={[source]} onDirectionChange={vi.fn()} onApply={apply}/> )
 fireEvent.click(screen.getByLabelText('t1'));fireEvent.click(screen.getByLabelText('t2'))
 expect(screen.getAllByLabelText('AI 处理器')).toHaveLength(2)
 expect(apply).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 expect(apply).toHaveBeenCalledOnce();expect(apply.mock.calls[0]![0].map((i:any)=>i.assignment.triggerId)).toEqual(['t1','t2'])
})
it('a duplicate in a batch leaves the entire draft unchanged and creates no undo entry',()=>{
 const draft=createArmingDraft({sourceId:'cam',geometryRevision:'g',revision:0,zones:[],assignments:[]})
 const a={id:'a',triggerId:'t',processorId:'ai',zoneId:null,entryEdges:[],exitEdges:[],version:0,needsDirectionConfirmation:false}
 expect(()=>draft.putAssignments([a,{...a,id:'b'}])).toThrow('同一范围不能重复选用')
 expect(draft.read().assignments).toEqual([]);expect(draft.canUndo()).toBe(false)
})
