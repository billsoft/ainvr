import type {BindingDirection} from '@/api/flowService'
type Point=[number,number]
export interface CountingDrawing {
 /** Edges to emphasise, in normalised coordinates; role tells the colour. */
 edges:{p:Point;q:Point;role:'line'|'entry'|'exit'}[]
 /** The "in" direction arrow, normalised. */
 arrow:{from:Point;to:Point}|null
}
const mid=(p:Point,q:Point):Point=>[(p[0]+q[0])/2,(p[1]+q[1])/2]
const signedArea=(points:Point[])=>points.reduce((s,p,i)=>{const q=points[(i+1)%points.length]!;return s+p[0]*q[1]-q[0]*p[1]},0)
/**
 * Arrow pointing the way a target moves to be counted as "in". For a line this
 * follows the engine's rule: "inward" is the side of the edge the zone lies on.
 * Lengths are computed in source pixels so the arrow stays perpendicular on screen.
 */
export function countingDrawing(direction:BindingDirection,points:Point[],edgeIds:string[],width:number,height:number):CountingDrawing{
 const edge=(id:string)=>{const i=edgeIds.indexOf(id);return i<0?null:{p:points[i]!,q:points[(i+1)%points.length]!}}
 const length=.1*Math.min(width,height)
 if(direction.kind==='line'){
  const e=edge(direction.edge);if(!e)return {edges:[],arrow:null}
  // Cross a third of the way along the edge, clear of the edge number at its midpoint.
  const m:Point=[e.p[0]+(e.q[0]-e.p[0])/3,e.p[1]+(e.q[1]-e.p[1])/3],dx=(e.q[0]-e.p[0])*width,dy=(e.q[1]-e.p[1])*height,n=Math.hypot(dx,dy)||1
  // Left normal in a y-down image; multiplying by the orientation sign points into the zone.
  const side=Math.sign(signedArea(points))*(direction.in_side==='inward'?1:-1)
  const nx=-dy/n*side,ny=dx/n*side
  return {edges:[{...e,role:'line'}],arrow:{from:[m[0]-nx*length/width,m[1]-ny*length/height],to:[m[0]+nx*length/width,m[1]+ny*length/height]}}
 }
 if(direction.kind==='gates'){
  const a=edge(direction.from),b=edge(direction.to);if(!a||!b)return {edges:[],arrow:null}
  return {edges:[{...a,role:'entry'},{...b,role:'exit'}],arrow:{from:mid(a.p,a.q),to:mid(b.p,b.q)}}
 }
 if(direction.kind==='edges'){
  const entry=direction.entry.map(edge).filter(Boolean) as {p:Point;q:Point}[],exit=direction.exit.map(edge).filter(Boolean) as {p:Point;q:Point}[]
  const centre=(list:{p:Point;q:Point}[]):Point|null=>list.length?[list.reduce((s,e)=>s+mid(e.p,e.q)[0],0)/list.length,list.reduce((s,e)=>s+mid(e.p,e.q)[1],0)/list.length]:null
  const from=centre(entry),to=centre(exit)
  return {edges:[...entry.map(e=>({...e,role:'entry' as const})),...exit.map(e=>({...e,role:'exit' as const}))],arrow:from&&to?{from,to}:null}
 }
 return {edges:[],arrow:null}
}
/** Arrow head points, in the same coordinate space as the given segment. */
export function arrowHead(from:Point,to:Point,size:number):Point[]{
 const dx=to[0]-from[0],dy=to[1]-from[1],n=Math.hypot(dx,dy)||1,ux=dx/n,uy=dy/n
 return [[to[0],to[1]],[to[0]-ux*size-uy*size*.6,to[1]-uy*size+ux*size*.6],[to[0]-ux*size+uy*size*.6,to[1]-uy*size-ux*size*.6]]
}
/** Counting colours stay apart from the selected-zone yellow and the zone blue. */
export const countingColors={line:'#2dd4bf',entry:'#22c55e',exit:'#f97316',arrow:'#2dd4bf',outline:'rgba(15,23,42,.75)'}
