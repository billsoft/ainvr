import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {ZoneEditor} from './WorkspaceEditorHarness'
const reference={url:'edit.jpg',width:1000,height:500,geometryRevision:'g1',capturedAt:'now'}
const points:[number,number][]=[[.1,.1],[.8,.1],[.8,.8],[.1,.8]]
function setup(){
 const save=vi.fn().mockResolvedValue(undefined)
 render(<ZoneEditor reference={reference} initial={{name:'门',points,geometryRevision:'g1'}} onCommit={save} onCancel={()=>{}}/> )
 const image=screen.getByAltText('警戒区原始参考画面')
 Object.defineProperties(image,{naturalWidth:{value:1000},naturalHeight:{value:500}});fireEvent.load(image)
 return save
}
it('inserts at the tapped edge midpoint, deletes the selected vertex, and retains shape through undo',async()=>{
 const save=setup()
 fireEvent.click(screen.getByRole('button',{name:'在边 1 中点插入顶点'}))
 expect(screen.getAllByRole('button',{name:/顶点 \d+，/})).toHaveLength(5)
 fireEvent.click(screen.getByRole('button',{name:'删除选中顶点'}))
 expect(screen.getAllByRole('button',{name:/顶点 \d+，/})).toHaveLength(4)
 fireEvent.click(screen.getByRole('button',{name:'撤销'}))
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0].points).toEqual([[.1,.1],[.45,.1],[.8,.1],[.8,.8],[.1,.8]])
})
it('explicit pan supports keyboard, keeps shape inside frame, and can be undone',async()=>{
 const save=setup()
 fireEvent.click(screen.getByRole('button',{name:'平移区域'}))
 const canvas=screen.getByLabelText('区域平移操作面')
 fireEvent.keyDown(canvas,{key:'ArrowRight',shiftKey:true})
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0].points[0][0]).toBeCloseTo(.11)
 expect(save.mock.calls[0]![0].points[1][0]).toBeCloseTo(.81)
})
it('drawing tools sit in the toolbar above the picture and deleting below three vertices is blocked',()=>{
 setup()
 const image=screen.getByAltText('警戒区原始参考画面')
 // Like the arming toolbar it replaces: tools on top, the picture below.
 expect(image.compareDocumentPosition(screen.getByRole('toolbar',{name:'热区绘制工具'})) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:/顶点 1，/}))
 fireEvent.click(screen.getByRole('button',{name:'删除选中顶点'}))
 fireEvent.click(screen.getByRole('button',{name:/顶点 1，/}))
 expect(screen.getByRole('button',{name:'删除选中顶点'})).toBeDisabled()
})

it('undo removes the inserted vertex and its edge handle',()=>{
 setup()
 fireEvent.click(screen.getByRole('button',{name:'在边 4 中点插入顶点'}))
 expect(screen.getByRole('button',{name:'在边 5 中点插入顶点'})).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'撤销'}))
 expect(screen.queryByRole('button',{name:'在边 5 中点插入顶点'})).not.toBeInTheDocument()
})
it('keyboard pan clamps at frame edge without changing polygon dimensions',async()=>{
 const save=setup()
 fireEvent.click(screen.getByRole('button',{name:'平移区域'}))
 const canvas=screen.getByLabelText('区域平移操作面')
 for(let i=0;i<30;i++)fireEvent.keyDown(canvas,{key:'ArrowRight',shiftKey:true})
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 const result=save.mock.calls[0]![0].points
 expect(result[1][0]).toBe(1)
 expect(result[1][0]-result[0][0]).toBeCloseTo(.7)
})

it('cancelled touch pan restores geometry; committed pan is a single undo step',async()=>{
 vi.stubGlobal('PointerEvent',MouseEvent)
 try{
  const save=setup()
  const svg=screen.getByLabelText('警戒区绘图区域')
  vi.spyOn(svg.parentElement!,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:500} as DOMRect)
  fireEvent.click(screen.getByRole('button',{name:'平移区域'}))
  const canvas=screen.getByLabelText('区域平移操作面')
  canvas.setPointerCapture=vi.fn()
  fireEvent.pointerDown(canvas,{clientX:200,clientY:200})
  fireEvent.pointerMove(canvas,{clientX:250,clientY:200})
  fireEvent.pointerCancel(canvas)
  expect(screen.getByRole('button',{name:'撤销'})).toBeDisabled()
  fireEvent.pointerDown(canvas,{clientX:200,clientY:200})
  fireEvent.pointerMove(canvas,{clientX:250,clientY:200})
  fireEvent.pointerUp(canvas)
  fireEvent.click(screen.getByRole('button',{name:'撤销'}))
  expect(screen.getByRole('button',{name:'撤销'})).toBeDisabled()
  fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('button',{name:'顶点 1，方向键调整'})).toHaveStyle({left:'10%',top:'10%'})
 }finally{vi.unstubAllGlobals()}
})

it.each(['vertex','pan'])('touch %s ignores another finger and restores on capture loss',async(kind)=>{
 class TouchPointer extends MouseEvent {
  readonly pointerId:number
  readonly pointerType='touch'
  constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1}
 }
 vi.stubGlobal('PointerEvent',TouchPointer)
 try{
  const save=setup(),svg=screen.getByLabelText('警戒区绘图区域')
  vi.spyOn(svg.parentElement!,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:500} as DOMRect)
  if(kind==='pan')fireEvent.click(screen.getByRole('button',{name:'平移区域'}))
  const target=kind==='pan'?screen.getByLabelText('区域平移操作面'):screen.getByRole('button',{name:/顶点 1，/})
  target.setPointerCapture=vi.fn()
  const event=(type:string,pointerId:number,x=100)=>fireEvent(target,new TouchPointer(type,{bubbles:true,pointerId,clientX:x,clientY:50}))
  event('pointerdown',1)
  event('pointermove',1,150)
  event('pointerdown',2,700)
  event('pointermove',2,900)
  event('pointerup',2)
  expect(target.setPointerCapture).toHaveBeenCalledTimes(1)
  event('lostpointercapture',1)
  expect(screen.getByRole('button',{name:'撤销'})).toBeDisabled()
  fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('button',{name:'顶点 1，方向键调整'})).toHaveStyle({left:'10%',top:'10%'})
 }finally{vi.unstubAllGlobals()}
})

it.each(['polygon','rectangle'])('undo while drawing %s preserves the ability to finish drawing',async(kind)=>{
 const save=vi.fn().mockResolvedValue(undefined)
 render(<ZoneEditor reference={reference} onCommit={save} onCancel={()=>{}}/>)
 const image=screen.getByAltText('警戒区原始参考画面')
 Object.defineProperties(image,{naturalWidth:{value:1000},naturalHeight:{value:500}});fireEvent.load(image)
 const svg=screen.getByLabelText('警戒区绘图区域')
 vi.spyOn(svg.parentElement!,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:500} as DOMRect)
 fireEvent.change(screen.getByLabelText('区域名称'),{target:{value:'新区域'}})
 if(kind==='rectangle')fireEvent.click(screen.getByRole('button',{name:'矩形'}))
 fireEvent.click(svg,{clientX:100,clientY:100})
 fireEvent.click(svg,{clientX:400,clientY:200})
 fireEvent.click(screen.getByRole('button',{name:'撤销'}))
 expect(screen.getAllByRole('button',{name:/顶点 \d+，/})).toHaveLength(1)
 fireEvent.click(screen.getByRole('button',{name:'重做'}))
 fireEvent.click(screen.getByRole('button',{name:'撤销'}))
 fireEvent.click(svg,{clientX:500,clientY:300})
 if(kind==='polygon'){
  fireEvent.click(svg,{clientX:100,clientY:300})
 }
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0].points).toHaveLength(kind==='polygon'?3:4)
})
it('clearing and redrawing the zone is reported as a redraw; moving vertices is not',async()=>{
 const save=setup()
 fireEvent.keyDown(screen.getByRole('button',{name:'顶点 1，方向键调整'}),{key:'ArrowRight'})
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0].redrawn).toBeFalsy()
})
it('a zone redrawn from another corner is marked redrawn so its counting lines must be set again',async()=>{
 const save=setup()
 fireEvent.click(screen.getByRole('button',{name:'清空顶点'}))
 const canvas=screen.getByLabelText('警戒区绘图区域')
 vi.spyOn(canvas.parentElement!,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:500,right:1000,bottom:500,x:0,y:0,toJSON:()=>({})})
 for(const [x,y] of [[800,50],[800,400],[100,400],[100,50]])fireEvent.click(canvas,{clientX:x,clientY:y})
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0]).toMatchObject({redrawn:true})
})
it('preview stays closed while vertex selection permits more points, and undo restores the triangle',async()=>{
 const save=vi.fn().mockResolvedValue(undefined)
 render(<ZoneEditor reference={reference} defaultName="热区 1" onCommit={save} onCancel={()=>{}}/>)
 const image=screen.getByAltText('警戒区原始参考画面')
 Object.defineProperties(image,{naturalWidth:{value:1000},naturalHeight:{value:500}});fireEvent.load(image)
 const svg=screen.getByLabelText('警戒区绘图区域')
 vi.spyOn(svg.parentElement!,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:500} as DOMRect)
 for(const [x,y] of [[100,100],[500,100],[500,400]])fireEvent.click(svg,{clientX:x,clientY:y})
 fireEvent.click(screen.getByRole('button',{name:'顶点 1，方向键调整'}))
 expect(screen.queryByRole('button',{name:'闭合区域'})).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'在边 3 中点插入顶点'})).toBeInTheDocument()
 fireEvent.click(svg,{clientX:100,clientY:400})
 expect(screen.getAllByRole('button',{name:/顶点 \d+，/})).toHaveLength(4)
 fireEvent.click(screen.getByRole('button',{name:'撤销'}))
 fireEvent.click(screen.getByRole('button',{name:'提交草稿'}))
 await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0]).toMatchObject({name:'热区 1',points:[[.1,.2],[.5,.2],[.5,.8]]})
})
