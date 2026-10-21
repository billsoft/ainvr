import {render,screen,fireEvent,waitFor,within} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {TriggerDefinitionWizard} from '@/pages/AlarmCenter/TriggerDefinitionWizard'
import type {TriggerDefinitionInput} from '@/features/alarmDefinitions'
// Models report English class names under numeric ids.
const labels=[{label_id:'0',name:'person'},{label_id:'2',name:'car'},{label_id:'33',name:'kite'},{label_id:'7',name:'class:7'}]
const next=()=>fireEvent.click(screen.getByRole('button',{name:'下一步'}))
it('common targets show first in Chinese; identity stays the model number and name',async()=>{
 const save=vi.fn(async(_:TriggerDefinitionInput)=>{})
 render(<TriggerDefinitionWizard id="t" labels={labels} onSave={save} onCancel={vi.fn()}/>)
 fireEvent.change(screen.getByLabelText('触发器名称'),{target:{value:'门前人员'}});next()
 const common=screen.getByRole('group',{name:'常用目标'})
 expect(within(common).getByRole('button',{name:'人员'})).toBeVisible()
 expect(within(common).getByRole('button',{name:'汽车'})).toBeInTheDocument()
 expect(within(common).queryByRole('button',{name:'风筝'})).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'类别 7'})).toBeInTheDocument()
 fireEvent.click(within(common).getByRole('button',{name:'人员'}))
 expect(within(screen.getByRole('region',{name:'已选目标'})).getByRole('button',{name:'移除目标 人员'})).toBeInTheDocument()
 next();next()
 expect(screen.getByText(/^将会：/)).toHaveTextContent('人员')
 const purpose=screen.getByRole('group',{name:'用途'})
 fireEvent.click(within(purpose).getByRole('button',{name:'仅统计'}))
 expect(within(purpose).getByRole('button',{name:'仅统计'})).toHaveAttribute('aria-pressed','true')
 fireEvent.click(screen.getByRole('button',{name:'保存'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0]).toMatchObject({labels:[{label_id:'0',name:'person'}],alarm_enabled:false})
})
