import {render,screen,fireEvent,within,waitFor} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {TriggerDefinitionWizard} from '@/pages/AlarmCenter/TriggerDefinitionWizard'
import {fixedTargets,targetModel,triggerTargetsMatch} from '@/features/triggerTargets'
import type {TriggerDefinitionInput} from '@/features/alarmDefinitions'
const next=()=>fireEvent.click(screen.getByRole('button',{name:'下一步'}))
function open(){
 const save=vi.fn(async(_:TriggerDefinitionInput)=>{})
 render(<TriggerDefinitionWizard id="model-target" labels={[]} onSave={save} onCancel={vi.fn()}/>)
 fireEvent.change(screen.getByLabelText('触发器名称'),{target:{value:'车辆通行'}});next()
 return save
}
it('offline creation selects three vehicle classes with authoritative numeric identities',async()=>{
 const save=open()
 for(const name of ['汽车','卡车','公交车'])fireEvent.click(within(screen.getByRole('group',{name:'常用目标'})).getByRole('button',{name}))
 next();next();fireEvent.click(screen.getByRole('button',{name:'保存'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0]).toMatchObject({target_model:targetModel('yolo26x'),labels:[{label_id:'class:2',name:'car'},{label_id:'class:7',name:'truck'},{label_id:'class:5',name:'bus'}]})
})
it('model switch requires acknowledgement before clearing selected labels',()=>{
 open();fireEvent.click(screen.getByRole('button',{name:'人员'}))
 fireEvent.change(screen.getByLabelText('识别模型'),{target:{value:'yolo26x-face'}})
 expect(screen.getByRole('alertdialog',{name:'更换检测模型'})).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'保留当前模型'}))
 expect(screen.getByRole('button',{name:'移除目标 人员'})).toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('识别模型'),{target:{value:'yolo26x-face'}})
 fireEvent.click(screen.getByRole('button',{name:'切换并重新选择'}))
 expect(screen.queryByRole('button',{name:'人员'})).not.toBeInTheDocument()
 expect(fixedTargets('yolo26x-face')).toEqual([{label_id:'class:0',name:'face'}])
})
it('open vocabulary supports manual identities, names and descriptions with duplicate rejection',async()=>{
 const save=open()
 fireEvent.change(screen.getByLabelText('识别模型'),{target:{value:'yoloe-26x'}})
 fireEvent.click(screen.getByRole('button',{name:'＋ 添加标签'}))
 fireEvent.change(screen.getByLabelText('识别描述 1'),{target:{value:'a red truck'}})
 fireEvent.change(screen.getByLabelText('标签 ID 1'),{target:{value:'red-truck'}})
 fireEvent.change(screen.getByLabelText('标签名称 1'),{target:{value:'红色卡车'}})
 fireEvent.click(screen.getByRole('button',{name:'＋ 添加标签'}))
 fireEvent.change(screen.getByLabelText('识别描述 2'),{target:{value:'a bus'}})
 fireEvent.change(screen.getByLabelText('标签 ID 2'),{target:{value:'red-truck'}})
 fireEvent.change(screen.getByLabelText('标签名称 2'),{target:{value:'公交车'}})
 next();expect(screen.getByRole('alert')).toHaveTextContent('标签 ID 不能重复')
 fireEvent.change(screen.getByLabelText('标签 ID 2'),{target:{value:'bus'}})
 next();next();fireEvent.click(screen.getByRole('button',{name:'保存'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0]).toMatchObject({target_model:targetModel('yoloe-26x'),labels:[{label_id:'red-truck',name:'红色卡车',description:'a red truck'},{label_id:'bus',name:'公交车',description:'a bus'}]})
})
it('binding rejects another model and a different prompt, while preserving legacy matching',()=>{
 const labels=[{label_id:'vehicle',name:'车辆',description:'a truck'}]
 const t={target_model:targetModel('yoloe-26x'),labels}
 expect(triggerTargetsMatch(t,{...t})).toBe(true)
 expect(triggerTargetsMatch(t,{...t,target_model:targetModel('yoloe-26x-32')})).toBe(false)
 expect(triggerTargetsMatch(t,{...t,labels:[{...labels[0]!,description:'a car'}]})).toBe(false)
 expect(triggerTargetsMatch(t,{labels})).toBe(false)
 expect(triggerTargetsMatch({labels:[{label_id:'class:0',name:'person'}]},{labels:[{label_id:'class:0',name:'person'}]})).toBe(true)
})


it('single-class face model uses an explicit target card without search or unrelated examples',()=>{
 open()
 fireEvent.change(screen.getByLabelText('识别模型'),{target:{value:'yolo26x-face'}})
 expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
 expect(screen.queryByText(/汽车、卡车/)).not.toBeInTheDocument()
 expect(screen.getByText('该模型仅识别人脸，选择此目标后继续设置判定条件。')).toBeInTheDocument()
 next();expect(screen.getByRole('alert')).toHaveTextContent('至少选择一个检测目标')
 fireEvent.click(screen.getByRole('button',{name:'人脸'}))
 expect(screen.getByRole('button',{name:'人脸'})).toHaveAttribute('aria-pressed','true')
 expect(screen.getByText('已选择')).toBeInTheDocument()
 next();expect(screen.getByLabelText('连续出现（秒）')).toBeInTheDocument()
})
it('large model catalog searches its own labels, then clears query when switching to face',()=>{
 open()
 fireEvent.change(screen.getByRole('searchbox',{name:'查找类别'}),{target:{value:'bus'}})
 expect(screen.getByRole('button',{name:'公交车'})).toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'人员'})).not.toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('识别模型'),{target:{value:'yolo26x-face'}})
 expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'人脸'})).toBeInTheDocument()
})
