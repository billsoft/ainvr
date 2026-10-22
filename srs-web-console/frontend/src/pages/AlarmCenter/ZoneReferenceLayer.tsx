import type {ZonePoint} from '@/features/alarmGeometry'
import {erpDisplayPolygons} from '@/features/erpGeometry'

export interface ZoneReference {id:string;name:string;points:ZonePoint[];erpWrap?:boolean}

/** Reference shapes never capture a draw/drag or change the editor's selection. */
export function ZoneReferenceLayer({zones,width,height}:{zones:ZoneReference[];width:number;height:number}){
 return <div role="img" aria-label="已有热区参考" className="pointer-events-none absolute inset-0">
  <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
   {zones.flatMap(z=>erpDisplayPolygons(z.points,z.erpWrap).map((poly,i)=><polygon key={`${z.id}:${i}`} points={poly.map(([x,y])=>`${x*width},${y*height}`).join(' ')} fill="rgba(15,23,42,.08)" stroke="#bae6fd" strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke"/>))}
  </svg>
  {zones.flatMap(z=>erpDisplayPolygons(z.points,z.erpWrap).map((poly,i)=>{
   const x=Math.min(...poly.map(p=>p[0])),y=Math.min(...poly.map(p=>p[1]))
   return <span key={`${z.id}:${i}`} className="absolute max-w-40 truncate rounded bg-slate-900/80 px-1.5 py-0.5 text-xs text-sky-100 shadow-sm" style={{left:`clamp(4px, calc(${x*100}% + 4px), calc(100% - 164px))`,top:`clamp(4px, calc(${y*100}% + 4px), calc(100% - 28px))`}}>{z.name}</span>
  }))}
 </div>
}
