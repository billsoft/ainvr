import {erpDisplayPolygons} from '@/features/erpGeometry'
import {useEffect,useState,type RefObject} from 'react'
import {PanoramaZoneOverlay} from './PanoramaZoneOverlay'
import type {PanoramaCamera} from './panoramaDetection'
import type {AlarmZone} from '@/api/alarmZoneService'
import {subscribeZoneOverlay} from '@/features/zoneOverlaySubscriptions'
import {zoneSourceGeometry,type ZonePreviewSource} from '@/features/zoneSourceGeometry'
import {computeContainLayout} from './overlayGeometry'
interface Props {video:HTMLVideoElement|null;source:ZonePreviewSource;transformed?:boolean;resetKey?:number;compact?:boolean;camera?:RefObject<PanoramaCamera|null>}
export function SavedZoneOverlay({video,source,transformed=false,resetKey,compact=false,camera}:Props){
 const [zones,setZones]=useState<AlarmZone[]>([])
 const [loaded,setLoaded]=useState(false),[failed,setFailed]=useState(false)
 const [size,setSize]=useState({width:0,height:0,boxWidth:0,boxHeight:0})
 useEffect(()=>{
  if(!video){setSize({width:0,height:0,boxWidth:0,boxHeight:0});return}
  const measure=()=>setSize({width:video.videoWidth,height:video.videoHeight,boxWidth:video.clientWidth,boxHeight:video.clientHeight})
  measure();const observer=new ResizeObserver(measure);observer.observe(video)
  video.addEventListener('loadedmetadata',measure);video.addEventListener('resize',measure);video.addEventListener('emptied',measure)
  return()=>{observer.disconnect();video.removeEventListener('loadedmetadata',measure);video.removeEventListener('resize',measure);video.removeEventListener('emptied',measure)}
 },[video,resetKey])
 useEffect(()=>subscribeZoneOverlay(source.id,state=>{setZones(state.zones);setLoaded(state.loaded);setFailed(state.failed)}),[source.id])
 const geometry=zoneSourceGeometry(source,size.width,size.height)
 const activeZones=zones.filter(z=>z.channel_id===source.id&&z.state==='active')
 const compatible=activeZones.filter(z=>z.geometry_revision===geometry)
 const mismatch=activeZones.length-compatible.length
 const layout=computeContainLayout(size.width,size.height,size.boxWidth,size.boxHeight)
 const drawable=loaded&&!failed&&!transformed&&!!geometry&&layout.dispW>0&&layout.dispH>0
 let message=''
 {
  if(failed)message='警戒区读取失败，暂不叠加；将自动重试。'
  else if(!size.width||!size.height)message='等待原始画面尺寸，暂不叠加警戒区。'
  else if(!geometry)message='来源接入标识尚未确认，请刷新通道后重试。'
  else if(!loaded)message='正在读取警戒区…'
  else if(mismatch)message=`${mismatch} 个区域与当前画面规格或版本不匹配，请在播放器下方的“布防”中重新确认。`
  
 }
 return <>
  {transformed&&camera&&video&&loaded&&!failed&&!!geometry&&<PanoramaZoneOverlay video={video} zones={compatible} camera={camera} compact={compact}/>}
  {drawable&&<svg aria-label="已保存警戒区" className="pointer-events-none absolute" style={{left:layout.offsetX,top:layout.offsetY,width:layout.dispW,height:layout.dispH}} viewBox={`0 0 ${layout.dispW} ${layout.dispH}`}>
   {compatible.flatMap(zone=>erpDisplayPolygons(zone.points,zone.erp_wrap).map((poly,index)=>{
    const points=poly.map(([x,y])=>[x*layout.dispW,y*layout.dispH])
    const left=Math.max(4,Math.min(layout.dispW-4,Math.min(...points.map(p=>p[0]!))))
    const top=Math.max(16,Math.min(layout.dispH-4,Math.min(...points.map(p=>p[1]!))-5))
    return <g key={`${zone.zone_id}:${index}`}><polygon points={points.map(p=>p.join(',')).join(' ')} fill="rgba(34,211,238,0.12)" stroke="#22d3ee" strokeWidth="2" vectorEffect="non-scaling-stroke"/>{!compact&&<text x={left} y={top} fill="white" stroke="black" strokeWidth="3" paintOrder="stroke" fontSize="13">{zone.name}</text>}</g>
   }))}
  </svg>}
  {message&&!compact&&<div role="status" className="pointer-events-none absolute right-2 top-12 z-20 max-w-[90%] rounded bg-black/75 p-2 text-xs text-white">{message}</div>}
 </>
}
