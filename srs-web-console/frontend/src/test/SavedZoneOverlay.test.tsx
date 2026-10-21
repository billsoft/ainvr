import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {beforeEach,it,expect,vi} from 'vitest'
import {SavedZoneOverlay} from '@/components/player/SavedZoneOverlay'
import {alarmZoneService,type AlarmZone} from '@/api/alarmZoneService'
import {alarmArmingService} from '@/api/alarmArmingService'
import {zoneSourceGeometry} from '@/features/zoneSourceGeometry'
vi.mock('@/api/alarmArmingService',()=>({alarmArmingService:{read:vi.fn()}}))
vi.mock('@/api/alarmZoneService',()=>({alarmZoneService:{list:vi.fn()}}))
const source={id:'gate',createdAt:'2026-10-19T01:00:00Z',updatedAt:'2026-10-19T01:00:00Z'}
const zone:AlarmZone={zone_id:'zone',channel_id:'gate',name:'入口',geometry_revision:'source-frame-v2:gate:2026-10-19T01:00:00.000Z:1920x1080',version:2,state:'active',points:[[.1,.1],[.8,.1],[.8,.8]]}
let video:HTMLVideoElement
beforeEach(()=>{
 vi.resetAllMocks();vi.mocked(alarmArmingService.read).mockResolvedValue({arming:null});vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}})
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
