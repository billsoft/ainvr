import {it,expect} from 'vitest'
import {isRectangle,resizeRectangle,rotateRectangle} from '@/features/rectangleGeometry'
import {countingDrawing} from '@/features/counterGeometry'
import {edgeIdsAfterEdit} from '@/features/armingDraft'
import type {ZonePoint} from '@/features/alarmGeometry'
const W=1920,H=1080,rect:ZonePoint[]=[[.35,.3],[.65,.3],[.65,.7],[.35,.7]]
const length=(p:ZonePoint[],i:number)=>Math.hypot((p[(i+1)%4]![0]-p[i]![0])*W,(p[(i+1)%4]![1]-p[i]![1])*H)
it('rotates around the pixel-space centre preserving dimensions, winding and persistent edge IDs',()=>{
 for(const points of [rect,[...rect].reverse()])for(const degrees of [1,30,90,135,180,270]){
  const p=rotateRectangle(points,degrees*Math.PI/180,W,H)
  expect(isRectangle(p,W,H)).toBe(true)
  expect(length(p,0)).toBeCloseTo(length(points,0))
  expect(length(p,1)).toBeCloseTo(length(points,1))
  expect((p[0]![0]+p[2]![0])/2).toBeCloseTo(.5)
  expect((p[0]![1]+p[2]![1])/2).toBeCloseTo(.5)
  expect(edgeIdsAfterEdit(points,['a','b','c','d'],p,false,()=>{throw Error('must retain edges')})).toEqual(['a','b','c','d'])
 }
})
it('rotated corner scales both dimensions proportionally with opposite corner fixed',()=>{
 const p=rotateRectangle(rect,.4,W,H),a=p[0]!,o=p[2]!,q:ZonePoint=[o[0]+(a[0]-o[0])*1.1,o[1]+(a[1]-o[1])*1.1]
 const next=resizeRectangle(p,0,q,false,W,H)
 expect(next[2]).toEqual(p[2]);expect(isRectangle(next,W,H)).toBe(true)
 expect(length(next,0)/length(p,0)).toBeCloseTo(1.1)
 expect(length(next,1)/length(p,1)).toBeCloseTo(1.1)
})
it('out-of-frame rotation is rejected; scaling clamps without flipping or losing ratio',()=>{
 const edge:ZonePoint[]=[[0,0],[.7,0],[.7,.7],[0,.7]]
 expect(rotateRectangle(edge,.3,W,H)).toBe(edge)
 for(const target of [[1,1],[-1,-1]] as ZonePoint[]){
  const next=resizeRectangle(rect,0,target,false,W,H)
  expect(isRectangle(next,W,H)).toBe(true)
  expect(length(next,0)/length(next,1)).toBeCloseTo(length(rect,0)/length(rect,1))
  expect(next.every(p=>p.every(v=>v>=-1e-9&&v<=1+1e-9))).toBe(true)
 }
})
it('rotated side resize preserves the opposite edge and perpendicularity',()=>{
 const p=rotateRectangle(rect,.5,W,H),q=resizeRectangle(p,1,[p[1]![0]+.02,p[1]![1]],true,W,H)
 expect(isRectangle(q,W,H)).toBe(true);expect(q[0]).toEqual(p[0]);expect(q[3]).toEqual(p[3]);expect(q).not.toEqual(p)
 expect(isRectangle([[0,0],[1,0],[.5,.5],[0,1]],W,H)).toBe(false)
})
it('count arrow stays pixel-perpendicular after rotation and outward direction never flips',()=>{
 for(const angle of [0,.3,Math.PI/2,Math.PI,4]){
  const p=rotateRectangle(rect,angle,W,H),ids=['a','b','c','d']
  for(let i=0;i<4;i++){
   const a=countingDrawing({kind:'line',edge:ids[i]!,in_side:'outward'},p,ids,W,H).arrow!
   const dx=(a.to[0]-a.from[0])*W,dy=(a.to[1]-a.from[1])*H
   const ex=(p[(i+1)%4]![0]-p[i]![0])*W,ey=(p[(i+1)%4]![1]-p[i]![1])*H
   expect(dx*ex+dy*ey).toBeCloseTo(0,6)
   const mx=(p[i]![0]+p[(i+1)%4]![0])/2,my=(p[i]![1]+p[(i+1)%4]![1])/2
   expect(dx*(.5-mx)*W+dy*(.5-my)*H).toBeLessThan(0)
  }
 }
})
