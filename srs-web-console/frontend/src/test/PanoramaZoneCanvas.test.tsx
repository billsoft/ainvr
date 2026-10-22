import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {PanoramaZoneCanvas} from '@/pages/AlarmCenter/PanoramaZoneCanvas'
import {ZoneEditor} from './WorkspaceEditorHarness'
vi.mock('three',async importOriginal=>{
  const real=await importOriginal<typeof import('three')>()
  return {...real,
    WebGLRenderer:class {
      domElement=document.createElement('canvas')
      setPixelRatio(){} setSize(){} render(){} dispose(){} forceContextLoss(){}
    },
    TextureLoader:class {load(_url:string,loaded:(t:unknown)=>void){loaded(new real.Texture())}},
  }
})
const points:[number,number][]=[[.70,.4],[.8,.4],[.8,.6],[.7,.6]]
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})
function setup(withReference=false){
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}})
 vi.stubGlobal('PointerEvent',class extends MouseEvent {pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1}})
 HTMLElement.prototype.setPointerCapture=vi.fn()
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(800)
 vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(450)
 const change=vi.fn(),add=vi.fn()
 render(<PanoramaZoneCanvas url="reference.jpg" points={points} locked={false} finished={true}
   referenceZones={withReference?[{id:'prior',name:'原有热区',points}]:[]} selected={null} onSelect={()=>{}} onAdd={add} onChange={change}/>)
 const canvas=screen.getByRole('group',{name:'360°热区编辑画面'})
 Object.defineProperty(canvas,'getBoundingClientRect',{value:()=>({left:0,top:0,width:800,height:450})})
 fireEvent.click(screen.getByRole('button',{name:'绘制与拖点'}))
 return {change,canvas}
}
it('projects existing reference zones into the same panorama without making them draggable',()=>{
 setup(true)
 const reference=screen.getByLabelText('已有热区参考')
 expect(reference).toHaveClass('pointer-events-none')
 expect(reference.querySelector('path')?.getAttribute('d')).not.toBe('')
 expect(reference).toHaveTextContent('原有热区')
})
it('keeps preview drags local until release, then commits inverse-projected source coordinates',async()=>{
 const {change}=setup()
 const handle=await screen.findByRole('button',{name:'全景顶点 1'})
 await waitFor(()=>expect(handle).toBeEnabled())
 fireEvent.pointerDown(handle,{pointerId:1,button:0,clientX:250,clientY:140})
 fireEvent.pointerMove(handle,{pointerId:1,clientX:400,clientY:225})
 expect(change).not.toHaveBeenCalled()
 fireEvent.pointerUp(handle,{pointerId:1})
 expect(change).toHaveBeenCalledOnce()
 expect(change.mock.calls[0]![0][0][0]).toBeCloseTo(.75)
 expect(change.mock.calls[0]![0][0][1]).toBeCloseTo(.5)
 expect(change.mock.calls[0]![0].slice(1)).toEqual(points.slice(1))
})
it('cancels interrupted drags without saving or changing the original polygon',async()=>{
 const {change}=setup()
 const handle=await screen.findByRole('button',{name:'全景顶点 1'})
 fireEvent.pointerDown(handle,{pointerId:1,button:0,clientX:250,clientY:140})
 fireEvent.pointerMove(handle,{pointerId:1,clientX:400,clientY:225})
 fireEvent.pointerCancel(handle,{pointerId:1})
 expect(change).not.toHaveBeenCalled()
 expect(points[0]).toEqual([.70,.4])
})
it('keeps the same source polygon when switching from panorama editing back to ERP and saving',async()=>{
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}})
 vi.stubGlobal('PointerEvent',class extends MouseEvent {pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1}})
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(800)
 vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(450)
 HTMLElement.prototype.setPointerCapture=vi.fn()
 const save=vi.fn().mockResolvedValue(undefined)
 render(<ZoneEditor panoramaAllowed reference={{url:'reference.jpg',width:1000,height:500,geometryRevision:'g1',capturedAt:'now'}}
   initial={{name:'门',points,geometryRevision:'g1'}} onCommit={save} onCancel={()=>{}}/>)
 const image=screen.getByAltText('警戒区原始参考画面')
 Object.defineProperties(image,{naturalWidth:{value:1000},naturalHeight:{value:500}})
 fireEvent.load(image)
 fireEvent.click(screen.getByRole('button',{name:'360° 编辑'}))
 const canvas=screen.getByRole('group',{name:'360°热区编辑画面'})
 Object.defineProperty(canvas,'getBoundingClientRect',{value:()=>({left:0,top:0,width:800,height:450})})
 fireEvent.click(screen.getByRole('button',{name:'绘制与拖点'}))
 const handle=screen.getByRole('button',{name:'全景顶点 1'})
 fireEvent.pointerDown(handle,{pointerId:1,button:0})
 fireEvent.pointerMove(handle,{pointerId:1,clientX:400,clientY:225})
 fireEvent.pointerUp(handle,{pointerId:1})
 fireEvent.click(screen.getByRole('button',{name:'切回平面画面'}))
 expect(screen.getByRole('button',{name:'顶点 1，方向键调整'}).style.left).toBe('75%')
 expect(screen.getByRole('button',{name:'顶点 1，方向键调整'}).style.top).toBe('50%')
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0].points).toEqual([[.75,.5],...points.slice(1)])
})
