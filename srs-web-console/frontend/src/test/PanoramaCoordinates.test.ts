import {describe, expect, it} from 'vitest'
import {PerspectiveCamera, Vector3} from 'three'
import {erpToViewport, viewportToErp} from '@/components/player/panoramaCoordinates'
import {erpPoint} from '@/components/player/panoramaDetection'

const snapshot=(c:PerspectiveCamera)=>{
  c.updateProjectionMatrix();c.updateMatrixWorld()
  return {view:[...c.matrixWorldInverse.elements],projection:[...c.projectionMatrix.elements]}
}
describe('bidirectional panorama coordinates',()=>{
  it('round trips visible screen points through ERP at rotated views and zoom levels',()=>{
    for(const aspect of [.75,1,2])for(const fov of [35,75,100])
      for(const yaw of [-Math.PI,-Math.PI/2,0,.8,Math.PI])
        for(const pitch of [-1.3,0,1.3]){
          const c=new PerspectiveCamera(fov,aspect,.1,20)
          c.rotation.order='YXZ';c.rotation.set(pitch,yaw,0)
          const camera=snapshot(c),width=800,height=width/aspect
          for(const [u,v] of [[.1,.1],[.5,.5],[.9,.9],[.1,.9],[.9,.1]]){
            const erp=viewportToErp(u!*width,v!*height,camera,width,height)!
            expect(erp).not.toBeNull()
            expect(erp[0]).toBeGreaterThanOrEqual(0);expect(erp[0]).toBeLessThan(1)
            const actual=erpToViewport(erp,camera,width,height)!
            expect(actual[0]).toBeCloseTo(u!*width,6)
            expect(actual[1]).toBeCloseTo(v!*height,6)
            // Independent Three.js forward projection, not the helper inverse.
            const projected=new Vector3(...erpPoint(...erp,1,1)).project(c)
            expect(projected.x).toBeCloseTo(u!*2-1,8)
            expect(projected.y).toBeCloseTo(1-v!*2,8)
          }
        }
  })
  it('maps the ERP seam continuously without mirroring or vertical inversion',()=>{
    const c=new PerspectiveCamera(75,2,.1,20)
    c.rotation.y=-Math.PI/2
    const camera=snapshot(c)
    const left=viewportToErp(390,200,camera,800,400)!
    const right=viewportToErp(410,200,camera,800,400)!
    expect(Math.abs(left[0]-right[0])).toBeGreaterThan(.9)
    expect(viewportToErp(400,100,camera,800,400)![1]).toBeLessThan(.5)
    expect(viewportToErp(400,300,camera,800,400)![1]).toBeGreaterThan(.5)
  })
  it('rejects invalid matrices, viewport coordinates and points behind the camera',()=>{
    const camera=snapshot(new PerspectiveCamera(75,2,.1,20))
    expect(viewportToErp(-1,10,camera,800,400)).toBeNull()
    expect(viewportToErp(10,10,camera,0,400)).toBeNull()
    expect(viewportToErp(10,NaN,camera,800,400)).toBeNull()
    expect(viewportToErp(10,10,{...camera,projection:Array(16).fill(0)},800,400)).toBeNull()
    expect(erpToViewport([.25,.5],camera,800,400)).toBeNull()
    expect(erpToViewport([0,2],camera,800,400)).toBeNull()
  })
})
