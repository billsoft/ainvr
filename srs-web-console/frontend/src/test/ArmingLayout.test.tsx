import {render,screen,fireEvent,within} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {ArmingModal} from '@/pages/AlarmCenter/ArmingModal'
import {ZoneEditor} from './WorkspaceEditorHarness'
import type {ArmingDocument} from '@/features/armingDocument'
const base:ArmingDocument={source_id:'cam',geometry_revision:'g',revision:1,zones:[{zone_id:'z',channel_id:'cam',geometry_revision:'g',version:1,name:'门',state:'active',points:[[.1,.1],[.9,.1],[.9,.9]],edge_ids:['a','b','c']}],assignments:[]}
const reference={url:'image',width:1000,height:500,geometryRevision:'g',capturedAt:'now'}
const arming=(props:Partial<Parameters<typeof ArmingModal>[0]>={})=>render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[]} sources={[]} send={vi.fn()} onClose={vi.fn()} onSaved={vi.fn()} {...props}/>)
const scrolled=(el:Element)=>!!el.closest('[data-scroll-region]')
it('drawing shares the same picture and toolbar; Escape cancels only unfinished drawing',()=>{
 const close=vi.fn();arming({onClose:close})
 const image=screen.getByAltText('布防参考画面')
 Object.defineProperties(image,{naturalWidth:{value:1000},naturalHeight:{value:500}});fireEvent.load(image)
 fireEvent.click(screen.getByRole('button',{name:'新增热区'}))
 expect(scrolled(image)).toBe(false)
 expect(screen.getAllByRole('toolbar')).toHaveLength(1)
 expect(screen.getByLabelText('绘制新热区')).toBeInTheDocument()
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'})
 expect(screen.queryByLabelText('绘制新热区')).not.toBeInTheDocument()
 expect(close).not.toHaveBeenCalled()
})
it('a zone is chosen from the picture, its marker, or the zone list; its selections show on the picture',()=>{
 arming({base:{...base,assignments:[{assignment_id:'s',trigger_id:'t',processor_id:'ai',zone_id:'z',version:1,input_stream_id:'cam',entry_edges:[],exit_edges:[]} as never]},
  definitions:[{trigger_id:'t',name:'闯入',state:'enabled',behavior:'region_enter',labels:[]} as never]})
 expect(screen.getByRole('button',{name:'门：触发器 1，计数器 0'})).toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('选择热区'),{target:{value:'z'}})
 const card=screen.getByRole('region',{name:'门 的选用'})
 for(const name of ['调整 闯入 · 门','为 门 选用触发器','为 门 选用计数器'])expect(within(card).getByRole('button',{name})).toBeInTheDocument()
 fireEvent.click(within(card).getByRole('button',{name:'调整 闯入 · 门'}))
 // While editing, the picture only takes taps on edges: markers go away.
 expect(screen.getByRole('complementary',{name:'编辑窗'})).toBeInTheDocument()
 expect(screen.queryByRole('region',{name:'门 的选用'})).not.toBeInTheDocument()
 expect(screen.queryByLabelText('热区名称')).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'返回关联'})).toBeInTheDocument()
 expect(screen.getByRole('button',{name:'保存布防'})).toBeEnabled()
 fireEvent.click(screen.getByRole('button',{name:'撤销本处修改'}))
 expect(screen.getByRole('complementary',{name:'编辑窗'})).toBeInTheDocument()
 expect(screen.getByRole('region',{name:'门 的选用'})).toBeInTheDocument()
})
it('the coordinate choice appears only for a panoramic source and defaults to wrap-around',()=>{
 const view=arming()
 expect(screen.queryByLabelText('布防画面类型')).not.toBeInTheDocument()
 view.unmount()
 arming({panoramic:true,base:{...base,zones:[]}})
 expect(screen.getByLabelText('布防画面类型')).toHaveValue('erp')
})
it('a vertex is inserted by tapping the plus on the edge midpoint',()=>{
 render(<ZoneEditor reference={{...reference,url:'edit.jpg'}} initial={{name:'门',points:[[.1,.1],[.8,.1],[.8,.8],[.1,.8]],geometryRevision:'g'}} onCommit={vi.fn()} onCancel={vi.fn()}/>)
 const image=screen.getByAltText('警戒区原始参考画面')
 Object.defineProperties(image,{naturalWidth:{value:1000},naturalHeight:{value:500}});fireEvent.load(image)
 expect(screen.queryByRole('button',{name:'边 1'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'多边形'}))
 fireEvent.click(screen.getByRole('button',{name:'在边 1 中点插入顶点'}))
 expect(screen.getAllByRole('button',{name:/^顶点 \d+，/})).toHaveLength(5)
})
