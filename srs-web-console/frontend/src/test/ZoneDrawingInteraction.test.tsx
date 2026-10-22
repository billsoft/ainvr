import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {ZoneEditor} from './WorkspaceEditorHarness'
const reference={url:'drawing.jpg',width:1000,height:500,geometryRevision:'g',capturedAt:'now'}
const existing={id:'old',name:'已有禁区',points:[[.1,.1],[.4,.1],[.4,.4],[.1,.4]] as [number,number][]}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})
function setup(){
 class Pointer extends MouseEvent {readonly pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1}}
 vi.stubGlobal('PointerEvent',Pointer)
 const save=vi.fn().mockResolvedValue(undefined)
 render(<ZoneEditor reference={reference} referenceZones={[existing]} defaultName="新热区" onCommit={save} onCancel={()=>{}}/>)
 const image=screen.getByAltText('警戒区原始参考画面')
 Object.defineProperties(image,{naturalWidth:{value:1000},naturalHeight:{value:500}});fireEvent.load(image)
 const svg=screen.getByLabelText('警戒区绘图区域')
 vi.spyOn(svg.parentElement!,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:500} as DOMRect)
 svg.setPointerCapture=vi.fn()
 return {save,svg}
}
it('keeps named previous zones visible but non-interactive while drawing',()=>{
 const {svg}=setup()
 const overlay=screen.getByLabelText('已有热区参考')
 expect(overlay).toHaveClass('pointer-events-none')
 expect(screen.getByText('已有禁区')).toBeInTheDocument()
 fireEvent.click(svg,{clientX:100,clientY:100})
 expect(screen.getByText('已有禁区')).toBeInTheDocument()
})
it('closes the preview from the third point and still accepts a fourth point without a close button',async()=>{
 const {svg,save}=setup()
 for(const [x,y] of [[100,100],[700,100],[700,400]])fireEvent.click(svg,{clientX:x,clientY:y})
 expect(svg.querySelector('polygon')?.getAttribute('points')?.split(' ')).toHaveLength(3)
 expect(screen.queryByRole('button',{name:'闭合区域'})).not.toBeInTheDocument()
 fireEvent.click(svg,{clientX:100,clientY:400})
 expect(svg.querySelector('polygon')?.getAttribute('points')?.split(' ')).toHaveLength(4)
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0].points).toEqual([[.1,.2],[.7,.2],[.7,.8],[.1,.8]])
})
it.each(['forward','reverse'])('draws a %s rectangle with one drag; preview is not saved and undo removes it in one step',async(direction)=>{
 const {svg,save}=setup();fireEvent.click(screen.getByRole('button',{name:'矩形'}))
 const a=direction==='forward'?[100,100]:[700,400],b=direction==='forward'?[700,400]:[100,100]
 fireEvent.pointerDown(svg,{pointerId:1,button:0,clientX:a[0],clientY:a[1]})
 fireEvent.pointerMove(svg,{pointerId:1,clientX:b[0],clientY:b[1]})
 expect(svg.querySelector('polygon')).not.toBeNull();expect(save).not.toHaveBeenCalled()
 fireEvent.pointerUp(svg,{pointerId:1,clientX:b[0],clientY:b[1]})
 expect(screen.getAllByRole('button',{name:/顶点 \d+，/})).toHaveLength(4)
 fireEvent.click(screen.getByRole('button',{name:'撤销'}))
 expect(screen.queryByRole('button',{name:/顶点 1，/})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'重做'}))
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}));await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0].points).toEqual([[.1,.2],[.7,.2],[.7,.8],[.1,.8]])
})
it.each(['pointercancel','lostpointercapture'])('cancels rectangle on %s and ignores another finger',type=>{
 const {svg}=setup();fireEvent.click(screen.getByRole('button',{name:'矩形'}))
 fireEvent.pointerDown(svg,{pointerId:1,button:0,clientX:100,clientY:100})
 fireEvent.pointerMove(svg,{pointerId:1,clientX:700,clientY:400})
 fireEvent.pointerDown(svg,{pointerId:2,button:0,clientX:10,clientY:10})
 fireEvent.pointerUp(svg,{pointerId:2,clientX:20,clientY:20})
 expect(svg.setPointerCapture).toHaveBeenCalledTimes(1)
 fireEvent(svg,new PointerEvent(type,{bubbles:true,pointerId:1}))
 expect(svg.querySelector('polygon')).toBeNull()
 expect(screen.getByRole('button',{name:'撤销'})).toBeDisabled()
})
it('rejects a zero-height drag without creating a broken rectangle',()=>{
 const {svg,save}=setup();fireEvent.click(screen.getByRole('button',{name:'矩形'}))
 fireEvent.pointerDown(svg,{pointerId:1,button:0,clientX:100,clientY:100})
 fireEvent.pointerMove(svg,{pointerId:1,clientX:700,clientY:100})
 fireEvent.pointerUp(svg,{pointerId:1,clientX:700,clientY:100})
 expect(screen.queryByRole('button',{name:/顶点 1，/})).not.toBeInTheDocument()
 expect(save).not.toHaveBeenCalled()
})
