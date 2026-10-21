import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi,beforeEach} from 'vitest'
import BehaviorStatisticsPage from '@/pages/AlarmCenter/BehaviorStatisticsPage'
import {behaviorStatisticsService} from '@/api/behaviorStatisticsService'
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn().mockResolvedValue([{id:'processor',name:'大门'}])}}))
vi.mock('@/api/behaviorStatisticsService',()=>({behaviorStatisticsService:{query:vi.fn()}}))
beforeEach(()=>{vi.mocked(behaviorStatisticsService.query).mockReset()})
const renderPage=()=>render(<MemoryRouter><BehaviorStatisticsPage/></MemoryRouter>)
it('queries selected processor and behavior and shows coverage uncertainty without adding behavior counts',async()=>{
 vi.mocked(behaviorStatisticsService.query).mockResolvedValue({schema_version:'1.0',from:'2026-10-19T00:00:00Z',to:'2026-10-19T01:00:00Z',items:[{event_type:'region_enter',occurrences:3,tracked_targets:2}],coverage:{state:'unknown'},buckets:[]})
 renderPage();await screen.findByRole('option',{name:'大门'})
 fireEvent.change(screen.getByLabelText('AI 通道'),{target:{value:'processor'}})
 fireEvent.change(screen.getByLabelText('行为'),{target:{value:'region_enter'}})
 fireEvent.click(screen.getByRole('button',{name:'查询'}))
 expect(await screen.findByText(/数据覆盖尚未确认/)).toBeInTheDocument()
 expect(behaviorStatisticsService.query).toHaveBeenCalledWith(expect.objectContaining({channel_id:'processor',event_type:'region_enter',bucket:'hour'}))
 expect(screen.getByRole('table')).toHaveTextContent('侵入32')
 fireEvent.change(screen.getByLabelText('行为'),{target:{value:'appearance'}})
 expect(screen.queryByRole('table')).not.toBeInTheDocument()
})
it('unavailable service is an error, never a zero count; retry preserves filters',async()=>{
 vi.mocked(behaviorStatisticsService.query).mockRejectedValue(Error('offline'))
 renderPage();fireEvent.click(screen.getByRole('button',{name:'查询'}))
 expect(await screen.findByRole('alert')).toHaveTextContent('未获得数据')
 expect(screen.queryByText('此范围没有已记录的行为。')).not.toBeInTheDocument()
 expect(screen.getByRole('link',{name:'查看服务配置'})).toHaveAttribute('href','/config-center?category=alarm-service')
 await waitFor(()=>expect(screen.getByRole('button',{name:'查询'})).toBeEnabled())
 fireEvent.click(screen.getByRole('button',{name:'查询'}));await screen.findByRole('alert');expect(behaviorStatisticsService.query).toHaveBeenCalledTimes(2)
})
it('invalid range is rejected without a request',async()=>{
 renderPage()
 fireEvent.change(screen.getByLabelText('开始时间'),{target:{value:'2026-10-20T00:00'}})
 fireEvent.change(screen.getByLabelText('结束时间'),{target:{value:'2026-10-19T00:00'}})
 fireEvent.click(screen.getByRole('button',{name:'查询'}))
 expect(await screen.findByRole('alert')).toHaveTextContent('结束晚于开始')
 expect(behaviorStatisticsService.query).not.toHaveBeenCalled()
})
it('sends a selected local timezone and direction grouping instead of silently bucketing in UTC',async()=>{
 render(<MemoryRouter><BehaviorStatisticsPage/></MemoryRouter>)
 fireEvent.change(screen.getByLabelText('统计时区'),{target:{value:'Asia/Shanghai'}})
 fireEvent.change(screen.getByLabelText('分组'),{target:{value:'entry_direction'}})
 fireEvent.click(screen.getByRole('button',{name:'查询'}))
 await waitFor(()=>expect(behaviorStatisticsService.query).toHaveBeenLastCalledWith(expect.objectContaining({timezone:'Asia/Shanghai',group_by:'entry_direction'})))
})
