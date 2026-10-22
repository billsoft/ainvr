import type {ZonePoint} from '@/features/alarmGeometry'
import {erpDisplayPolygons} from '@/features/erpGeometry'
export interface MarkerItem {id:string;name:string;label:string;warn?:boolean;muted?:boolean}
export interface MarkerTarget {id:string;name:string;frame?:boolean;points?:ZonePoint[];erpWrap?:boolean;triggers:MarkerItem[];counters:MarkerItem[];noCounting?:string}
function markerAnchor(points:ZonePoint[],wrap=false){
 const poly=erpDisplayPolygons(points,wrap)[0]??points
 if(!poly.length)return {x:0,y:0}
 const x=(Math.min(...poly.map(p=>p[0]))+Math.max(...poly.map(p=>p[0])))/2,y=Math.min(...poly.map(p=>p[1]))
 return {x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y))}
}
/** Place labels in screen pixels, not source pixels; keep touch targets on screen
 * and avoid other labels. A leader preserves the link to displaced zone anchors. */
export function placeMarkers(targets:MarkerTarget[],width:number,height:number){
 const w=Math.min(224,Math.max(44,width-16)),h=44,gap=6,placed:{x:number;y:number;w:number;h:number;ax:number;ay:number}[]=[]
 for(const t of targets){
  const a=t.frame?{x:0,y:0}:markerAnchor(t.points??[],t.erpWrap)
  const ax=t.frame?8:a.x*width,ay=t.frame?8:a.y*height
  const clampX=(x:number)=>Math.max(0,Math.min(Math.max(0,width-w),x)),clampY=(y:number)=>Math.max(0,Math.min(Math.max(0,height-h),y))
  const origin={x:clampX(t.frame?8:ax-w/2),y:clampY(t.frame?8:ay-h-gap)}
  let pos=origin
  const candidates=[origin]
  for(let row=1;row<=Math.ceil(height/(h+gap));row++)for(const sign of [1,-1])candidates.push({x:origin.x,y:clampY(origin.y+sign*row*(h+gap))})
  for(let y=0;y<=height-h;y+=h+gap)for(let x=0;x<=width-w;x+=w+gap)candidates.push({x,y})
  const fits=candidates.find(c=>placed.every(b=>c.x+w+gap<=b.x||b.x+b.w+gap<=c.x||c.y+h+gap<=b.y||b.y+b.h+gap<=c.y))
  if(fits)pos=fits
  placed.push({...pos,w,h,ax,ay})
 }
 return placed
}
