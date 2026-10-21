import {render,screen,fireEvent} from '@testing-library/react'
import {beforeEach,it,expect,vi} from 'vitest'
import {ArmingLauncher} from '@/pages/AlarmCenter/ArmingLauncher'
import {alarmArmingService} from '@/api/alarmArmingService'
import {alarmDefinitionService} from '@/api/alarmDefinitionService'
import {alarmZoneService} from '@/api/alarmZoneService'
import {aiChannelService} from '@/api/aiChannelService'
import {mockChannels} from '@/mock/channels'
import {zoneSourceGeometry} from '@/features/zoneSourceGeometry'
vi.mock('@/api/alarmArmingService',()=>({alarmArmingService:{read:vi.fn()}}))
vi.mock('@/api/alarmDefinitionService',()=>({alarmDefinitionService:{list:vi.fn()}}))
vi.mock('@/api/alarmZoneService',()=>({alarmZoneService:{list:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn()}}))
vi.mock('@/pages/AlarmCenter/ArmingModal',()=>({ArmingModal:(props:unknown)=><div data-testid="arming-props">{JSON.stringify(props)}</div>}))
const channel=mockChannels[0]!
let video:HTMLVideoElement
beforeEach(()=>{
 vi.resetAllMocks()
 video=document.createElement('video')
 Object.defineProperties(video,{readyState:{value:3},paused:{value:false},videoWidth:{value:1920},videoHeight:{value:1080}})
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn()} as unknown as CanvasRenderingContext2D)
 vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(callback=>callback(new Blob(['frame'])))
 URL.createObjectURL=vi.fn(()=> 'blob:reference');URL.revokeObjectURL=vi.fn()
 vi.mocked(alarmArmingService.read).mockResolvedValue({arming:null})
 vi.mocked(alarmDefinitionService.list).mockResolvedValue({items:[]})
 vi.mocked(alarmZoneService.list).mockResolvedValue({items:[]})
 vi.mocked(aiChannelService.list).mockResolvedValue([])
})
it('preserves legacy unassigned zones in initial editor and releases captured image on close',async()=>{
 const geometry=zoneSourceGeometry(channel,1920,1080)!
 vi.mocked(alarmZoneService.list).mockResolvedValue({items:[{zone_id:'old',channel_id:channel.id,geometry_revision:geometry,state:'active',name:'旧区域',version:2,points:[[0,0],[1,0],[1,1]]}]})
 const view=render(<ArmingLauncher channel={channel} video={video} onClose={vi.fn()} onSaved={vi.fn()}/> )
 expect(await screen.findByTestId('arming-props')).toHaveTextContent('旧区域')
 expect(video.paused).toBe(false)
 view.unmount();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reference')
})
it('does not resurrect legacy zones after new arming document has removed them',async()=>{
 vi.mocked(alarmArmingService.read).mockResolvedValue({arming:{source_id:channel.id,geometry_revision:zoneSourceGeometry(channel,1920,1080)!,revision:1,zones:[],assignments:[]}})
 render(<ArmingLauncher channel={channel} video={video} onClose={vi.fn()} onSaved={vi.fn()}/> )
 await screen.findByTestId('arming-props');expect(alarmZoneService.list).not.toHaveBeenCalled()
})
it('requires explicit geometry reset and carries original revision into the unsaved draft',async()=>{
 vi.mocked(alarmArmingService.read).mockResolvedValue({arming:{source_id:channel.id,geometry_revision:'old',revision:7,zones:[],assignments:[]}})
 render(<ArmingLauncher channel={channel} video={video} onClose={vi.fn()} onSaved={vi.fn()}/> )
 fireEvent.click(await screen.findByRole('button',{name:'按当前画面重新布防'}))
 const props=JSON.parse(screen.getByTestId('arming-props').textContent!)
 expect(props.resetGeometry).toBe(true)
 expect(props.base.revision).toBe(7)
 expect(props.base.geometry_revision).toBe('old')
 expect(props.reference.geometryRevision).toBe(zoneSourceGeometry(channel,1920,1080))
})
it('requires explicit redraw for mismatched legacy zones and never silently imports them',async()=>{
 vi.mocked(alarmZoneService.list).mockResolvedValue({items:[{zone_id:'old',channel_id:channel.id,geometry_revision:'wrong',state:'active',name:'旧区域',version:2,points:[[0,0],[1,0],[1,1]]}]})
 render(<ArmingLauncher channel={channel} video={video} onClose={vi.fn()} onSaved={vi.fn()}/> )
 await screen.findByRole('dialog',{name:'画面规格已变化'})
 expect(screen.queryByTestId('arming-props')).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'按当前画面重新布防'}))
 const props=JSON.parse(screen.getByTestId('arming-props').textContent!)
 expect(props.base).toBeNull()
 expect(props.legacyZones).toEqual([])
 expect(props.resetLegacyGeometry).toBe(true)
 expect(props.resetGeometry).toBe(false)
})
