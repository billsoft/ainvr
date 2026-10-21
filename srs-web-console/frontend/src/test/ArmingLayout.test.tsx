import {render,screen,fireEvent,within} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {ArmingModal} from '@/pages/AlarmCenter/ArmingModal'
import {ZoneEditor} from '@/pages/AlarmCenter/ZoneEditor'
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
it('one cancel leaves arming from inside the zone editor after a single confirmation',()=>{
 const close=vi.fn()
 arming({onClose:close})
 fireEvent.click(screen.getByRole('button',{name:'新增热区'}))
 const footer=screen.getByRole('contentinfo')
 fireEvent.click(within(footer).getByRole('button',{name:'取消'}))
 fireEvent.click(within(screen.getByRole('alertdialog',{name:'放弃布防修改'})).getByRole('button',{name:'放弃布防修改'}))
 expect(close).toHaveBeenCalledOnce()
})
it('the coordinate choice appears only for a panoramic source and defaults to wrap-around',()=>{
 const view=arming()
 expect(screen.queryByLabelText('布防画面类型')).not.toBeInTheDocument()
 view.unmount()
 arming({panoramic:true,base:{...base,zones:[]}})
 expect(screen.getByLabelText('布防画面类型')).toHaveValue('erp')
})
it('a vertex is inserted by tapping the plus on the edge midpoint',()=>{
 render(<ZoneEditor reference={{...reference,url:'edit.jpg'}} initial={{name:'门',points:[[.1,.1],[.8,.1],[.8,.8],[.1,.8]],geometryRevision:'g'}} onSave={vi.fn()} onCancel={vi.fn()}/>)
 const image=screen.getByAltText('警戒区原始参考画面')
 Object.defineProperties(image,{naturalWidth:{value:1000},naturalHeight:{value:500}});fireEvent.load(image)
 expect(screen.queryByRole('button',{name:'边 1'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'在边 1 中点插入顶点'}))
 expect(screen.getAllByRole('button',{name:/^顶点 \d+，/})).toHaveLength(5)
})
