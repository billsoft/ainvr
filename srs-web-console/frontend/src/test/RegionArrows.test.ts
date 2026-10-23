import {it,expect} from 'vitest'
import {countingDrawing,countingArrows} from '@/features/counterGeometry'
it('concave region uses one local pixel-normal per selected edge, with no averaged route',()=>{
 const base:[number,number][]=[[.35,.35],[.65,.35],[.65,.65],[.5,.5],[.35,.65]]
 for(const reversed of [false,true])for(const angle of [0,.4,1.4]){
  const points=(reversed?[...base].reverse():base).map(([x,y])=>{const px=(x-.5)*1920,py=(y-.5)*1080;return [.5+(px*Math.cos(angle)-py*Math.sin(angle))/1920,.5+(px*Math.sin(angle)+py*Math.cos(angle))/1080] as [number,number]})
  const ids=points.map((_,i)=>String(i)),direction={kind:'edges' as const,entry:['0','2'],exit:['3']}
  const d=countingDrawing(direction,points,ids,1920,1080)
  expect(d.arrow).toBeNull();expect(countingArrows(d)).toHaveLength(3)
  const sign=Math.sign(points.reduce((s,p,i)=>{const q=points[(i+1)%points.length]!;return s+p[0]*q[1]-q[0]*p[1]},0))
  countingArrows(d).forEach((a,i)=>{
   const e=d.edges[i]!,ex=(e.q[0]-e.p[0])*1920,ey=(e.q[1]-e.p[1])*1080,dx=(a.to[0]-a.from[0])*1920,dy=(a.to[1]-a.from[1])*1080
   expect(dx*ex+dy*ey).toBeCloseTo(0,6)
   expect(Math.sign((ex*dy-ey*dx)*sign)).toBe(a.role==='entry'?1:-1)
  })
  const swapped=countingDrawing({kind:'edges',entry:direction.exit,exit:direction.entry},points,ids,1920,1080)
  for(const a of countingArrows(d)){const e=d.edges[countingArrows(d).indexOf(a)]!;const j=swapped.edges.findIndex(v=>v.p===e.p);const b=countingArrows(swapped)[j]!;expect(b.from).toEqual(a.to);expect(b.to).toEqual(a.from)}
 }
})
it('single line and two gates keep their existing single direction arrow',()=>{
 const p:[number,number][]=[[.2,.2],[.8,.2],[.8,.8],[.2,.8]],ids=['a','b','c','d']
 for(const direction of [{kind:'line' as const,edge:'a',in_side:'inward' as const},{kind:'gates' as const,from:'a',to:'c'}])expect(countingArrows(countingDrawing(direction,p,ids,1920,1080))).toHaveLength(1)
})
it('image-border edges retain local arrows without drawing outside the image',()=>{
 const points:[number,number][]=[[0,0],[1,0],[1,1],[0,1]]
 const d=countingDrawing({kind:'edges',entry:['a','b'],exit:['c','d']},points,['a','b','c','d'],1920,1080)
 expect(countingArrows(d)).toHaveLength(4)
 for(const a of countingArrows(d))expect([...a.from,...a.to].every(v=>v>=0&&v<=1)).toBe(true)
})