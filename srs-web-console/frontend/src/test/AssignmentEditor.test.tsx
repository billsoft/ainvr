import {render,screen,fireEvent} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {AssignmentEditor} from '@/pages/AlarmCenter/AssignmentEditor'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
const trigger={trigger_id:'t',name:'人员进入',behavior:'region_enter',labels:[{label_id:'person',name:'人'}],duration_ms:0,alarm_enabled:true,state:'enabled',schedule:{timezone:'Asia/Shanghai',windows:[]},version:1} as unknown as TriggerDefinition
const zone={id:'z',name:'门',version:1,edgeIds:['e1','e2','e3'],points:[[.1,.1],[.8,.1],[.8,.8]] as [number,number][]}
const source={channel_id:'ai1',channel_name:'检测1',input_stream_id:'cam',input_name:'门',label_map_version:'labels',geometry_revision:'g',tracking_available:true,labels:[{class_id:0,label_id:'person',name:'人',description:''}]}
it('does not silently replace an unavailable assigned processor with the sole compatible alternative',()=>{
 const apply=vi.fn()
 render(<AssignmentEditor sourceId="cam" geometryRevision="g" zone={zone} definitions={[trigger]}
  sources={[{...source,channel_id:'ai2',channel_name:'检测2'}]}
  initial={{id:'assignment',triggerId:'t',processorId:'ai1',zoneId:'z',entryEdges:[],exitEdges:[],version:1,needsDirectionConfirmation:false}}
  onApply={apply} onCancel={vi.fn()}/>)
 expect(screen.getByRole('button',{name:'加入布防草稿'})).toBeDisabled()
 expect(screen.getByRole('alert')).toHaveTextContent('原选择的 AI 处理器')
 fireEvent.change(screen.getByLabelText('AI 处理器'),{target:{value:'ai2'}})
 fireEvent.click(screen.getByRole('button',{name:'加入布防草稿'}))
 expect(apply).toHaveBeenCalledWith(expect.objectContaining({id:'assignment',processorId:'ai2'}),'labels')
})
it('whole frame does not offer zone-dependent triggers',()=>{
 render(<AssignmentEditor sourceId="cam" geometryRevision="g" zone={null} definitions={[trigger]} sources={[source]} onApply={vi.fn()} onCancel={vi.fn()}/> )
 expect(screen.queryByRole('option',{name:'人员进入'})).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'加入布防草稿'})).toBeDisabled()
})
it('one compatible processor is selected and direction is stored by stable edge ID',()=>{
 const apply=vi.fn()
 render(<AssignmentEditor sourceId="cam" geometryRevision="g" zone={zone} definitions={[trigger]} sources={[source]} onApply={apply} onCancel={vi.fn()}/> )
 fireEvent.change(screen.getByLabelText('触发器'),{target:{value:'t'}})
 fireEvent.click(screen.getByRole('button',{name:/进入边 1/}))
 fireEvent.click(screen.getByRole('button',{name:'加入布防草稿'}))
 expect(apply).toHaveBeenCalledWith(expect.objectContaining({triggerId:'t',processorId:'ai1',zoneId:'z',entryEdges:['e1'],needsDirectionConfirmation:false}),'labels')
})
it('multiple processors require explicit selection; incompatible labels are excluded',()=>{
 const apply=vi.fn()
 render(<AssignmentEditor sourceId="cam" geometryRevision="g" zone={zone} definitions={[trigger]} sources={[source,{...source,channel_id:'ai2',channel_name:'检测2'},{...source,channel_id:'bad',channel_name:'不同标签',labels:[]}]} onApply={apply} onCancel={vi.fn()}/> )
 fireEvent.change(screen.getByLabelText('触发器'),{target:{value:'t'}})
 expect(screen.getByRole('button',{name:'加入布防草稿'})).toBeDisabled()
 expect(screen.queryByRole('option',{name:'不同标签'})).not.toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('AI 处理器'),{target:{value:'ai2'}})
 fireEvent.click(screen.getByRole('button',{name:'加入布防草稿'}))
 expect(apply).toHaveBeenCalledWith(expect.objectContaining({processorId:'ai2'}),'labels')
})
