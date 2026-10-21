import {erpDisplayPolygons} from '@/features/erpGeometry'
import {useEffect,useState,type RefObject} from 'react'
import {PanoramaZoneOverlay} from './PanoramaZoneOverlay'
import type {PanoramaCamera} from './panoramaDetection'
import type {AlarmZone} from '@/api/alarmZoneService'
import {subscribeZoneOverlay} from '@/features/zoneOverlaySubscriptions'
import {zoneSourceGeometry,type ZonePreviewSource} from '@/features/zoneSourceGeometry'
import {computeContainLayout} from './overlayGeometry'
import {subscribeLiveCounts} from '@/features/flowLiveCounts'
import {countingDrawing,arrowHead,countingColors} from '@/features/counterGeometry'
import type {LiveCount} from '@/api/flowService'
import type {ArmingCounterBindingDocument} from '@/features/armingDocument'
interface Props {video:HTMLVideoElement|null;source:ZonePreviewSource;transformed?:boolean;resetKey?:number;compact?:boolean;camera?:RefObject<PanoramaCamera|null>}
export function SavedZoneOverlay({video,source,transformed=false,resetKey,compact=false,camera}:Props){
 const [zones,setZones]=useState<(AlarmZone&{edge_ids?:string[]})[]>([]),[bindings,setBindings]=useState<ArmingCounterBindingDocument[]>([])
 const [counts,setCounts]=useState<Record<string,LiveCount>>({}),[flash,setFlash]=useState<Record<string,number>>({})
 const [loaded,setLoaded]=useState(false),[failed,setFailed]=useState(false)
 const [size,setSize]=useState({width:0,height:0,boxWidth:0,boxHeight:0})
 useEffect(()=>{
  if(!video){setSize({width:0,height:0,boxWidth:0,boxHeight:0});return}
  const measure=()=>setSize({width:video.videoWidth,height:video.videoHeight,boxWidth:video.clientWidth,boxHeight:video.clientHeight})
  measure();const observer=new ResizeObserver(measure);observer.observe(video)
  video.addEventListener('loadedmetadata',measure);video.addEventListener('resize',measure);video.addEventListener('emptied',measure)
  return()=>{observer.disconnect();video.removeEventListener('loadedmetadata',measure);video.removeEventListener('resize',measure);video.removeEventListener('emptied',measure)}
 },[video,resetKey])
 useEffect(()=>subscribeZoneOverlay(source.id,state=>{setZones(state.zones);setBindings(state.bindings);setLoaded(state.loaded);setFailed(state.failed)}),[source.id])
 const hasBindings=bindings.length>0
 useEffect(()=>{
  if(!hasBindings)return
  return subscribeLiveCounts(source.id,items=>setCounts(old=>{
   const next=Object.fromEntries(items.map(i=>[i.binding_id,i]))
   const grown:Record<string,number>={}
   for(const i of items){const before=old[i.binding_id];if(before){const d=i.in+(i.out??0)-before.in-(before.out??0);if(d>0)grown[i.binding_id]=d}}
   if(Object.keys(grown).length){setFlash(grown);setTimeout(()=>setFlash({}),2500)}
   return next
  }))
 },[source.id,hasBindings])
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
   {compatible.flatMap(zone=>bindings.filter(b=>b.zone_id===zone.zone_id&&b.zone_version===zone.version&&zone.edge_ids&&!zone.erp_wrap).map(b=>{
    const W=layout.dispW,H=layout.dispH,d=countingDrawing(b.direction,zone.points as [number,number][],zone.edge_ids!,size.width,size.height)
    if(!d.arrow)return null
    const from:[number,number]=[d.arrow.from[0]*W,d.arrow.from[1]*H],to:[number,number]=[d.arrow.to[0]*W,d.arrow.to[1]*H],c=counts[b.binding_id]
    // The small grid tile shows only the numbers; a larger player adds the counter name.
    const numbers=!c?'':!c.counting?'已暂停':`${c.names.in} ${c.in}${c.out!==undefined?` · ${c.names.out} ${c.out}`:''}`,text=c?(compact?numbers:`${c.name} ${numbers}`):''
    return <g key={b.binding_id} aria-label={text||'计数线'} opacity={c&&!c.counting?.55:1}>
     {d.edges.map((e,i)=><line key={i} x1={e.p[0]*W} y1={e.p[1]*H} x2={e.q[0]*W} y2={e.q[1]*H} stroke={countingColors[e.role]} strokeWidth="4"/>)}
     <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke={countingColors.outline} strokeWidth="6" strokeLinecap="round"/>
     <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke={countingColors.arrow} strokeWidth="3" strokeLinecap="round"/>
     <polygon points={arrowHead(from,to,10).map(p=>p.join(',')).join(' ')} fill={countingColors.arrow} stroke={countingColors.outline} strokeWidth="1.5"/>
     {text&&(()=>{
      // A small badge at the arrow's tail, outside the zone, never over the arrow itself.
      const size=compact?11:12,width=[...text].reduce((n,ch)=>n+(/[\u4e00-\u9fff]/.test(ch)?size:size*.6),0)+12,height=size+8
      const dx=from[0]-to[0],dy=from[1]-to[1],n=Math.hypot(dx,dy)||1
      const cx=from[0]+dx/n*(width/2+4),cy=from[1]+dy/n*(height/2+4)
      const x=Math.max(2,Math.min(W-width-2,cx-width/2)),y=Math.max(2,Math.min(H-height-2,cy-height/2))
      return <g>
       <rect x={x} y={y} width={width} height={height} rx="4" fill="rgba(15,23,42,.82)" stroke={countingColors.arrow} strokeWidth="1"/>
       <text x={x+6} y={y+height/2+size*.36} fill="white" fontSize={size} fontWeight="600">{text}</text>
       {flash[b.binding_id]&&<text x={x+width+4} y={y+height/2+size*.36} fill={countingColors.arrow} stroke="black" strokeWidth="3" paintOrder="stroke" fontSize={size+2} fontWeight="700">+{flash[b.binding_id]}</text>}
      </g>
     })()}
    </g>
   }))}
  </svg>}
  {message&&!compact&&<div role="status" className="pointer-events-none absolute right-2 top-12 z-20 max-w-[90%] rounded bg-black/75 p-2 text-xs text-white">{message}</div>}
 </>
}
