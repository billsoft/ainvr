import {render,screen,fireEvent} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {AssignmentEditor} from './WorkspaceEditorHarness'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
const trigger={trigger_id:'t',name:'人员进入',behavior:'region_enter',labels:[{label_id:'person',name:'人'}],duration_ms:0,alarm_enabled:true,state:'enabled',schedule:{timezone:'Asia/Shanghai',windows:[]},version:1} as unknown as TriggerDefinition
const zone={id:'z',name:'门',version:1,edgeIds:['e1','e2','e3'],points:[[.1,.1],[.8,.1],[.8,.8]] as [number,number][]}
const source={channel_id:'ai1',channel_name:'检测1',input_stream_id:'cam',input_name:'门',label_map_version:'labels',geometry_revision:'g',tracking_available:true,labels:[{class_id:0,label_id:'person',name:'人',description:''}]}
it('does not silently replace an unavailable assigned processor with the sole compatible alternative',()=>{
 const apply=vi.fn()
 render(<AssignmentEditor sourceId="cam" geometryRevision="g" zone={zone} definitions={[trigger]}
  sources={[{...source,channel_id:'ai2',channel_name:'检测2'}]}
  initial={{id:'assignment',triggerId:'t',processorId:'ai1',zoneId:'z',entryEdges:[],exitEdges:[],version:1,needsDirectionConfirmation:false}}
  onApply={apply}/>)
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 expect(screen.getAllByRole('alert').some(e=>e.textContent?.includes('原选择的 AI 处理器'))).toBe(true)
 expect(apply).not.toHaveBeenCalled()
 fireEvent.change(screen.getByLabelText('AI 处理器'),{target:{value:'ai2'}})
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 expect(apply).toHaveBeenCalledWith(expect.objectContaining({id:'assignment',processorId:'ai2'}),'labels')
})
it('whole frame does not offer zone-dependent triggers',()=>{
 render(<AssignmentEditor sourceId="cam" geometryRevision="g" zone={null} definitions={[trigger]} sources={[source]} onApply={vi.fn()}/> )
 expect(screen.queryByRole('option',{name:'人员进入'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
})
it('one compatible processor is selected and direction is stored by stable edge ID',()=>{
 const apply=vi.fn()
 render(<AssignmentEditor sourceId="cam" geometryRevision="g" zone={zone} definitions={[trigger]} sources={[source]} onApply={apply}/> )
 fireEvent.change(screen.getByLabelText('触发器'),{target:{value:'t'}})
 fireEvent.click(screen.getByRole('button',{name:/进入边 1/}))
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 expect(apply).toHaveBeenCalledWith(expect.objectContaining({triggerId:'t',processorId:'ai1',zoneId:'z',entryEdges:['e1'],needsDirectionConfirmation:false}),'labels')
})
it('multiple processors require explicit selection; incompatible labels are excluded',()=>{
 const apply=vi.fn()
 render(<AssignmentEditor sourceId="cam" geometryRevision="g" zone={zone} definitions={[trigger]} sources={[source,{...source,channel_id:'ai2',channel_name:'检测2'},{...source,channel_id:'bad',channel_name:'不同标签',labels:[]}]} onApply={apply}/> )
 fireEvent.change(screen.getByLabelText('触发器'),{target:{value:'t'}})
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 expect(screen.queryByRole('option',{name:'不同标签'})).not.toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('AI 处理器'),{target:{value:'ai2'}})
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 expect(apply).toHaveBeenCalledWith(expect.objectContaining({processorId:'ai2'}),'labels')
})

it('changed zone directions require explicit acknowledgement before saving',()=>{
 const apply=vi.fn()
 render(<AssignmentEditor sourceId="cam" geometryRevision="g" zone={zone} definitions={[trigger]} sources={[source]} initial={{id:'a',triggerId:'t',processorId:'ai1',zoneId:'z',entryEdges:[],exitEdges:[],version:1,needsDirectionConfirmation:true}} onApply={apply}/> )
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 fireEvent.click(screen.getByLabelText('已核对当前热区的进入和离开方向'))
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 expect(apply).toHaveBeenCalledWith(expect.objectContaining({needsDirectionConfirmation:false}),'labels')
})
