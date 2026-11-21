import {render,screen,fireEvent} from '@testing-library/react'
import {beforeEach,it,expect,vi} from 'vitest'
import {ArmingLauncher} from '@/pages/AlarmCenter/ArmingLauncher'
import {ptzService} from '@/api/ptzService'
import {armingSceneService} from '@/api/armingSceneService'
import {alarmArmingService} from '@/api/alarmArmingService'
import {alarmDefinitionService} from '@/api/alarmDefinitionService'
import {alarmZoneService} from '@/api/alarmZoneService'
import {aiChannelService} from '@/api/aiChannelService'
import {mockChannels} from '@/mock/channels'
import {zoneSourceGeometry} from '@/features/zoneSourceGeometry'
vi.mock('@/api/ptzService',()=>({ptzService:{inspect:vi.fn(),restore:vi.fn()}}))
const editor=vi.hoisted(()=>vi.fn())
vi.mock('@/api/alarmArmingService',()=>({alarmArmingService:{read:vi.fn()}}))
vi.mock('@/api/armingSceneService',()=>({armingSceneService:{read:vi.fn(),freeze:vi.fn(),image:vi.fn()}}))
vi.mock('@/api/alarmDefinitionService',()=>({alarmDefinitionService:{list:vi.fn()}}))
vi.mock('@/api/alarmZoneService',()=>({alarmZoneService:{list:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn()}}))
vi.mock('@/pages/AlarmCenter/PresetArmingEntry',()=>({PresetArmingEntry:({onSelect,hasOrdinary}:{onSelect:(x:unknown)=>void;hasOrdinary?:boolean})=><>{hasOrdinary&&<button onClick={()=>onSelect(null)}>核对当前普通区域</button>}<button onClick={()=>onSelect({binding_mode:'preset',preset_id:'32',preset_fingerprint:'a'.repeat(64)})}>选择并确认到位</button></> }))
vi.mock('@/pages/AlarmCenter/ArmingModal',()=>({ArmingModal:(props:unknown)=>{editor(props);return <div data-testid="arming-props">{JSON.stringify(props)}</div>}}))
const channel=mockChannels[0]!
let video:HTMLVideoElement
beforeEach(()=>{
 vi.resetAllMocks();vi.mocked(ptzService.inspect).mockRejectedValue(Error('offline'))
 vi.mocked(armingSceneService.read).mockResolvedValue({eligible:false,identity:null,epoch:'0',items:[]})
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
it('uses an authenticated server-frozen reference and the matching scene snapshot for PTZ editing',async()=>{
 const geometry=zoneSourceGeometry(channel,1920,1080)!
 vi.mocked(armingSceneService.read).mockResolvedValue({eligible:true,identity:'physical-camera',epoch:'e1',items:[]})
 vi.mocked(armingSceneService.freeze).mockResolvedValue({frame_id:'f1',image_url:'/api/frozen-frame',identity:'physical-camera',epoch:'e1',
  width:1280,height:720,geometry_revision:geometry,captured_at:'frozen-time',items:[]})
 vi.mocked(armingSceneService.image).mockResolvedValue(new Blob(['trusted'],{type:'image/jpeg'}))
 render(<ArmingLauncher channel={channel} processorId="processor" video={video} onClose={vi.fn()} onSaved={vi.fn()}/> )
 const props=JSON.parse((await screen.findByTestId('arming-props')).textContent!)
 expect(props.sceneContext).toMatchObject({processorId:'processor',frame:{frame_id:'f1',epoch:'e1'}})
 expect(props.reference).toMatchObject({url:'blob:reference',width:1280,height:720,capturedAt:'frozen-time'})
 expect(armingSceneService.image).toHaveBeenCalledWith('/api/frozen-frame')
 expect(HTMLCanvasElement.prototype.toBlob).not.toHaveBeenCalled()
})
it('pins the ordinary restore to the reviewed motor and revision, requires a positive receipt and drops stale callbacks',async()=>{
 const geometry=zoneSourceGeometry(channel,1920,1080)!
 const guard={blocked:true,resource_key:'motor',source_ids:[channel.id],revision:7}
 const info={supported:true,source:{id:channel.id,name:'cam'},identity:'device',guard}
 vi.mocked(ptzService.inspect).mockResolvedValue(info)
 vi.mocked(armingSceneService.read).mockResolvedValue({eligible:true,guard_blocked:true,identity:'physical',epoch:'e',items:[]})
 vi.mocked(armingSceneService.freeze).mockResolvedValue({frame_id:'f1',image_url:'/api/image',binding_mode:'current',
  width:1280,height:720,captured_at:'t',geometry_revision:geometry,identity:'physical',epoch:'e',items:[]})
 vi.mocked(armingSceneService.image).mockResolvedValue(new Blob(['frame']))
 const ui=render(<ArmingLauncher channel={channel} processorId="ai" video={video} onClose={vi.fn()} onSaved={vi.fn()}/>)
 await screen.findByTestId('arming-props')
 const restore=editor.mock.lastCall![0].restoreAfterSave as ()=>Promise<void>
 expect(ptzService.restore).not.toHaveBeenCalled()
 for(const changed of [{...info,identity:'other'},{...info,guard:{...guard,revision:8}},{...info,guard:{...guard,resource_key:'other'}}]){
  vi.mocked(ptzService.inspect).mockResolvedValueOnce(changed);await expect(restore()).rejects.toThrow('version_conflict')
 }
 expect(ptzService.restore).not.toHaveBeenCalled()
 vi.mocked(ptzService.restore).mockResolvedValueOnce({restored:false}).mockResolvedValueOnce({restored:true})
 await expect(restore()).rejects.toThrow('ptz_restore_unconfirmed');await restore()
 expect(ptzService.restore).toHaveBeenCalledWith(channel.id,7,'rearmed')
 ui.unmount();await expect(restore()).rejects.toThrow('ptz_source_changed')
 expect(ptzService.restore).toHaveBeenCalledTimes(2)
})
it('does not silently render old bound coordinates when scene status cannot be read',async()=>{
 vi.mocked(armingSceneService.read).mockRejectedValue(new Error('场景服务暂不可用'))
 render(<ArmingLauncher channel={channel} video={video} onClose={vi.fn()} onSaved={vi.fn()}/> )
 expect(await screen.findByRole('alert')).toHaveTextContent('场景服务暂不可用')
 expect(screen.queryByTestId('arming-props')).not.toBeInTheDocument()
 expect(HTMLCanvasElement.prototype.toBlob).not.toHaveBeenCalled()
})
it('does not fall back to a browser image after trusted PTZ freeze fails',async()=>{
 vi.mocked(armingSceneService.read).mockResolvedValue({eligible:true,identity:'camera',epoch:'e1',items:[]})
 vi.mocked(armingSceneService.freeze).mockRejectedValue(new Error('场景已移动，请重试'))
 render(<ArmingLauncher channel={channel} processorId="ai" video={video} onClose={vi.fn()} onSaved={vi.fn()}/> )
 expect(await screen.findByRole('alert')).toHaveTextContent('场景已移动')
 expect(screen.queryByTestId('arming-props')).not.toBeInTheDocument()
 expect(HTMLCanvasElement.prototype.toBlob).not.toHaveBeenCalled()
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

it('finds whole-frame ordinary arming alongside preset zones and freezes without calling a preset',async()=>{
 const geometry=zoneSourceGeometry(channel,1920,1080)!
 const preset={zone_id:'z',processor_id:'ai',reference_frame_id:'ref',revision:2,reference_points:[],current_points:null,
  binding_mode:'preset' as const,preset_id:'32',state:'pending' as const}
 vi.mocked(armingSceneService.read).mockResolvedValue({eligible:true,identity:'camera',guard_blocked:true,epoch:'e',items:[preset],presetBindingAvailable:true})
 vi.mocked(alarmArmingService.read).mockResolvedValue({arming:{source_id:channel.id,revision:1,geometry_revision:geometry,zones:[],
  assignments:[{assignment_id:'a',processor_id:'ai',input_stream_id:channel.id,trigger_id:'t',zone_id:null,zone_version:null,
   label_map_version:'v',geometry_revision:geometry,entry_edges:[],exit_edges:[]}]}})
 vi.mocked(armingSceneService.freeze).mockResolvedValue({frame_id:'f1',image_url:'/api/frozen',width:1280,height:720,captured_at:'t',
  geometry_revision:geometry,epoch:'e',identity:'camera',items:[preset],binding_mode:'current'})
 vi.mocked(armingSceneService.image).mockResolvedValue(new Blob(['frame']))
 render(<ArmingLauncher channel={channel} processorId="ai" video={video} onClose={vi.fn()} onSaved={vi.fn()}/>)
 fireEvent.click(await screen.findByRole('button',{name:'核对当前普通区域'}))
 expect(await screen.findByTestId('arming-props')).toHaveTextContent('f1')
 expect(editor.mock.lastCall![0].restoreAfterSave).toBeUndefined()
 expect(armingSceneService.freeze).toHaveBeenCalledWith(channel.id,'ai',undefined)
})
it('waits for explicit preset selection and refuses a different frozen home',async()=>{
 vi.mocked(armingSceneService.read).mockResolvedValue({eligible:true,presetBindingAvailable:true,identity:'camera',epoch:'e1',items:[]})
 vi.mocked(armingSceneService.freeze).mockResolvedValue({frame_id:'f1',image_url:'/api/frozen-frame',identity:'camera',epoch:'e1',width:1920,height:1080,geometry_revision:zoneSourceGeometry(channel,1920,1080)!,captured_at:'now',items:[],binding_mode:'preset',preset_id:'other',preset_fingerprint:'a'.repeat(64)})
 render(<ArmingLauncher channel={channel} processorId="ai" video={video} onClose={vi.fn()} onSaved={vi.fn()}/> )
 const select=await screen.findByRole('button',{name:'选择并确认到位'})
 expect(armingSceneService.freeze).not.toHaveBeenCalled()
 fireEvent.click(select)
 expect(await screen.findByRole('alert')).toHaveTextContent('布防预置位已变化')
 expect(armingSceneService.image).not.toHaveBeenCalled()
 expect(screen.queryByTestId('arming-props')).not.toBeInTheDocument()
})
