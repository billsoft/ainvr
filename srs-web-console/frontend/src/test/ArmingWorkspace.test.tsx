import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {ArmingModal} from '@/pages/AlarmCenter/ArmingModal'
import {placeMarkers,type MarkerTarget} from '@/features/armingMarkerLayout'
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
it('one global save commits the open shape editor and its name',async()=>{
 const send=open();fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}));fireEvent.click(screen.getByRole('button',{name:'编辑 门'}))
 const image=screen.getByAltText('警戒区原始参考画面');Object.defineProperties(image,{naturalWidth:{value:1000},naturalHeight:{value:500}});fireEvent.load(image)
 fireEvent.change(screen.getByLabelText('区域名称'),{target:{value:'入口'}})
 expect(screen.queryByRole('button',{name:'保存区域'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}));await waitFor(()=>expect(send).toHaveBeenCalledOnce())
 expect(send.mock.calls[0]![0].zones[0]).toMatchObject({name:'入口'})
})
it('marker placement keeps sixteen crowded zone labels inside a desktop canvas without overlaps',()=>{
 const targets:MarkerTarget[]=Array.from({length:16},(_,i)=>({id:String(i),name:String(i),points:[[.45,.45],[.55,.45],[.55,.55]],triggers:[],counters:[]}))
 const boxes=placeMarkers(targets,1200,650)
 for(const [i,a] of boxes.entries()){
  expect(a.x).toBeGreaterThanOrEqual(0);expect(a.x+a.w).toBeLessThanOrEqual(1200);expect(a.y+a.h).toBeLessThanOrEqual(650)
  for(const b of boxes.slice(i+1))expect(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y).toBe(true)
 }
})
it('new and edited zones keep all other draft zones visible; shape editing has only one undo toolbar',()=>{
 open()
 fireEvent.click(screen.getByRole('button',{name:'新增热区'}))
 expect(screen.getByLabelText('已有热区参考')).toHaveTextContent('门')
 expect(screen.queryByRole('button',{name:'撤销布防修改'})).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'撤销'})).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'返回画面'}))
 fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}))
 fireEvent.click(screen.getByRole('button',{name:'编辑 门'}))
 expect(screen.getByLabelText('已有热区参考')).not.toHaveTextContent('门')
})
it('a newly drawn unsaved zone remains a reference when creating the next zone',()=>{
 const send=open();fireEvent.click(screen.getByRole('button',{name:'新增热区'}))
 const image=screen.getByAltText('警戒区原始参考画面');Object.defineProperties(image,{naturalWidth:{value:1000},naturalHeight:{value:500}});fireEvent.load(image)
 const svg=screen.getByLabelText('警戒区绘图区域')
 vi.spyOn(svg.parentElement!,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:500} as DOMRect)
 for(const [x,y] of [[100,100],[700,100],[700,400]])fireEvent.click(svg,{clientX:x,clientY:y})
 fireEvent.click(screen.getByRole('button',{name:'返回画面'}))
 fireEvent.click(screen.getByRole('button',{name:'新增热区'}))
 expect(screen.getByLabelText('已有热区参考')).toHaveTextContent('门')
 expect(screen.getByLabelText('已有热区参考')).toHaveTextContent('热区 2')
 expect(send).not.toHaveBeenCalled()
})

it('saving an untouched open shape closes the editor without writing a revision',()=>{
 const send=open();fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}));fireEvent.click(screen.getByRole('button',{name:'编辑 门'}));
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}));
 expect(send).not.toHaveBeenCalled();expect(screen.queryByLabelText('区域名称')).not.toBeInTheDocument();
 expect(screen.getByRole('dialog',{name:'布防 · 门'})).toHaveFocus();
 expect(screen.getByRole('button',{name:'保存布防'})).toBeDisabled();
});
it('Escape asks before discarding local edits and never writes production configuration',()=>{
 const send=open();fireEvent.click(screen.getByRole('button',{name:'新增热区'}));
 fireEvent.change(screen.getByLabelText('区域名称'),{target:{value:'未完成'}});
 fireEvent.keyDown(screen.getByLabelText('区域名称'),{key:'Escape'});
 expect(screen.getByRole('alertdialog',{name:'放弃本处修改'})).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));expect(screen.getByLabelText('区域名称')).toHaveValue('未完成');
 fireEvent.keyDown(screen.getByLabelText('区域名称'),{key:'Escape'});fireEvent.click(screen.getByRole('button',{name:'放弃本处修改'}));
 expect(screen.queryByLabelText('区域名称')).not.toBeInTheDocument();expect(send).not.toHaveBeenCalled();
});
