import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {beforeEach,expect,it,vi} from 'vitest'
import {HeatScene} from '@/pages/Analytics/HeatScene'
import type {HeatVariant} from '@/pages/Analytics/RegionHeatPanel'
const mock=vi.hoisted(()=>({listSegments:vi.fn(),preparePlayback:vi.fn(),playUrl:vi.fn()}))
vi.mock('@/api/recordingService',()=>({createHttpRecordingService:()=>mock}))
const start=Date.parse('2026-10-30T01:00:00Z')
const variant={input_stream_id:'source',geometry_revision:'g',view_epoch:null,zone_version:1,source_width:1920,source_height:1080,columns:16,rows:9,values_ms:[],observed_ms:1,from:new Date(start).toISOString(),to:new Date(start+60000).toISOString()} satisfies HeatVariant
beforeEach(()=>{vi.clearAllMocks();mock.preparePlayback.mockResolvedValue(undefined);mock.playUrl.mockReturnValue('/api/v1/recordings/segment/play')})
it('never uses a wrong source or resized recording as the scene background',async()=>{
 mock.listSegments.mockResolvedValue([{id:'wrong',channelId:'other',startTs:start,width:1920,height:1080},{id:'resize',channelId:'source',startTs:start,width:960,height:540}])
 render(<HeatScene variant={variant}><span>真实网格</span></HeatScene>)
 expect(mock.listSegments).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'载入录像参考画面'}))
 expect(await screen.findByText(/没有同源同尺寸录像/)).toBeInTheDocument()
 expect(mock.preparePlayback).not.toHaveBeenCalled()
 expect(screen.getByText('真实网格')).toBeInTheDocument()
})
it('reuses a recording only as a qualified reference and rejects decoded dimension mismatches',async()=>{
 mock.listSegments.mockResolvedValue([{id:'segment',channelId:'source',startTs:start,width:1920,height:1080}])
 const {container}=render(<HeatScene variant={variant}><span>真实网格</span></HeatScene>)
 fireEvent.click(screen.getByRole('button',{name:'载入录像参考画面'}))
 await waitFor(()=>expect(container.querySelector('video')).not.toBeNull())
 const video=container.querySelector('video')!
 Object.defineProperties(video,{videoWidth:{value:960},videoHeight:{value:540},pause:{value:vi.fn()}})
 fireEvent.loadedData(video)
 expect(await screen.findByText(/实际尺寸与统计坐标不一致/)).toBeInTheDocument()
 expect(container.querySelector('video')).toBeNull()
})
