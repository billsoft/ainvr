import {render,screen,fireEvent,waitFor,within} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {TriggerDefinitionWizard} from '@/pages/AlarmCenter/TriggerDefinitionWizard'
import type {TriggerDefinitionInput} from '@/features/alarmDefinitions'
const labels=[{label_id:'person',name:'人员'},{label_id:'car',name:'车辆'}]
function open(extra={}){
 const save=vi.fn(async(_input:TriggerDefinitionInput)=>{}),cancel=vi.fn()
 render(<TriggerDefinitionWizard id="t" labels={labels} onSave={save} onCancel={cancel} {...extra}/>)
 return {save,cancel}
}
const next=()=>fireEvent.click(screen.getByRole('button',{name:'下一步'}))
it('四步弹窗独立创建，无通道、目标搜索或复制入口',async()=>{
 const {save}=open()
 expect(screen.getByRole('dialog',{name:'新建触发器'})).toBeInTheDocument()
 expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('触发器名称'),{target:{value:'人员出现'}})
 next();fireEvent.click(screen.getByRole('button',{name:'人员'}))
 expect(within(screen.getByRole('region',{name:'已选目标'})).getByText('人员')).toBeInTheDocument()
 next();fireEvent.change(screen.getByLabelText('连续出现（秒）'),{target:{value:'2.5'}})
 next()
 expect(screen.queryByRole('combobox',{name:/通道/})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'保存'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]?.[0]).toMatchObject({trigger_id:'t',duration_ms:2500,state:'enabled',labels:[labels[0]]})
 expect(save.mock.calls[0]?.[0]).not.toHaveProperty('bindings')
})
it('接近按百分比设置，取消草稿不保存',()=>{
 const {save,cancel}=open()
 fireEvent.change(screen.getByLabelText('触发器名称'),{target:{value:'危险区'}})
 fireEvent.click(screen.getByRole('button',{name:/^接近/}))
 next();fireEvent.click(screen.getByRole('button',{name:'人员'}));next()
 expect(screen.getByLabelText('接近距离（画面宽度 %）')).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'取消'}))
 expect(save).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'放弃修改'}));expect(cancel).toHaveBeenCalledOnce()
})
it('共享定义编辑展示影响范围且保存失败不丢草稿',async()=>{
 const original={trigger_id:'t',name:'已有',behavior:'appearance' as const,labels:[labels[0]!],duration_ms:3000,
  alarm_enabled:true,state:'paused' as const,schedule:{mode:'always' as const},version:2,
  usages:[{assignment_id:'a',source_id:'camera',processor_id:'ai',zone_name:'门前'}]}
 const save=vi.fn(async(_input:TriggerDefinitionInput)=>{throw Error('offline')})
 open({initial:original,onSave:save})
 next();next();next()
 expect(screen.getByText(/门前/)).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'保存'}))
 await screen.findByRole('alert')
 expect(screen.getByRole('dialog')).toBeInTheDocument()
 expect(save.mock.calls[0]?.[0]).toMatchObject({state:'paused',name:'已有'})
})

it('selected targets can be removed and Escape protects dirty drafts',()=>{
 const {save,cancel}=open()
 fireEvent.change(screen.getByLabelText('触发器名称'),{target:{value:'测试'}});next()
 fireEvent.click(screen.getByRole('button',{name:'人员'}))
 fireEvent.click(screen.getByRole('button',{name:'移除目标 人员'}))
 expect(screen.getByText('尚未选择')).toBeInTheDocument()
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'})
 expect(screen.getByRole('alertdialog',{name:'放弃触发器修改'})).toBeInTheDocument();expect(cancel).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));expect(save).not.toHaveBeenCalled()
})

it('top right close uses the same discard flow and never saves',()=>{
 const {save,cancel}=open()
 fireEvent.change(screen.getByLabelText('触发器名称'),{target:{value:'未保存'}})
 fireEvent.click(screen.getByRole('button',{name:'关闭'}))
 expect(cancel).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'放弃修改'}));expect(cancel).toHaveBeenCalledOnce()
})
