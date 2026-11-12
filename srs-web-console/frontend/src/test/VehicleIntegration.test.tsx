import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach,expect,it,vi} from 'vitest'
import {VehicleHistory} from '@/features/vehicles/VehicleHistory'
import {VehicleChannelSettings,VehicleWatchlistSettings} from '@/features/vehicles/VehicleSettings'
import {vehicleService} from '@/api/vehicleService'
import {flowService,type Counter} from '@/api/flowService'
vi.mock('@/api/vehicleService',()=>({vehicleService:{counters:vi.fn(),channel:vi.fn(),saveChannel:vi.fn(),watchlist:vi.fn(),saveWatchlist:vi.fn()}}))
vi.mock('@/api/flowService',()=>({flowService:{records:vi.fn()}}))
const capability={state:'pending_model_integration' as const,effective:false as const,reason:'pending',blockers:[]}
const counter={counter_id:'car-counter',name:'车辆进出',labels:[{label_id:'car',name:'car'}],outputs:'both',names:{in:'进入',out:'离开'},bindings:[{binding_id:'entry',processor_id:'processor',source_id:'camera',zone_id:'z',zone_name:'入口',active:true}]} as Counter
beforeEach(()=>{vi.clearAllMocks();vi.mocked(vehicleService.counters).mockResolvedValue({items:[counter],excluded:0,capability});vi.mocked(flowService.records).mockResolvedValue({items:[{event_id:'real-event',occurred_at:'2026-11-11T01:00:00Z',track_id:'1',label_id:'car',frame_id:'f',stream_session_id:'s'}],next_cursor:null})})
it('uses real passage API and existing recording navigation without invented plate results',async()=>{
 render(<MemoryRouter><VehicleHistory/></MemoryRouter>);await screen.findByText('未执行识别');expect(flowService.records).toHaveBeenCalledWith(expect.objectContaining({counter_id:'car-counter',binding_id:'entry',output:'in'}));expect(screen.getByRole('link',{name:'关联录像'})).toHaveAttribute('href',expect.stringContaining('/playback/camera?from='));expect(screen.queryByText('未检出车牌')).not.toBeInTheDocument()
})
it('retains channel scope and shows an honest setup state',async()=>{render(<MemoryRouter><VehicleHistory channelId="different"/></MemoryRouter>);await screen.findByText('尚无可查询的车辆计数器');expect(flowService.records).not.toHaveBeenCalled();expect(screen.getByRole('link',{name:'配置计数器'})).toHaveAttribute('href','/flow-statistics')})
it('saves pending configuration and does not claim activation',async()=>{
 vi.mocked(vehicleService.channel).mockResolvedValue({version:2,document:{requested:false},capability});vi.mocked(vehicleService.saveChannel).mockResolvedValue({version:3,document:{requested:true},capability});render(<MemoryRouter><VehicleChannelSettings id="processor"/></MemoryRouter>);
 const checkbox=screen.getByRole('checkbox');await waitFor(()=>expect(checkbox).toBeEnabled());fireEvent.click(checkbox);fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await screen.findByText('配置已保存；模型加载和运行状态请刷新核对。');expect(vehicleService.saveChannel).toHaveBeenCalledWith('processor',2,true)
})
it('keeps a conflicting watchlist draft instead of falsely succeeding',async()=>{
 vi.mocked(vehicleService.watchlist).mockResolvedValue({version:3,document:{entries:[]},capability});vi.mocked(vehicleService.saveWatchlist).mockRejectedValue(Error('配置已变化，请重新载入后保存'));render(<MemoryRouter><VehicleWatchlistSettings/></MemoryRouter>);await screen.findByText('尚无关注车牌');fireEvent.change(screen.getByLabelText('关注车牌'),{target:{value:'京A12345'}});fireEvent.click(screen.getByRole('button',{name:'加入关注名单'}));await screen.findByRole('alert');expect(screen.getByLabelText('关注车牌')).toHaveValue('京A12345')
})

it('refreshes the selected counter and direction without resetting filters',async()=>{
 const second={...counter,counter_id:'second',name:'停车场'};
 vi.mocked(vehicleService.counters).mockResolvedValue({items:[counter,second],excluded:0,capability});
 render(<MemoryRouter><VehicleHistory/></MemoryRouter>);await screen.findByText('未执行识别');
 fireEvent.change(screen.getByLabelText('车辆计数器'),{target:{value:'second'}});
 fireEvent.change(screen.getByLabelText('车辆通行方向'),{target:{value:'out'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'刷新车辆记录'})).toBeEnabled());
 vi.mocked(flowService.records).mockClear();fireEvent.click(screen.getByRole('button',{name:'刷新车辆记录'}));
 await waitFor(()=>expect(flowService.records).toHaveBeenCalledWith(expect.objectContaining({counter_id:'second',output:'out'})));
 expect(screen.getByLabelText('车辆计数器')).toHaveValue('second');expect(screen.getByLabelText('车辆通行方向')).toHaveValue('out');
})
