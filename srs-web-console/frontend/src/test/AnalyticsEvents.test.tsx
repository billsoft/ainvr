import { describe,it,expect,vi,beforeEach } from 'vitest'
import { render,screen,fireEvent,waitFor } from '@testing-library/react'
import { AnalyticsEvents } from '@/pages/AiChannels/AnalyticsEvents'
import { request } from '@/api/httpClient'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))
describe('analytics event history',()=>{
 beforeEach(()=>vi.mocked(request).mockReset())
 it.each([
  ['pending','排队中'],['processing','复核中'],['approved','复核通过'],
  ['rejected','复核否决'],['failed','复核失败'],['timeout','复核超时'],['unavailable','复核不可用'],
  ['future_state','未知状态（需检查服务版本）']
 ])('renders review %s without implying approval',async(status,label)=>{
  vi.mocked(request).mockResolvedValue({events:[{event_id:'e1',timestamp:123,rule_id:'入口',type:'line_crossing',track_id:'session:1',review_status:status,notification_status:'waiting_review',evidence:{status:'awaiting_archive'},target:{confidence:null}}]})
  render(<AnalyticsEvents channelId="door" onClose={()=>{}}/>)
  expect(await screen.findByText(`复核：${label} · 通知：等待复核`)).toBeInTheDocument()
  fireEvent.click(screen.getByText('查看事件依据'))
  expect(screen.getByText('等待归档确认（尚不能作为图片证据）')).toBeInTheDocument()
  expect(screen.getByText('模型未提供或未记录')).toBeInTheDocument()
 })
 it('explains target presence approval does not verify a temporal event',async()=>{
  vi.mocked(request).mockResolvedValue({events:[{event_id:'e1',timestamp:123,rule_id:'入口',type:'line_crossing',track_id:'s:1',review_status:'approved',review_job:{result:{scope:'target_presence',description:'a person'}}}]})
  render(<AnalyticsEvents channelId="door" onClose={()=>{}}/>)
  expect(await screen.findByText(/复核范围：仅确认截图/)).toHaveTextContent('不确认越线方向或停留时长')
  expect(screen.getByText(/复核范围：仅确认截图/)).toHaveTextContent('a person')
 })
 it('distinguishes query failure from no events and supports retry',async()=>{
  vi.mocked(request).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({events:[]})
  render(<AnalyticsEvents channelId="door" onClose={()=>{}}/>)
  expect(await screen.findByRole('alert')).toHaveTextContent('不表示没有事件')
  fireEvent.click(screen.getByText('刷新记录'))
  expect(await screen.findByText(/暂无已保存事件/)).toBeInTheDocument()
  expect(request).toHaveBeenCalledWith('/ai/channels/door/analytics/events?limit=100')
 })
 it('shows stored event identity and closes with escape',async()=>{
  vi.mocked(request).mockResolvedValue({events:[{event_id:'e1',timestamp:123,rule_id:'入口',type:'line_crossing',track_id:'session:1',review_status:'not_requested',notification_status:'not_requested'}]})
  const close=vi.fn()
  render(<AnalyticsEvents channelId="door" onClose={close}/>)
  expect(await screen.findByText(/越线 · 入口/)).toBeInTheDocument()
  expect(screen.getByText(/目标：session:1/)).toBeInTheDocument()
  await waitFor(()=>expect(screen.getByText('关闭事件记录')).toHaveFocus())
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'})
  expect(close).toHaveBeenCalledOnce()
 })
})
