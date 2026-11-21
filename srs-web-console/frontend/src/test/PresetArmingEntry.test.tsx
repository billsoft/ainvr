import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {PresetArmingEntry} from '@/pages/AlarmCenter/PresetArmingEntry'
import {ptzService} from '@/api/ptzService'
const control=vi.hoisted(()=>({state:'idle',error:'',notice:'',begin:vi.fn(),stop:vi.fn(),stopConfirmed:vi.fn()}))
vi.mock('@/components/player/usePtzControl',()=>({usePtzControl:()=>control}))
vi.mock('@/api/ptzService',()=>({ptzService:{inspect:vi.fn(),presets:vi.fn()},ptzError:()=> '设备不可用'}))
const status={eligible:true,identity:'camera',epoch:'e',items:[],presetBindingAvailable:true}
beforeEach(()=>{vi.clearAllMocks();control.stopConfirmed.mockResolvedValue(true)
 vi.mocked(ptzService.inspect).mockResolvedValue({supported:true,identity:'camera',source:{id:'cam',name:'球机'}})
 vi.mocked(ptzService.presets).mockResolvedValue({supported:true,items:[{id:'32',name:'入口',fingerprint:'rev-1',available:true}]})
})
afterEach(cleanup)
it('requires explicit preset choice and confirmed arrival before opening the editor',async()=>{
 const select=vi.fn();render(<PresetArmingEntry sourceId="cam" status={status} onSelect={select} onClose={vi.fn()}/>)
 await screen.findByRole('option',{name:'入口'});expect(control.begin).not.toHaveBeenCalled()
 expect(screen.getByRole('button',{name:'转到预置位并编辑'})).toBeDisabled()
 fireEvent.change(screen.getByRole('combobox',{name:'布防预置位'}),{target:{value:'32'}})
 fireEvent.click(screen.getByRole('button',{name:'转到预置位并编辑'}));expect(select).not.toHaveBeenCalled()
 expect(control.begin.mock.calls[0]![1]).toEqual({id:'32',fingerprint:'rev-1'})
 const complete=control.begin.mock.calls[0]![2];complete(false);expect(select).not.toHaveBeenCalled()
 complete(true);expect(select).toHaveBeenCalledWith({binding_mode:'preset',preset_id:'32',preset_fingerprint:'rev-1'})
})
it('offers ordinary arming without moving or changing presets',async()=>{
 const select=vi.fn();render(<PresetArmingEntry sourceId="cam" status={status} onSelect={select} onClose={vi.fn()}/>)
 await screen.findByRole('option',{name:'入口'})
 fireEvent.click(screen.getByRole('button',{name:'仅编辑当前画面'}));expect(select).toHaveBeenCalledWith(null)
 expect(control.begin).not.toHaveBeenCalled()
})
it('cancel and the close control stop movement and never save',async()=>{
 const close=vi.fn(),select=vi.fn();render(<PresetArmingEntry sourceId="cam" status={status} onSelect={select} onClose={close}/>)
 await screen.findByRole('option',{name:'入口'})
 fireEvent.click(screen.getByRole('button',{name:'关闭'}));await waitFor(()=>expect(close).toHaveBeenCalledOnce())
 expect(select).not.toHaveBeenCalled();expect(control.stopConfirmed).toHaveBeenCalledOnce()
})
it('opens an ordinary mixed-view review without moving or implicitly choosing an overwritten home',async()=>{
 const select=vi.fn()
 const items=[{zone_id:'z',processor_id:'ai',revision:1,reference_points:[],current_points:null,state:'pending' as const,
  reference_frame_id:'f',binding_mode:'preset' as const,preset_id:'32',preset_fingerprint:'previous'}]
 render(<PresetArmingEntry sourceId="cam" status={{...status,items}} hasOrdinary onSelect={select} onClose={vi.fn()}/>)
 await screen.findByRole('option',{name:'入口'})
 expect(screen.getByRole('button',{name:'转到预置位并编辑'})).toBeDisabled()
 fireEvent.click(screen.getByRole('button',{name:'核对当前普通区域'}))
 expect(select).toHaveBeenCalledWith(null);expect(control.begin).not.toHaveBeenCalled()
})
it('does not fall back to unverified ordinary editing for a bound preset',async()=>{
 const items=[{zone_id:'z',processor_id:'ai',revision:1,reference_points:[[0,0],[1,0],[1,1]] as [number,number][],current_points:null,state:'pending' as const,reference_frame_id:'f',binding_mode:'preset' as const,preset_id:'32'}]
 render(<PresetArmingEntry sourceId="cam" status={{...status,items}} onSelect={vi.fn()} onClose={vi.fn()}/>)
 await screen.findByRole('option',{name:'入口'})
 expect(screen.queryByRole('button',{name:'仅编辑当前画面'})).not.toBeInTheDocument()
})
