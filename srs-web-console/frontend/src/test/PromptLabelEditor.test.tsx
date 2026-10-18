import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect } from 'vitest'
import { PromptLabelEditor } from '@/pages/AiChannels/PromptLabelEditor'
import { DEFAULT_WIZARD_VALUE, applyModelPreset, validateStep2, toCreatePatch, promptRows } from '@/features/aiChannelForm'
import type { AiPromptLabel } from '@/types/aiChannel'
const initial: AiPromptLabel[] = [
  {description:'person',label_id:'people',label_name:'行人'},
  {description:'hard hat',label_id:'helmet',label_name:'安全帽'},
]
function Harness({limit=8}:{limit?:number}) {
  const [rows,setRows]=useState(initial.map(row=>({...row})))
  return <><PromptLabelEditor rows={rows} limit={limit} onChange={setRows}/><output data-testid="rows">{JSON.stringify(rows)}</output></>
}
describe('PromptLabelEditor',()=>{
  it('筛选后修改原始目标，不修改其他标签或稳定 ID',async()=>{
    const user=userEvent.setup();render(<Harness/>);
    await user.type(screen.getByLabelText('查找标签'),'helmet')
    expect(screen.queryByLabelText('识别描述 1')).not.toBeInTheDocument()
    await user.clear(screen.getByLabelText('标签名称 2'))
    await user.type(screen.getByLabelText('标签名称 2'),'防护帽')
    const rows=JSON.parse(screen.getByTestId('rows').textContent!)
    expect(rows[0]).toEqual(initial[0]);expect(rows[1].label_id).toBe('helmet');expect(rows[1].label_name).toBe('防护帽')
  })
  it('增加清除筛选并聚焦新行，删除可撤销且容量受控',async()=>{
    const user=userEvent.setup();render(<Harness limit={3}/>);
    await user.type(screen.getByLabelText('查找标签'),'missing')
    await user.click(screen.getByRole('button',{name:'＋ 添加标签'}))
    expect(screen.getByLabelText('查找标签')).toHaveValue('')
    expect(screen.getByLabelText('识别描述 3')).toBeInTheDocument()
    expect(screen.getByRole('button',{name:'＋ 添加标签'})).toBeDisabled()
    await user.click(screen.getByRole('button',{name:'删除标签 2'}))
    await user.click(screen.getByRole('button',{name:'撤销删除'}))
    expect(JSON.parse(screen.getByTestId('rows').textContent!)[1]).toEqual(initial[1])
  })
  it('最后一个标签不能删除',async()=>{
    const user=userEvent.setup();render(<Harness/>);
    await user.click(screen.getByRole('button',{name:'删除标签 2'}))
    expect(screen.getByRole('button',{name:'删除标签 1'})).toBeDisabled()
  })
  it('完整列表校验包含被搜索隐藏的行，拒绝重复与空值',()=>{
    const v={...applyModelPreset(DEFAULT_WIZARD_VALUE,'yoloe-26x'),prompts:initial}
    expect(validateStep2(v)).toEqual({})
    expect(validateStep2({...v,prompts:[initial[0]!,{...initial[1]!,label_id:'people'}]})).toHaveProperty('prompts')
    expect(validateStep2({...v,prompts:[{...initial[0]!,description:''}]})).toHaveProperty('prompts')
    expect(toCreatePatch(v).model?.prompts).toEqual(initial)
  })
  it('32 切 8 保留所有行且阻止超容量保存',()=>{
    const rows=Array.from({length:9},(_,i)=>({description:`object ${i}`,label_id:`id${i}`,label_name:`目标${i}`}))
    const large={...applyModelPreset(DEFAULT_WIZARD_VALUE,'yoloe-26x-32'),prompts:rows}
    expect(validateStep2(large)).toEqual({})
    const small=applyModelPreset(large,'yoloe-26x')
    expect(promptRows(small)).toEqual(rows);expect(validateStep2(small)).toHaveProperty('prompts')
  })
})
