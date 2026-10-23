import type {ZonePoint} from './alarmGeometry'
const pixels=(p:ZonePoint[],w:number,h:number):ZonePoint[]=>p.map(([x,y])=>[x*w,y*h])
const dot=(a:ZonePoint,b:ZonePoint)=>a[0]*b[0]+a[1]*b[1]
const sub=(a:ZonePoint,b:ZonePoint):ZonePoint=>[a[0]-b[0],a[1]-b[1]]
const inFrame=(p:ZonePoint[],w:number,h:number)=>p.every(([x,y])=>x>=-1e-7&&y>=-1e-7&&x<=w+1e-7&&y<=h+1e-7)
/** Pixel-space rectangles, including rotated ones. Vertex/edge order is never changed. */
export function isRectangle(points:ZonePoint[],width=1,height=1):boolean {
 if(points.length!==4||width<=0||height<=0)return false
 const p=pixels(points,width,height),edges=p.map((v,i)=>sub(p[(i+1)%4]!,v))
 if(edges.some(e=>Math.hypot(...e)<1e-9))return false
 return edges.every((e,i)=>Math.abs(dot(e,edges[(i+1)%4]!))<1e-6*Math.hypot(...e)*Math.hypot(...edges[(i+1)%4]!))&&
  Math.hypot(p[0]![0]+p[2]![0]-p[1]![0]-p[3]![0],p[0]![1]+p[2]![1]-p[1]![1]-p[3]![1])<1e-6*Math.max(width,height)
}
function boundedTransform(before:ZonePoint[],delta:ZonePoint[],minimum:number,desired:number,width:number,height:number):ZonePoint[]{
 let lo=minimum,hi=Infinity
 for(let i=0;i<before.length;i++)for(const axis of [0,1] as const){
  const v=before[i]![axis],d=delta[i]![axis],limit=axis===0?width:height
  if(Math.abs(d)<1e-12)continue
  const a=-v/d,b=(limit-v)/d;lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b))
 }
 if(lo>hi)return before.map(([x,y])=>[x/width,y/height])
 const t=Math.max(lo,Math.min(hi,desired))
 return before.map((p,i)=>[(p[0]+delta[i]![0]*t)/width,(p[1]+delta[i]![1]*t)/height])
}
/** Corners scale proportionally about the opposite corner. Edges move along their normal. */
export function resizeRectangle(points:ZonePoint[],index:number,target:ZonePoint,edge:boolean,width:number,height:number):ZonePoint[]{
 if(!isRectangle(points,width,height))return points
 const p=pixels(points,width,height),a=p[index]!,b=p[(index+1)%4]!,o=p[(index+2)%4]!,t:ZonePoint=[target[0]*width,target[1]*height]
 if(!edge){
  const v=sub(a,o),scale=dot(sub(t,o),v)/dot(v,v)
  const minScale=1/Math.min(Math.hypot(...sub(a,b)),Math.hypot(...sub(b,o)))
  return boundedTransform(p.map(()=>[...o] as ZonePoint),p.map(q=>sub(q,o)),minScale,scale,width,height)
 }
 const tangent=sub(b,a),len=Math.hypot(...tangent),normal:ZonePoint=[-tangent[1]/len,tangent[0]/len]
 if(dot(sub(o,a),normal)<0){normal[0]*=-1;normal[1]*=-1}
 const thickness=dot(sub(o,a),normal),desired=-dot(sub(t,a),normal)
 const delta=p.map((_,i):ZonePoint=>i===index||i===(index+1)%4?[-normal[0],-normal[1]]:[0,0])
 return boundedTransform(p,delta,-thickness+Math.min(1,thickness),desired,width,height)
}
/** Reject out-of-frame rotation rather than distort/clamp individual vertices. */
export function rotateRectangle(points:ZonePoint[],radians:number,width:number,height:number):ZonePoint[]{
 if(!isRectangle(points,width,height)||!Number.isFinite(radians))return points
 const p=pixels(points,width,height),c:ZonePoint=[(p[0]![0]+p[2]![0])/2,(p[0]![1]+p[2]![1])/2],cos=Math.cos(radians),sin=Math.sin(radians)
 const next=p.map((v):ZonePoint=>{const d=sub(v,c);return [c[0]+d[0]*cos-d[1]*sin,c[1]+d[0]*sin+d[1]*cos]})
 return inFrame(next,width,height)?next.map(([x,y])=>[Math.max(0,Math.min(1,x/width)),Math.max(0,Math.min(1,y/height))]):points
}
