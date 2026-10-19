import { describe,it,expect,vi } from 'vitest'
import { render,screen,fireEvent } from '@testing-library/react'
import { AnalyticsReviewSettings } from '@/pages/AiChannels/AnalyticsReviewSettings'
import { DEFAULT_WIZARD_VALUE,validateStep3, validateAnalyticsStep } from '@/features/aiChannelForm'
describe('target review settings',()=>{
 it.each([[false,true,true],[true,false,true],[true,true,false]])('blocks missing prerequisites %s/%s/%s',(supported,archiveEnabled,save_events)=>{
  render(<AnalyticsReviewSettings value={{enabled:true,save_events}} supported={supported} archiveEnabled={archiveEnabled} onChange={()=>{}}/>)
  expect(screen.getByRole('checkbox',{name:'异步复核目标'})).toBeDisabled()
 })
 it('enables an explicit request and retains rules',()=>{
  const onChange=vi.fn();const value={enabled:true,rules:[]}
  render(<AnalyticsReviewSettings value={value} supported archiveEnabled onChange={onChange}/>)
  fireEvent.click(screen.getByRole('checkbox'))
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({rules:[],review:expect.objectContaining({enabled:true,description:'',timeout_seconds:60})}))
  expect(value).not.toHaveProperty('review')
 })
 it('allows disabling existing settings even when prerequisites disappear',()=>{
  const onChange=vi.fn();const value={enabled:true,review:{enabled:true,model_path:'/model.hbm',description:'a person'}}
  render(<AnalyticsReviewSettings value={value} supported={false} archiveEnabled={false} onChange={onChange}/>)
  expect(screen.getByRole('checkbox')).toBeEnabled()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({review:expect.objectContaining({enabled:false,description:'a person'})}))
  expect(screen.getByText(/当前不自动发送报警通知/)).toBeInTheDocument()
 })
 it('updates description without changing the installed model',()=>{
  const onChange=vi.fn();const value={enabled:true,review:{enabled:true,model_path:'/custom.hbm',description:'a person'}}
  render(<AnalyticsReviewSettings value={value} supported archiveEnabled onChange={onChange}/>)
  fireEvent.change(screen.getByLabelText('复核目标描述'),{target:{value:'a car'}})
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({review:expect.objectContaining({description:'a car',model_path:'/custom.hbm'})}))
 })
 it('rejects empty descriptions and invalid deadlines before save',()=>{
  const review={enabled:true,model_path:'/model.hbm',description:'  ',timeout_seconds:60}
  const form={...DEFAULT_WIZARD_VALUE,analytics:{enabled:true,review}}
  expect(validateAnalyticsStep(form).analytics).toContain('描述')
  review.description='a person';review.timeout_seconds=301
  expect(validateAnalyticsStep(form).analytics).toContain('5至300')
  // Phase 1 does not show review settings:stored ones never block saving tracking.
  expect(validateStep3(form).analytics).toBeUndefined()
 })
})
