import {act,cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {PtzSceneStatus} from '@/components/player/PtzSceneStatus'
import {armingSceneService,type ArmingScenes} from '@/api/armingSceneService'
vi.mock('@/api/armingSceneService',async original=>({...await original<typeof import('@/api/armingSceneService')>(),armingSceneService:{read:vi.fn()}}))
const value:ArmingScenes={eligible:true,identity:'camera',epoch:'e',items:[{zone_id:'z',processor_id:'ai',revision:1,
 reference_points:[[0,0],[1,0],[1,1]],current_points:null,state:'unmatched',reference_frame_id:'f',binding_mode:'preset',preset_id:'32'}]}
beforeEach(()=>{vi.useFakeTimers();vi.mocked(armingSceneService.read).mockReset()})
afterEach(()=>{cleanup();vi.useRealTimers()})
it('returns only on an explicit user action and explains the monitoring gap',async()=>{
 vi.mocked(armingSceneService.read).mockResolvedValue(value);const back=vi.fn()
 await act(async()=>{render(<PtzSceneStatus sourceId="input" processorId="ai" onReturn={back}/>)})
 expect(back).not.toHaveBeenCalled();expect(screen.getByRole('status')).toHaveTextContent('相关告警与计数暂停')
 fireEvent.click(screen.getByRole('button',{name:'返回布防视角'}));expect(back).toHaveBeenCalledWith('32')
 expect(armingSceneService.read).toHaveBeenCalledWith('input','ai')
})
it('does not keep claiming verification success after a failed status poll',async()=>{
 vi.mocked(armingSceneService.read).mockResolvedValueOnce({...value,items:[{...value.items[0]!,state:'matched'}]}).mockRejectedValue(new Error('offline'))
 await act(async()=>{render(<PtzSceneStatus sourceId="input" processorId="ai" onReturn={vi.fn()}/>)})
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
 expect(screen.getByRole('status')).toHaveTextContent('状态暂未更新')
 expect(screen.getByRole('status')).not.toHaveTextContent('核验通过')
 expect(screen.getByRole('button',{name:'返回布防视角'})).toBeDisabled()
})
it('renders no scene UI for a fixed camera with no binding',async()=>{
 vi.mocked(armingSceneService.read).mockResolvedValue({eligible:false,identity:null,epoch:'0',items:[]})
 await act(async()=>{render(<PtzSceneStatus sourceId="fixed" processorId="ai"/>)})
 expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
it('does not equate view verification with applied alarm configuration',async()=>{
 vi.mocked(armingSceneService.read).mockResolvedValue({...value,items:[{...value.items[0]!,state:'matched'}]})
 await act(async()=>{render(<PtzSceneStatus sourceId="input" processorId="ai"/>)})
 expect(screen.getByRole('status')).toHaveTextContent('告警是否生效以布防配置为准')
 expect(screen.getByRole('status')).not.toHaveTextContent('布防已生效')
})
it('retains old experimental records as paused instead of advertising successful arming',async()=>{
 vi.mocked(armingSceneService.read).mockResolvedValue({...value,items:[{...value.items[0]!,binding_mode:'experimental_projection',state:'matched'}]})
 await act(async()=>{render(<PtzSceneStatus sourceId="input" processorId="ai" onReturn={vi.fn()}/>)})
 expect(screen.getByRole('status')).toHaveTextContent('旧版自动附着已暂停')
 expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
