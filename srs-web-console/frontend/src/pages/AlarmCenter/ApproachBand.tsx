import {useMemo,useId,useState} from 'react'
type Point=[number,number]
export function distanceToZone(p:Point,points:Point[]){
 let inside=false,best=Infinity
 for(let i=0,j=points.length-1;i<points.length;j=i++){
  const a=points[j]!,b=points[i]!,dx=b[0]-a[0],dy=b[1]-a[1]
  if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside
  const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)))
  best=Math.min(best,Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy))
 }
 return inside?-best:best
}
export function approachContour(points:Point[],width:number,height:number,distance:number,resolution=320){
 // Render-only isoline. Classification uses exact source-space distance, never this mesh.
 const step=Math.max(width,height)/resolution,segments:[Point,Point][]=[]
 for(let y=0;y<height;y+=step)for(let x=0;x<width;x+=step){
  const corners:Point[]=[[x,y],[Math.min(width,x+step),y],[Math.min(width,x+step),Math.min(height,y+step)],[x,Math.min(height,y+step)]]
  const values=corners.map(p=>distanceToZone(p,points)-distance),hits:Point[]=[]
  for(let i=0;i<4;i++){const j=(i+1)%4,a=values[i]!,b=values[j]!;if((a<=0)===(b<=0))continue
   const t=a/(a-b),p=corners[i]!,q=corners[j]!;hits.push([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])])}
  for(let i=0;i+1<hits.length;i+=2)segments.push([hits[i]!,hits[i+1]!])
 }
 const key=(p:Point)=>p.map(v=>Math.round(v*10000)).join(','),adj=new Map<string,number[]>()
 segments.forEach((edge,i)=>edge.forEach(p=>adj.set(key(p),[...(adj.get(key(p))??[]),i])))
 const used=new Set<number>(),paths:string[]=[]
 for(let i=0;i<segments.length;i++){if(used.has(i))continue;const first=segments[i]![0];let at=first,next=i,path=`M${first.join(',')}`
  while(!used.has(next)){used.add(next);const edge=segments[next]!;at=key(edge[0])===key(at)?edge[1]:edge[0];path+=`L${at.join(',')}`;const candidate=adj.get(key(at))?.find(n=>!used.has(n));if(candidate===undefined)break;next=candidate}
  paths.push(path)
 }
 return paths.join(' ')
}
export function ApproachBand({points,width,height,percent,onChange}:{points:Point[];width:number;height:number;percent:number;onChange?:(value:number)=>void}){
 const maskId=useId(),[dragging,setDragging]=useState(false)
 const pixels=useMemo(()=>points.map(([x,y]):Point=>[x*width,y*height]),[points,width,height])
 const radius=percent*width/100,path=useMemo(()=>approachContour(pixels,width,height,radius,dragging?96:320),[pixels,width,height,radius,dragging])
 const right=pixels.reduce((a,b)=>a[0]>b[0]?a:b),hx=Math.min(width,right[0]+radius),hy=right[1]
 return <g aria-label="接近范围" data-distance-px={radius}>
  <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}><rect width={width} height={height} fill="white"/><polygon points={pixels.map(p=>p.join(',')).join(' ')} fill="black"/></mask></defs>
  <polygon className="pointer-events-none" points={pixels.map(p=>p.join(',')).join(' ')} fill="none" stroke="#fbbf24" strokeWidth={2*radius} strokeLinejoin="round" opacity=".10" mask={`url(#${maskId})`}/>
  <path strokeDasharray="7 5" d={path} fill="none" stroke="#d97706" strokeWidth="2" vectorEffect="non-scaling-stroke" className="pointer-events-none"/>
  {onChange&&<><circle cx={hx} cy={hy} r={Math.max(width,height)*.006} fill="#fef3c7" stroke="#b45309" strokeWidth="2" vectorEffect="non-scaling-stroke" className="pointer-events-none"/><circle role="slider" aria-label="拖动接近距离" aria-valuenow={percent} aria-valuemin={0.1} aria-valuemax={100} tabIndex={0} cx={hx} cy={hy} r={Math.max(width,height)*.006} fill="transparent" stroke="transparent" strokeWidth="44" vectorEffect="non-scaling-stroke" style={{touchAction:'none',cursor:'ew-resize'}}
   onPointerDown={e=>{e.stopPropagation();setDragging(true);e.currentTarget.setPointerCapture(e.pointerId)}}
   onPointerMove={e=>{if(!e.currentTarget.hasPointerCapture(e.pointerId))return;const svg=e.currentTarget.ownerSVGElement!,rect=svg.getBoundingClientRect();const p:Point=[(e.clientX-rect.left)/rect.width*width,(e.clientY-rect.top)/rect.height*height];onChange(Math.max(.1,Math.min(100,Math.round(Math.max(0,distanceToZone(p,pixels))/width*1000)/10)))}}
   onPointerUp={e=>{setDragging(false);e.currentTarget.releasePointerCapture(e.pointerId)}} onLostPointerCapture={()=>setDragging(false)} onPointerCancel={()=>setDragging(false)}
   onKeyDown={e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();onChange(Math.max(.1,Math.min(100,percent+(e.key==='ArrowRight'?.1:-.1))))}}}/></>}</g>
}
