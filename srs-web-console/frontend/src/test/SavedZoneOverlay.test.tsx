import {act,render,screen,fireEvent,waitFor} from '@testing-library/react'
import {beforeEach,it,expect,vi} from 'vitest'
import {subscribeLiveCounts} from '@/features/flowLiveCounts'
import {SavedZoneOverlay} from '@/components/player/SavedZoneOverlay'
import {alarmZoneService,type AlarmZone} from '@/api/alarmZoneService'
import {alarmArmingService} from '@/api/alarmArmingService'
import {armingSceneService} from '@/api/armingSceneService'
import {zoneSourceGeometry} from '@/features/zoneSourceGeometry'
import {projectOverlayZones} from '@/features/zoneOverlaySubscriptions'
import type {ArmingScene} from '@/api/armingSceneService'
vi.mock('@/features/flowLiveCounts',()=>({subscribeLiveCounts:vi.fn(()=>()=>{})}))
vi.mock('@/api/alarmArmingService',()=>({alarmArmingService:{read:vi.fn()}}))
vi.mock('@/api/armingSceneService',()=>({armingSceneService:{read:vi.fn()}}))
vi.mock('@/api/alarmZoneService',()=>({alarmZoneService:{list:vi.fn()}}))
const source={id:'gate',createdAt:'2026-10-19T01:00:00Z',updatedAt:'2026-10-19T01:00:00Z'}
const zone:AlarmZone={zone_id:'zone',channel_id:'gate',name:'入口',geometry_revision:'source-frame-v2:gate:2026-10-19T01:00:00.000Z:1920x1080',version:2,state:'active',points:[[.1,.1],[.8,.1],[.8,.8]]}
let video:HTMLVideoElement
beforeEach(()=>{
 vi.resetAllMocks();vi.mocked(alarmArmingService.read).mockResolvedValue({arming:null});vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}})
 vi.mocked(armingSceneService.read).mockResolvedValue({eligible:false,identity:null,epoch:'e',items:[]})
 video=document.createElement('video')
 Object.defineProperties(video,{videoWidth:{value:1920,configurable:true},videoHeight:{value:1080,configurable:true},clientWidth:{value:1000,configurable:true},clientHeight:{value:1000,configurable:true}})
})
it('automatically loads and positions regions inside the video letterbox without visibility controls',async()=>{
 vi.mocked(alarmZoneService.list).mockResolvedValue({items:[zone]})
 render(<SavedZoneOverlay video={video} source={source}/>)
 const svg=await screen.findByLabelText('已保存警戒区')
 expect(svg).toHaveStyle({left:'0px',top:'218.75px',width:'1000px',height:'562.5px'})
 expect(svg.querySelector('polygon')).toHaveAttribute('points','100,56.25 800,56.25 800,450')
 expect(svg).toHaveTextContent('入口')
 expect(screen.queryByRole('button',{name:/警戒区/})).not.toBeInTheDocument()
})
it('hides incompatible geometry, other channels and archived zones',async()=>{
 vi.mocked(alarmZoneService.list).mockResolvedValue({items:[zone,{...zone,zone_id:'old',geometry_revision:'old'},{...zone,zone_id:'other',channel_id:'other'},{...zone,zone_id:'archived',state:'archived'}]})
 const view=render(<SavedZoneOverlay video={video} source={source}/>)
 expect(await screen.findByText(/1 个区域与当前画面/)).toBeInTheDocument()
 expect(screen.getByLabelText('已保存警戒区').querySelectorAll('polygon')).toHaveLength(1)
 Object.defineProperty(video,'videoWidth',{value:3840});fireEvent(video,new Event('resize'))
 await waitFor(()=>expect(screen.getByLabelText('已保存警戒区').querySelectorAll('polygon')).toHaveLength(0))
 view.rerender(<SavedZoneOverlay video={video} source={source} transformed/>)
 expect(screen.queryByLabelText('已保存警戒区')).not.toBeInTheDocument()
 expect(screen.getByRole('status')).toHaveTextContent('2 个区域与当前画面')
})
it('failed reads hide geometry and refresh after successful arming save',async()=>{
 vi.mocked(alarmZoneService.list).mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce({items:[zone]})
 render(<SavedZoneOverlay video={video} source={source}/>)
 await screen.findByText(/警戒区读取失败/)
 fireEvent(window,new Event('ainvr-arming-saved'))
 expect(await screen.findByLabelText('已保存警戒区')).toHaveTextContent('入口')
})
it('does not apply an earlier channel response after switching source',async()=>{
 let resolve!:(v:{items:AlarmZone[]})=>void
 vi.mocked(alarmZoneService.list).mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValueOnce({items:[]})
 const view=render(<SavedZoneOverlay video={video} source={source}/>)
 view.rerender(<SavedZoneOverlay video={video} source={{...source,id:'next'}}/>)
 await waitFor(()=>expect(alarmZoneService.list).toHaveBeenCalledWith('next'))
 resolve({items:[zone]})
 await waitFor(()=>expect(screen.queryByText('入口')).not.toBeInTheDocument())
 expect(zoneSourceGeometry(source,1920,1080)).toBe(zone.geometry_revision)
 expect(zoneSourceGeometry({...source,createdAt:'invalid'},1920,1080)).toBeNull()
})

it('cosmetic edits keep the same geometry while source replacement invalidates it',()=>{
 const original=zoneSourceGeometry(source,1920,1080)
 expect(zoneSourceGeometry({...source,updatedAt:'2026-10-20T00:00:00Z'},1920,1080)).toBe(original)
 expect(zoneSourceGeometry({...source,inputGeneration:'replacement'},1920,1080)).not.toBe(original)
 expect(zoneSourceGeometry({...source,createdAt:undefined},1920,1080)).toBeNull()
})

it('new arming snapshot is authoritative and compact grid omits names',async()=>{
 vi.mocked(alarmArmingService.read).mockResolvedValue({arming:{source_id:source.id,geometry_revision:zone.geometry_revision,revision:1,zones:[{...zone,state:'active',edge_ids:['a','b','c']}],assignments:[]}})
 render(<SavedZoneOverlay video={video} source={source} compact/>)
 const svg=await screen.findByLabelText('已保存警戒区')
 expect(svg.querySelectorAll('polygon')).toHaveLength(1)
 expect(svg.querySelector('text')).toBeNull();expect(alarmZoneService.list).not.toHaveBeenCalled()
})

it('shares one read for multiple players of the same source and refreshes them together',async()=>{
 vi.mocked(alarmZoneService.list).mockResolvedValue({items:[zone]})
 render(<><SavedZoneOverlay video={video} source={source}/><SavedZoneOverlay video={video} source={source}/></>)
 await waitFor(()=>expect(screen.getAllByLabelText('已保存警戒区')).toHaveLength(2))
 expect(alarmArmingService.read).toHaveBeenCalledTimes(1)
 fireEvent(window,new Event('ainvr-arming-saved'))
 await waitFor(()=>expect(alarmArmingService.read).toHaveBeenCalledTimes(2))
})

it('uses a separate projected canvas in panorama instead of hiding compatible zones',async()=>{
 vi.mocked(alarmZoneService.list).mockResolvedValue({items:[zone]})
 const get=vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null)
 try{
  render(<SavedZoneOverlay video={video} source={source} transformed camera={{current:null}}/>)
  expect(await screen.findByLabelText('全景警戒区')).toBeInTheDocument()
  expect(screen.queryByLabelText('已保存警戒区')).not.toBeInTheDocument()
  expect(screen.queryByText(/请切回原始画面/)).not.toBeInTheDocument()
 }finally{get.mockRestore()}
})

const scene:ArmingScene={zone_id:'zone',processor_id:'ai',revision:3,reference_frame_id:'f',
 reference_points:zone.points,current_points:[[.2,.2],[.9,.2],[.9,.9]],state:'matched'}
it('uses projected points for both saved polygons and counting markers, hiding both on pending or failed reads',async()=>{
 const scoped={...source,processorId:'ai'}
 vi.mocked(alarmArmingService.read).mockResolvedValue({arming:{source_id:source.id,geometry_revision:zone.geometry_revision,revision:1,
  zones:[{...zone,state:'active',edge_ids:['a','b','c']}],assignments:[],counter_bindings:[{
   binding_id:'count',counter_id:'counter',input_stream_id:source.id,processor_id:'ai',zone_id:'zone',zone_version:2,
   geometry_revision:zone.geometry_revision,label_map_version:'labels',direction:{kind:'line',edge:'a',in_side:'inward'}}]}})
 vi.mocked(armingSceneService.read).mockResolvedValue({eligible:true,identity:'camera',epoch:'e',items:[scene]})
 render(<SavedZoneOverlay video={video} source={scoped}/>)
 const svg=await screen.findByLabelText('已保存警戒区')
 expect(svg.querySelector('polygon')).toHaveAttribute('points','200,112.5 900,112.5 900,506.25')
 expect(screen.getByLabelText('计数线').querySelector('line')).toHaveAttribute('x1','200')
 expect(screen.getByLabelText('计数线').querySelector('line')).toHaveAttribute('y1','112.5')
 vi.mocked(armingSceneService.read).mockResolvedValue({eligible:true,identity:'camera',epoch:'new',items:[{...scene,state:'pending',current_points:null}]})
 fireEvent(window,new Event('ainvr-arming-saved'))
 await waitFor(()=>expect(svg.querySelectorAll('polygon')).toHaveLength(0))
 expect(screen.queryByLabelText('计数线')).not.toBeInTheDocument()
 vi.mocked(armingSceneService.read).mockRejectedValue(Error('offline'))
 fireEvent(window,new Event('ainvr-arming-saved'))
 await screen.findByText(/警戒区读取失败/)
 expect(screen.queryByLabelText('已保存警戒区')).not.toBeInTheDocument()
 expect(zone.points).toEqual([[.1,.1],[.8,.1],[.8,.8]])
})
it('shows ordinary guard pauses on the polygon and counter badge while preserving historical totals',async()=>{
 const scoped={...source,processorId:'ai'}
 vi.mocked(alarmArmingService.read).mockResolvedValue({arming:{source_id:source.id,geometry_revision:zone.geometry_revision,revision:1,
  zones:[{...zone,state:'active',edge_ids:['a','b','c']}],assignments:[],counter_bindings:[{
   binding_id:'count',counter_id:'counter',input_stream_id:source.id,processor_id:'ai',zone_id:'zone',zone_version:2,
   geometry_revision:zone.geometry_revision,label_map_version:'labels',direction:{kind:'line',edge:'a',in_side:'inward'}}]}})
 const state={eligible:true,identity:'cam',epoch:'e',items:[]}
 vi.mocked(armingSceneService.read).mockResolvedValue({...state,guard_blocked:true})
 let publishCounts!:()=>void
 vi.mocked(subscribeLiveCounts).mockImplementation((_,listener)=>{
  publishCounts=()=>listener([{binding_id:'count',name:'门口',counter_id:'counter',zone_id:'zone',counting:true,outputs:'both',occupancy:false,
   direction:{kind:'line',edge:'a',in_side:'inward'},in:17,out:9,names:{in:'进',out:'出'}}],{stale:false,updatedAt:Date.now()})
  return ()=>{}
 })
 render(<SavedZoneOverlay video={video} source={scoped}/>)
 const emptyBadge=await screen.findByText('统计已暂停')
 expect(emptyBadge).not.toHaveTextContent(/0|今日累计/)
 await act(async()=>publishCounts())
 const badge=await screen.findByText(/统计已暂停.*今日累计.*进 17.*出 9/)
 const polygon=screen.getByLabelText('已保存警戒区').querySelector('polygon')!
 expect(polygon).toHaveAttribute('stroke-dasharray')
 vi.mocked(armingSceneService.read).mockResolvedValue(state)
 fireEvent(window,new Event('ainvr-arming-saved'))
 await waitFor(()=>expect(badge).toHaveTextContent(/保护状态待核对.*进 17/))
 vi.mocked(armingSceneService.read).mockResolvedValue({...state,guard_blocked:true,items:[scene]})
 fireEvent(window,new Event('ainvr-arming-saved'))
 await waitFor(()=>expect(polygon).not.toHaveAttribute('stroke-dasharray'))
 expect(badge).toHaveTextContent('进 17 · 出 9')
 expect(badge).not.toHaveTextContent(/暂停|待核对/)
})
it('rejects null, malformed, stale-reference and ambiguous projections without mutating the saved base',()=>{
 for(const invalid of [{...scene,current_points:null},{...scene,state:'pending' as const},
  {...scene,current_points:[[NaN,.1],[.4,.1],[.4,.4]] as [number,number][]},
  {...scene,reference_points:[[.2,.2],[.4,.2],[.4,.4]] as [number,number][]}]){
  expect(projectOverlayZones([zone],[invalid],'ai')).toEqual([])
 }
 expect(projectOverlayZones([zone],[scene,{...scene,processor_id:'other'}])).toEqual([])
 expect(projectOverlayZones([zone],[scene],'other')).toEqual([zone])
 expect(projectOverlayZones([zone],[])).toEqual([zone])
})
