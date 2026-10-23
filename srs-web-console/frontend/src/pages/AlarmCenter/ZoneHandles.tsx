import {RectangleRotation} from './RectangleRotation'
import {useRef,type RefObject,type PointerEvent} from 'react'
import type {DraftZone} from '@/features/armingDraft'
import {isRectangle,resizeRectangle} from '@/features/rectangleGeometry'
import {erpDisplayPolygons} from '@/features/erpGeometry'
import type {ZonePoint} from '@/features/alarmGeometry'
interface Props {zone:DraftZone;frame:RefObject<HTMLDivElement|null>;width:number;height:number;disabled:boolean;onPreview:(points:ZonePoint[]|null)=>void;onChange:(points:ZonePoint[])=>void}
/** One pointer gesture is one draft operation; preview never enters undo history. */
export function ZoneHandles({zone,frame,width,height,disabled,onPreview,onChange}:Props){
 const drag=useRef<{id:number;kind:'move'|'corner'|'edge';index:number;start:ZonePoint;before:ZonePoint[];latest:ZonePoint[]}|null>(null)
 const rect=!zone.erpWrap&&isRectangle(zone.points,width,height)
 const point=(e:PointerEvent):ZonePoint|null=>{const b=frame.current?.getBoundingClientRect();return b?.width&&b.height?[Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))]:null}
 const move=(before:ZonePoint[],dx:number,dy:number):ZonePoint[]=>{
  if(!zone.erpWrap)dx=Math.max(-Math.min(...before.map(p=>p[0])),Math.min(1-Math.max(...before.map(p=>p[0])),dx))
  dy=Math.max(-Math.min(...before.map(p=>p[1])),Math.min(1-Math.max(...before.map(p=>p[1])),dy))
  return before.map(p=>[zone.erpWrap?((p[0]+dx)%1+1)%1:p[0]+dx,p[1]+dy])
 }
 const handlers=(kind:'move'|'corner'|'edge',index=0)=>({
  onPointerDown:(e:PointerEvent<HTMLElement|SVGElement>)=>{if(disabled||drag.current||e.button!==0)return;const start=point(e);if(!start)return;e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);drag.current={id:e.pointerId,kind,index,start,before:zone.points.map(p=>[...p]),latest:zone.points}},
  onPointerMove:(e:PointerEvent)=>{const d=drag.current;if(!d||e.pointerId!==d.id||disabled)return;const pos=point(e);if(!pos)return;const target:ZonePoint=[d.before[d.index]![0]+pos[0]-d.start[0],d.before[d.index]![1]+pos[1]-d.start[1]];d.latest=d.kind==='move'?move(d.before,pos[0]-d.start[0],pos[1]-d.start[1]):rect?resizeRectangle(d.before,d.index,target,d.kind==='edge',width,height):d.before.map((p,i)=>i===d.index?[Math.max(0,Math.min(1,target[0])),Math.max(0,Math.min(1,target[1]))]:p);onPreview(d.latest)},
  onPointerUp:(e:PointerEvent)=>{const d=drag.current;if(!d||e.pointerId!==d.id)return;drag.current=null;onPreview(null);if(JSON.stringify(d.before)!==JSON.stringify(d.latest))onChange(d.latest)},
  onPointerCancel:(e:PointerEvent)=>{if(drag.current?.id===e.pointerId){drag.current=null;onPreview(null)}},
  onLostPointerCapture:(e:PointerEvent)=>{if(drag.current?.id===e.pointerId){drag.current=null;onPreview(null)}}
 })
 return <>
  <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
   {erpDisplayPolygons(zone.points,zone.erpWrap).map((points,i)=><polygon key={i} role="button" aria-label={`拖动热区 ${zone.name}`} tabIndex={disabled?-1:0} className="pointer-events-auto cursor-move touch-none" fill="transparent" points={points.map(p=>`${p[0]*width},${p[1]*height}`).join(' ')} {...handlers('move')} onKeyDown={e=>{if(disabled||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const v=e.shiftKey?.01:.001;onChange(move(zone.points,e.key==='ArrowLeft'?-v:e.key==='ArrowRight'?v:0,e.key==='ArrowUp'?-v:e.key==='ArrowDown'?v:0))}}/>)}
  </svg>
  {zone.points.map((p,i)=><button key={i} type="button" disabled={disabled} aria-label={`调整顶点 ${i+1}`} className="absolute flex h-11 w-11 touch-none -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-primary" style={{left:`${p[0]*100}%`,top:`${p[1]*100}%`}} {...handlers('corner',i)} onKeyDown={e=>{if(disabled||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const v=e.shiftKey?.01:.001,q:ZonePoint=[Math.max(0,Math.min(1,p[0]+(e.key==='ArrowLeft'?-v:e.key==='ArrowRight'?v:0))),Math.max(0,Math.min(1,p[1]+(e.key==='ArrowUp'?-v:e.key==='ArrowDown'?v:0)))];onChange(rect?resizeRectangle(zone.points,i,q,false,width,height):zone.points.map((p,j)=>i===j?q:p))}}><span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-primary text-xs text-white shadow">{i+1}</span></button>)}
  {zone.points.map((p,i)=>{const q=zone.points[(i+1)%zone.points.length]!,m:ZonePoint=[zone.erpWrap?((p[0]+(q[0]-p[0]-Math.round(q[0]-p[0]))/2)%1+1)%1:(p[0]+q[0])/2,(p[1]+q[1])/2],vertical=Math.abs(p[0]-q[0])<1e-9;return <button key={`edge-${i}`} type="button" disabled={disabled||(!rect&&zone.points.length>=32)} aria-label={rect?`拖动边 ${i+1} 调整${vertical?'宽度':'高度'}`:`在边 ${i+1} 插入顶点`} className="absolute flex h-11 w-11 touch-none -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-primary" style={{left:`${m[0]*100}%`,top:`${m[1]*100}%`,cursor:rect?(vertical?'ew-resize':'ns-resize'):'pointer'}} {...(rect?handlers('edge',i):{})} onClick={()=>{if(!rect)onChange([...zone.points.slice(0,i+1),m,...zone.points.slice(i+1)])}} onKeyDown={e=>{if(!rect||disabled||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const v=e.shiftKey?.01:.001;onChange(resizeRectangle(zone.points,i,[p[0]+(e.key==='ArrowLeft'?-v:e.key==='ArrowRight'?v:0),p[1]+(e.key==='ArrowUp'?-v:e.key==='ArrowDown'?v:0)],true,width,height))}}><span className="flex h-6 w-6 items-center justify-center rounded-full border border-primary bg-white text-primary shadow" style={rect?{transform:`rotate(${Math.atan2((q[1]-p[1])*height,(q[0]-p[0])*width)*180/Math.PI}deg)`}:undefined}>{rect?'↕':'+'}</span></button>})}
  {rect&&<RectangleRotation points={zone.points} frame={frame} width={width} height={height} disabled={disabled} onPreview={onPreview} onChange={onChange}/>}
 </>
}
