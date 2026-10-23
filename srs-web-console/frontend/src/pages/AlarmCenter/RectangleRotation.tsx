import {useEffect,useRef,useState,type RefObject,type PointerEvent} from 'react'
import {RotateCw} from 'lucide-react'
import type {ZonePoint} from '@/features/alarmGeometry'
import {rotateRectangle} from '@/features/rectangleGeometry'
interface Props {points:ZonePoint[];frame:RefObject<HTMLDivElement|null>;width:number;height:number;disabled:boolean;onPreview:(p:ZonePoint[]|null)=>void;onChange:(p:ZonePoint[],before:ZonePoint[])=>void}
export function RectangleRotation({points,frame,width,height,disabled,onPreview,onChange}:Props){
 const [size,setSize]=useState({width,height})
 useEffect(()=>{const el=frame.current;if(!el)return;const update=()=>{const r=el.getBoundingClientRect();if(r.width&&r.height)setSize({width:r.width,height:r.height})};update();if(typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(update);observer.observe(el);return()=>observer.disconnect()},[frame,width,height])
 const gesture=useRef<{id:number;before:ZonePoint[];latest:ZonePoint[];angle:number;center:ZonePoint}|null>(null)
 const center:ZonePoint=[(points[0]![0]+points[2]![0])/2,(points[0]![1]+points[2]![1])/2]
 const mid:ZonePoint=[(points[1]![0]+points[2]![0])/2,(points[1]![1]+points[2]![1])/2]
 const dx=(mid[0]-center[0])*size.width,dy=(mid[1]-center[1])*size.height,n=Math.hypot(dx,dy)||1
 const outer:ZonePoint=[mid[0]+dx/n*48/size.width,mid[1]+dy/n*48/size.height]
 const handle:ZonePoint=[Math.max(22/size.width,Math.min(1-22/size.width,outer[0])),Math.max(22/size.height,Math.min(1-22/size.height,outer[1]))]
 const angle=(e:PointerEvent,c:ZonePoint)=>{const r=frame.current?.getBoundingClientRect();return r?.width&&r.height?Math.atan2(((e.clientY-r.top)/r.height-c[1])*height,((e.clientX-r.left)/r.width-c[0])*width):null}
 const cancel=(id:number)=>{const g=gesture.current;if(g?.id!==id)return;gesture.current=null;onPreview(g.before);onPreview(null)}
 return <>
  <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none"><line x1={mid[0]} y1={mid[1]} x2={handle[0]} y2={handle[1]} stroke="#2563eb" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg>
  <button type="button" aria-label="旋转矩形" title="绕中心旋转；方向键每次 1°，Shift 每次 15°" disabled={disabled} className="absolute z-20 flex h-11 w-11 touch-none -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-primary" style={{left:`${handle[0]*100}%`,top:`${handle[1]*100}%`,cursor:'grab'}}
   onPointerDown={e=>{if(disabled||gesture.current||e.button!==0)return;const a=angle(e,center);if(a===null)return;e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);gesture.current={id:e.pointerId,before:points.map(p=>[...p]),latest:points,angle:a,center}}}
   onPointerMove={e=>{const g=gesture.current;if(!g||g.id!==e.pointerId||disabled)return;const a=angle(e,g.center);if(a===null)return;let delta=a-g.angle;if(e.shiftKey)delta=Math.round(delta/(Math.PI/12))*Math.PI/12;const next=rotateRectangle(g.before,delta,width,height);if(next===g.before)return;g.latest=next;onPreview(next)}}
   onPointerUp={e=>{const g=gesture.current;if(g?.id!==e.pointerId)return;gesture.current=null;onPreview(null);if(JSON.stringify(g.before)!==JSON.stringify(g.latest))onChange(g.latest,g.before)}}
   onPointerCancel={e=>cancel(e.pointerId)} onLostPointerCapture={e=>cancel(e.pointerId)}
   onKeyDown={e=>{if(disabled||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();e.stopPropagation();const sign=e.key==='ArrowLeft'||e.key==='ArrowUp'?-1:1;onChange(rotateRectangle(points,sign*(e.shiftKey?15:1)*Math.PI/180,width,height),points)}}><span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-primary text-white shadow"><RotateCw size={16} aria-hidden="true"/></span></button>
 </>
}
