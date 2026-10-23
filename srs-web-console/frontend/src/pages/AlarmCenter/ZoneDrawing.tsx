import {useRef,type RefObject,type PointerEvent} from 'react'
import type {ZonePoint} from '@/features/alarmGeometry'
interface Props {mode:'rectangle'|'polygon';points:ZonePoint[];frame:RefObject<HTMLDivElement|null>;width:number;height:number;onPoints:(p:ZonePoint[])=>void;onComplete:(p:ZonePoint[])=>void}
export function ZoneDrawing({mode,points,frame,width,height,onPoints,onComplete}:Props){
 const drag=useRef<{id:number;start:ZonePoint}|null>(null)
 const coordinate=(e:PointerEvent):ZonePoint|null=>{const b=frame.current?.getBoundingClientRect();return b?.width&&b.height?[Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))]:null}
 const rect=(a:ZonePoint,b:ZonePoint):ZonePoint[]=>[[Math.min(a[0],b[0]),Math.min(a[1],b[1])],[Math.max(a[0],b[0]),Math.min(a[1],b[1])],[Math.max(a[0],b[0]),Math.max(a[1],b[1])],[Math.min(a[0],b[0]),Math.max(a[1],b[1])]]
 return <svg aria-label="绘制新热区" className="absolute inset-0 h-full w-full cursor-crosshair touch-none" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
  onPointerDown={e=>{if(drag.current||e.button!==0)return;const p=coordinate(e);if(!p)return;if(mode==='polygon'){if(points.length<32)onPoints([...points,p]);return}e.currentTarget.setPointerCapture(e.pointerId);drag.current={id:e.pointerId,start:p}}}
  onPointerMove={e=>{const d=drag.current,p=coordinate(e);if(d&&d.id===e.pointerId&&p)onPoints(rect(d.start,p))}}
  onPointerUp={e=>{const d=drag.current,p=coordinate(e);if(!d||d.id!==e.pointerId)return;drag.current=null;if(p)onComplete(rect(d.start,p))}}
  onPointerCancel={e=>{if(drag.current?.id===e.pointerId){drag.current=null;onPoints([])}}}
  onLostPointerCapture={e=>{if(drag.current?.id===e.pointerId){drag.current=null;onPoints([])}}}>
  <polygon points={points.map(p=>`${p[0]*width},${p[1]*height}`).join(' ')} fill="rgba(22,119,255,.2)" stroke="#1677ff" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
 </svg>
}
