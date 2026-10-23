import {expect,it} from 'vitest'
import {isConcaveRegion,pickFrom,pickDirection,previewDirection,tapEdge} from '@/features/countingSelection'
import {countingDrawing} from '@/features/counterGeometry'
it('triangle and convex polygons do not require opposite edges; concavity survives winding and rotation',()=>{
 const triangle:[number,number][]=[[.1,.1],[.9,.1],[.5,.9]]
 expect(isConcaveRegion(triangle)).toBe(false)
 const concave:[number,number][]=[[.1,.1],[.9,.1],[.9,.9],[.5,.5],[.1,.9]]
 expect(isConcaveRegion(concave)).toBe(true)
 expect(isConcaveRegion([...concave].reverse())).toBe(true)
 expect(isConcaveRegion(concave.map(([x,y])=>[-y,x]))).toBe(true)
 let pick=tapEdge(pickFrom('zone'),'a');pick={...pick,target:'exit'};pick=tapEdge(pick,'b')
 expect(pickDirection(pick)).toEqual({kind:'edges',entry:['a'],exit:['b']})
})
it('partial selection colours chosen edges without allowing incomplete bindings to save',()=>{
 const points:[number,number][]=[[.1,.1],[.9,.1],[.5,.9]]
 for(const method of ['zone','gates'] as const){
  const pick=tapEdge(pickFrom(method),'a')
  expect(pickDirection(pick)).toBeNull()
  const draw=countingDrawing(previewDirection(pick)!,points,['a','b','c'],1920,1080)
  expect(draw.edges).toHaveLength(1);expect(draw.edges[0]!.role).toBe('entry');expect(draw.arrow).toBeNull()
 }
})
it('edge reassignment cannot share entry and exit roles',()=>{
 let pick=tapEdge(pickFrom('zone'),'a');pick={...pick,target:'exit'};pick=tapEdge(pick,'a')
 expect(pick.entry).toEqual([]);expect(pick.exit).toEqual(['a']);expect(pickDirection(pick)).toBeNull()
})