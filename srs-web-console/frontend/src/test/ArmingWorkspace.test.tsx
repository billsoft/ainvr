import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {placeMarkers,type MarkerTarget} from '@/features/armingMarkerLayout'
import {ArmingModal} from '@/pages/AlarmCenter/ArmingModal'
import type {ArmingDocument} from '@/features/armingDocument'
const base:ArmingDocument={source_id:'cam',geometry_revision:'g',revision:1,zones:[{zone_id:'z',channel_id:'cam',geometry_revision:'g',version:1,name:'门',state:'active',points:[[.1,.1],[.9,.1],[.9,.9]],edge_ids:['a','b','c']}],assignments:[]}
const reference={url:'image',width:1000,height:500,geometryRevision:'g',capturedAt:'now'}
const source={channel_id:'ai',channel_name:'检测',input_stream_id:'cam',input_name:'门',label_map_version:'l',geometry_revision:'g',tracking_available:true,labels:[{class_id:0,label_id:'person',name:'人',description:''}]}
const definition={trigger_id:'t',name:'人员出现',behavior:'appearance',labels:[{label_id:'person',name:'人'}],duration_ms:0,alarm_enabled:true,state:'enabled',schedule:{mode:'always'},version:1} as const
const open=(sources=[source],send=vi.fn().mockResolvedValue({saved:true,sourceId:'cam',revision:2,application:{state:'applied'}}))=>{
 render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[definition as never]} sources={sources} send={send} onClose={vi.fn()} onSaved={vi.fn()}/>);return send
}
it('one global save flushes an open trigger picker; there is no nested confirmation',async()=>{
 const send=open()
 fireEvent.click(screen.getByRole('button',{name:'整个画面的触发器（0）'}))
 fireEvent.click(screen.getByLabelText('人员出现'))
 expect(screen.queryByRole('button',{name:'添加所选触发器'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}))
 await waitFor(()=>expect(send).toHaveBeenCalledOnce())
 expect(send.mock.calls[0]![0].assignments).toEqual([expect.objectContaining({trigger_id:'t',processor_id:'ai',zone_id:null})])
})
it('switching scope retains a valid selection without writing, then global undo removes it',()=>{
 const send=open()
 fireEvent.click(screen.getByRole('button',{name:'整个画面的触发器（0）'}));fireEvent.click(screen.getByLabelText('人员出现'))
 fireEvent.change(screen.getByLabelText('选择热区'),{target:{value:'z'}})
 expect(screen.getByRole('button',{name:'整个画面：触发器 1，计数器 0'})).toBeInTheDocument()
 expect(send).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'撤销布防修改'}))
 expect(screen.getByRole('button',{name:'整个画面：触发器 0，计数器 0'})).toBeInTheDocument()
})
it('invalid selection cannot leave or save; discarding it does not change the draft',()=>{
 const send=open([])
 fireEvent.click(screen.getByRole('button',{name:'整个画面的触发器（0）'}));fireEvent.click(screen.getByLabelText('人员出现'))
 fireEvent.click(screen.getByRole('button',{name:'返回关联'}));expect(screen.getByRole('region',{name:'选择多个触发器'})).toBeInTheDocument()
 expect(screen.getByRole('alertdialog',{name:'放弃本处修改'})).toBeInTheDocument()
 expect(send).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'放弃本处修改'}))
 expect(screen.getByRole('button',{name:'保存布防'})).toBeDisabled()
})

function loadFrame(){
 const image=screen.getByAltText('布防参考画面')
 Object.defineProperties(image,{naturalWidth:{value:1000},naturalHeight:{value:500}});fireEvent.load(image)
 vi.spyOn(image.parentElement!,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:500} as DOMRect)
}
it('rename and reshape directly beside associations, one global save contains both',async()=>{
 const send=open();loadFrame();fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}))
 expect(screen.queryByRole('button',{name:'编辑 门'})).not.toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('热区名称'),{target:{value:'入口'}})
 fireEvent.blur(screen.getByLabelText('热区名称'))
 fireEvent.keyDown(screen.getByRole('button',{name:'调整顶点 1'}),{key:'ArrowRight'})
 expect(screen.getByRole('button',{name:'为 入口 选用计数器'})).toBeInTheDocument()
 expect(send).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}))
 await waitFor(()=>expect(send).toHaveBeenCalledOnce())
 expect(send.mock.calls[0]![0].zones[0]).toMatchObject({name:'入口',points:[[.101,.1],[.9,.1],[.9,.9]],edge_ids:['a','b','c']})
})
it('invalid name blocks switching and saving, close still offers discard',()=>{
 const send=open();fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}))
 fireEvent.change(screen.getByLabelText('热区名称'),{target:{value:''}})
 fireEvent.change(screen.getByLabelText('选择热区'),{target:{value:'*'}})
 expect(screen.getByLabelText('选择热区')).toHaveValue('z')
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}))
 expect(send).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent('名称')
 fireEvent.click(screen.getByRole('button',{name:'关闭'}))
 expect(screen.getByRole('alertdialog',{name:'放弃布防修改'})).toBeInTheDocument()
})
it('drawing a rectangle auto-selects it with its name and association controls',()=>{
 class Pointer extends MouseEvent {readonly pointerId=1}
 vi.stubGlobal('PointerEvent',Pointer)
 try{
 const send=open();loadFrame();fireEvent.click(screen.getByRole('button',{name:'新增热区'}))
 const drawing=screen.getByLabelText('绘制新热区');drawing.setPointerCapture=vi.fn()
 fireEvent.pointerDown(drawing,{clientX:100,clientY:100});fireEvent.pointerMove(drawing,{clientX:500,clientY:300});fireEvent.pointerUp(drawing,{clientX:500,clientY:300})
 expect(screen.queryByLabelText('绘制新热区')).not.toBeInTheDocument()
 expect(screen.getByLabelText('热区名称')).toHaveValue('热区 2')
 expect(screen.getByRole('button',{name:'为 热区 2 选用计数器'})).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'撤销布防修改'}))
 expect(screen.queryByRole('button',{name:'选择热区 热区 2'})).not.toBeInTheDocument()
 expect(send).not.toHaveBeenCalled()
 }finally{vi.unstubAllGlobals()}
})
it('polygon drawing keeps other zones visible and explicitly finishes without a nested save',()=>{
 vi.stubGlobal('PointerEvent',MouseEvent)
 try{
 open();loadFrame();fireEvent.click(screen.getByRole('button',{name:'新增热区'}));fireEvent.click(screen.getByRole('button',{name:'多边形'}))
 const drawing=screen.getByLabelText('绘制新热区')
 for(const [x,y] of [[100,100],[500,100],[500,300]])fireEvent.pointerDown(drawing,{clientX:x,clientY:y})
 expect(screen.getByRole('button',{name:'选择热区 门'})).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'完成绘制'}))
 expect(screen.getByLabelText('热区名称')).toHaveValue('热区 2')
 expect(screen.getAllByRole('button',{name:/调整顶点/})).toHaveLength(3)
 }finally{vi.unstubAllGlobals()}
})
it('cancelled drag leaves no history; completed translation is one undo and redo',()=>{
 class Pointer extends MouseEvent {readonly pointerId=1}
 vi.stubGlobal('PointerEvent',Pointer)
 try{
 const send=open();loadFrame();fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}))
 const target=screen.getByRole('button',{name:'拖动热区 门'});target.setPointerCapture=vi.fn()
 fireEvent.pointerDown(target,{clientX:200,clientY:100});fireEvent.pointerMove(target,{clientX:250,clientY:125});fireEvent.pointerCancel(target)
 expect(screen.getByRole('button',{name:'撤销布防修改'})).toBeDisabled()
 fireEvent.pointerDown(target,{clientX:200,clientY:100});fireEvent.pointerMove(target,{clientX:250,clientY:125});fireEvent.pointerUp(target)
 expect(parseFloat(screen.getByRole('button',{name:'调整顶点 1'}).style.left)).toBeCloseTo(15)
 fireEvent.click(screen.getByRole('button',{name:'撤销布防修改'}))
 expect(screen.getByRole('button',{name:'调整顶点 1'})).toHaveStyle({left:'10%'})
 expect(screen.getByRole('button',{name:'撤销布防修改'})).toBeDisabled()
 fireEvent.click(screen.getByRole('button',{name:'重做布防修改'}))
 expect(parseFloat(screen.getByRole('button',{name:'调整顶点 1'}).style.left)).toBeCloseTo(15)
 expect(send).not.toHaveBeenCalled()
 }finally{vi.unstubAllGlobals()}
})
it('an invalid crossing corner reverts and keeps association identity',()=>{
 vi.stubGlobal('PointerEvent',MouseEvent)
 try{
 const send=open();loadFrame();fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}))
 const handle=screen.getByRole('button',{name:'调整顶点 1'});handle.setPointerCapture=vi.fn()
 fireEvent.pointerDown(handle,{clientX:100,clientY:50});fireEvent.pointerMove(handle,{clientX:900,clientY:50});fireEvent.pointerUp(handle)
 expect(screen.getByRole('alert')).toHaveTextContent('重合')
 expect(handle).toHaveStyle({left:'10%'})
 expect(screen.getByRole('button',{name:'保存布防'})).toBeDisabled()
 expect(send).not.toHaveBeenCalled()
 }finally{vi.unstubAllGlobals()}
})
it('marker placement keeps sixteen crowded zone labels inside a desktop canvas without overlaps',()=>{
 const targets:MarkerTarget[]=Array.from({length:16},(_,i)=>({id:String(i),name:String(i),points:[[.45,.45],[.55,.45],[.55,.55]],triggers:[],counters:[]}))
 const boxes=placeMarkers(targets,1200,650)
 for(const [i,a] of boxes.entries()){
  expect(a.x).toBeGreaterThanOrEqual(0);expect(a.x+a.w).toBeLessThanOrEqual(1200);expect(a.y+a.h).toBeLessThanOrEqual(650)
  for(const b of boxes.slice(i+1))expect(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y).toBe(true)
 }
})

it('association mode hides overview actions and returns with the selected trigger in the overview',async()=>{
 const send=open()
 fireEvent.click(screen.getByRole('button',{name:'整个画面：触发器 0，计数器 0'}))
 fireEvent.click(screen.getByRole('button',{name:'整个画面选用触发器'}))
 expect(screen.queryByRole('region',{name:'整个画面 的选用'})).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'整个画面选用触发器'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByLabelText('人员出现'))
 fireEvent.click(screen.getByRole('button',{name:'完成关联'}))
 expect(screen.queryByRole('region',{name:'选择多个触发器'})).not.toBeInTheDocument()
 expect(screen.getByRole('heading',{name:'已关联触发器 1'})).toBeInTheDocument()
 expect(screen.getByRole('button',{name:'调整 人员出现 · 整个画面'})).toHaveTextContent('已关联')
 expect(send).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}))
 await waitFor(()=>expect(send).toHaveBeenCalledOnce())
 expect(send.mock.calls[0]![0].assignments).toHaveLength(1)
})
it('completion validates pending selection without discarding it or leaving the picker',()=>{
 const send=open([])
 fireEvent.click(screen.getByRole('button',{name:'整个画面的触发器（0）'}))
 fireEvent.click(screen.getByLabelText('人员出现'))
 fireEvent.click(screen.getByRole('button',{name:'完成关联'}))
 expect(screen.getByRole('region',{name:'选择多个触发器'})).toBeInTheDocument()
 expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
 expect(send).not.toHaveBeenCalled()
})
it('returning from an empty picker restores the overview without creating a draft change',()=>{
 open();fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}))
 fireEvent.click(screen.getByRole('button',{name:'为 门 选用触发器'}))
 expect(screen.queryByRole('button',{name:'为 门 选用计数器'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'返回关联'}))
 expect(screen.getByRole('button',{name:'为 门 选用计数器'})).toBeInTheDocument()
 expect(screen.getByRole('button',{name:'保存布防'})).toBeDisabled()
})
