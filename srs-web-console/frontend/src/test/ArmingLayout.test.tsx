import {render,screen,fireEvent,within} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {ArmingModal} from '@/pages/AlarmCenter/ArmingModal'
import {ZoneEditor} from './WorkspaceEditorHarness'
import type {ArmingDocument} from '@/features/armingDocument'
const base:ArmingDocument={source_id:'cam',geometry_revision:'g',revision:1,zones:[{zone_id:'z',channel_id:'cam',geometry_revision:'g',version:1,name:'门',state:'active',points:[[.1,.1],[.9,.1],[.9,.9]],edge_ids:['a','b','c']}],assignments:[]}
const reference={url:'image',width:1000,height:500,geometryRevision:'g',capturedAt:'now'}
const arming=(props:Partial<Parameters<typeof ArmingModal>[0]>={})=>render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[]} sources={[]} send={vi.fn()} onClose={vi.fn()} onSaved={vi.fn()} {...props}/>)
const scrolled=(el:Element)=>!!el.closest('[data-scroll-region]')
it('picture and drawing tools are never inside the scrolling panel',()=>{
 arming()
 expect(scrolled(screen.getByAltText('布防参考画面'))).toBe(false)
 expect(scrolled(screen.getByRole('toolbar',{name:'布防工具'}))).toBe(false)
 fireEvent.click(screen.getByRole('button',{name:'新增热区'}))
 expect(scrolled(screen.getByAltText('警戒区原始参考画面'))).toBe(false)
 expect(scrolled(screen.getByRole('toolbar',{name:'热区绘制工具'}))).toBe(false)
})
it('drawing a zone is a step inside arming: back and Escape return to arming, they never close it',()=>{
 const close=vi.fn()
 arming({onClose:close})
 fireEvent.click(screen.getByRole('button',{name:'新增热区'}))
 expect(screen.getAllByRole('toolbar')).toHaveLength(1)
 expect(screen.getByRole('toolbar',{name:'热区绘制工具'})).toBeInTheDocument()
 // A new zone is named already, so drawing can start at once.
 expect(screen.getByLabelText('区域名称')).toHaveValue('热区 2')
 fireEvent.click(screen.getByRole('button',{name:'返回画面'}))
 expect(screen.getByRole('toolbar',{name:'布防工具'})).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'新增热区'}))
 fireEvent.keyDown(screen.getByLabelText('区域名称'),{key:'Escape'})
 expect(screen.getByRole('toolbar',{name:'布防工具'})).toBeInTheDocument()
 expect(close).not.toHaveBeenCalled()
 fireEvent.click(within(screen.getByRole('toolbar',{name:'布防工具'})).getByRole('button',{name:'取消'}))
 expect(close).toHaveBeenCalledOnce()
})
it('a zone is chosen from the picture, its marker, or the zone list; its selections show on the picture',()=>{
 arming({base:{...base,assignments:[{assignment_id:'s',trigger_id:'t',processor_id:'ai',zone_id:'z',version:1,input_stream_id:'cam',entry_edges:[],exit_edges:[]} as never]},
  definitions:[{trigger_id:'t',name:'闯入',state:'enabled',behavior:'region_enter',labels:[]} as never]})
 expect(screen.getByRole('button',{name:'门：触发器 1，计数器 0'})).toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('选择热区'),{target:{value:'z'}})
 const card=screen.getByRole('region',{name:'门 的选用'})
 for(const name of ['调整 闯入 · 门','为 门 选用触发器','为 门 选用计数器','编辑 门','移除 门'])expect(within(card).getByRole('button',{name})).toBeInTheDocument()
 fireEvent.click(within(card).getByRole('button',{name:'调整 闯入 · 门'}))
 // While editing, the picture only takes taps on edges: markers go away.
 expect(screen.getByRole('complementary',{name:'编辑窗'})).toBeInTheDocument()
 expect(screen.queryByRole('region',{name:'门 的选用'})).not.toBeInTheDocument()
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
 fireEvent.click(screen.getByRole('button',{name:'在边 1 中点插入顶点'}))
 expect(screen.getAllByRole('button',{name:/^顶点 \d+，/})).toHaveLength(5)
})
