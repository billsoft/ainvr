import {expect,it,vi} from 'vitest'
import {renderHook} from '@testing-library/react'
import {PerspectiveCamera} from 'three'
import {usePlayerView} from '@/components/player/PlayerViewControls'
it('projects retained trails with the current video camera and dashes predicted segments',()=>{
 const {result}=renderHook(()=>usePlayerView({current:null}))
 const camera=new PerspectiveCamera(75,2,.1,20);camera.updateMatrixWorld()
 result.current.receivePanoramaCamera({view:camera.matrixWorldInverse.elements,projection:camera.projectionMatrix.elements})
 const ctx={save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),setLineDash:vi.fn()}
 const draw=()=>result.current.drawPanoramaFrame(ctx as unknown as CanvasRenderingContext2D,[],1000,500,2000,1000,undefined,[{id:'s:1',points:[{x:1450,y:500,ptsNs:1},{x:1500,y:500,ptsNs:2,predicted:true}]}])
 draw();expect(ctx.lineTo).toHaveBeenCalled();expect(ctx.setLineDash).toHaveBeenCalledWith([6,4])
 ctx.lineTo.mockClear();camera.rotation.y=Math.PI;camera.updateMatrixWorld()
 result.current.receivePanoramaCamera({view:camera.matrixWorldInverse.elements,projection:camera.projectionMatrix.elements})
 draw();expect(ctx.lineTo).not.toHaveBeenCalled()
})
