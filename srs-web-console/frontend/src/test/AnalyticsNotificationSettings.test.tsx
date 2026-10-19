import { describe,it,expect,vi } from 'vitest'
import { render,screen,fireEvent } from '@testing-library/react'
import { AnalyticsNotificationSettings } from '@/pages/AiChannels/AnalyticsNotificationSettings'
import { notificationError } from '@/features/analyticsNotification'
describe('notification settings',()=>{
 it('defaults off without issuing a change',()=>{
  const onChange=vi.fn();render(<AnalyticsNotificationSettings value={{enabled:true}} supported onChange={onChange}/>)
  expect(screen.getByRole('checkbox')).not.toBeChecked();expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({notification:{enabled:true,require_review:true,endpoint:''}}))
 })
 it.each([[false,true],[true,false]])('requires service and persistence %s %s',(supported,save_events)=>{
  render(<AnalyticsNotificationSettings value={{enabled:true,save_events}} supported={supported} onChange={()=>{}}/>)
  expect(screen.getByRole('checkbox')).toBeDisabled()
 })
 it('preserves endpoint and permits disable when support disappears',()=>{
  const onChange=vi.fn();render(<AnalyticsNotificationSettings value={{enabled:true,notification:{enabled:true,require_review:true,endpoint:'https://receiver/events'}}} supported={false} onChange={onChange}/>)
  fireEvent.click(screen.getByRole('checkbox'))
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({notification:{enabled:false,require_review:true,endpoint:'https://receiver/events'}}))
  expect(screen.getByRole('alert')).toHaveTextContent('请先开启目标复核')
 })
 it('makes bypassing review an explicit selection',()=>{
  const onChange=vi.fn();render(<AnalyticsNotificationSettings value={{enabled:true,notification:{enabled:true,require_review:true,endpoint:''}}} supported onChange={onChange}/>)
  fireEvent.change(screen.getByLabelText('通知发送策略'),{target:{value:'direct'}})
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({notification:expect.objectContaining({require_review:false})}))
  expect(screen.getByText(/旧任务保留原接收地址/)).toBeInTheDocument()
 })
 it.each(['','file:///tmp/events','https://user:password@receiver/events','https://receiver/events#fragment','not a url','https://receiver/events\n'])('rejects endpoint %s',endpoint=>{
  expect(notificationError({enabled:true,notification:{enabled:true,require_review:false,endpoint}})).not.toBeNull()
 })
 it('requires review and storage only when enabled',()=>{
  const notification={enabled:true,require_review:true,endpoint:'https://receiver/events'}
  expect(notificationError({enabled:true,notification})).toContain('开启目标复核')
  expect(notificationError({enabled:true,save_events:false,notification})).toContain('保存区域事件')
  expect(notificationError({enabled:true,review:{enabled:true,model_path:'/m.hbm',description:'person'},notification})).toBeNull()
  expect(notificationError({enabled:true,notification:{...notification,enabled:false}})).toBeNull()
 })
})
