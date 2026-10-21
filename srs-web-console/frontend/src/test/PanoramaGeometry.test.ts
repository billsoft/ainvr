import {expect,it} from 'vitest'
import {PerspectiveCamera} from 'three'
import {projectErpSegment} from '@/components/player/panoramaDetection'
const camera=new PerspectiveCamera(75,2,.1,20)
camera.updateMatrixWorld();camera.updateProjectionMatrix()
const view=()=>({view:camera.matrixWorldInverse.elements,projection:camera.projectionMatrix.elements})
it('projects front ERP edges and clips back hemisphere before perspective division',()=>{
 const front=projectErpSegment([.70,.5],[.80,.5],view(),1000,500)
 expect(front.length).toBeGreaterThan(0)
 expect(front.flat(2).every(Number.isFinite)).toBe(true)
 expect(projectErpSegment([.20,.5],[.30,.5],view(),1000,500)).toEqual([])
})
it('uses source polygon edges as drawn, but trails wrap over the nearest seam',()=>{
 camera.rotation.y=-Math.PI/2;camera.updateMatrixWorld()
 const short=projectErpSegment([.98,.5],[.02,.5],view(),1000,500,true)
 expect(short.length).toBeGreaterThan(0)
 expect(short.every(([a,b])=>Math.abs(a[0]-b[0])<100)).toBe(true)
 const polygon=projectErpSegment([.98,.5],[.02,.5],view(),1000,500,false)
 expect(polygon.length).toBeGreaterThan(short.length)
 camera.rotation.y=0;camera.updateMatrixWorld()
})
it('rejects missing camera and invalid source coordinates',()=>{
 expect(projectErpSegment([0,.5],[1,.5],null,1000,500)).toEqual([])
 expect(projectErpSegment([NaN,.5],[1,.5],view(),1000,500)).toEqual([])
 expect(projectErpSegment([0,-1],[1,.5],view(),1000,500)).toEqual([])
})
