import type {ZonePoint} from '@/features/alarmGeometry'
import {erpDisplayPolygons} from '@/features/erpGeometry'

/** CSS-pixel labels keep the same size at every source resolution. They never
 * capture pointer input intended for the polygon or an insertion handle. */
export function ZoneEdgeLabels({points,wrap=false,offset=false,entry=[],exit=[]}:{points:ZonePoint[];wrap?:boolean;offset?:boolean;entry?:number[];exit?:number[]}){
 return <div className="pointer-events-none absolute inset-0" aria-hidden="true">
  {erpDisplayPolygons(points,wrap).flatMap((poly,copy)=>poly.map((p,i)=>{
   const q=poly[(i+1)%poly.length]!,x=(p[0]+q[0])/2,y=(p[1]+q[1])/2
   if(x<0||x>1)return []
   const look=entry.includes(i)?'border-green-300 bg-green-50 text-green-900':exit.includes(i)?'border-orange-300 bg-orange-50 text-orange-900':'border-amber-300 bg-amber-50 text-amber-950'
   return <span key={`${copy}:${i}`} className={`zone-edge-label absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-semibold leading-4 shadow-sm ${look}`} style={{left:`${x*100}%`,top:`${y*100}%`,...(offset?{marginTop:y<.08?28:-28}:{})}}>边 {i+1}</span>
  }))}
 </div>
}
