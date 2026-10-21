import {render,screen,fireEvent,waitFor,act} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {ArmingModal} from '@/pages/AlarmCenter/ArmingModal'
import type {ArmingDocument} from '@/features/armingDocument'
const base:ArmingDocument={source_id:'cam',geometry_revision:'g',revision:1,zones:[{zone_id:'z',channel_id:'cam',geometry_revision:'g',version:1,name:'门',state:'active',points:[[.1,.1],[.9,.1],[.9,.9]],edge_ids:['a','b','c']}],assignments:[]}
const reference={url:'image',width:1000,height:500,geometryRevision:'g',capturedAt:'now'}
it('geometry replacement remains a cancellable draft and saves against the original revision',async()=>{
 const send=vi.fn().mockResolvedValue({saved:true,sourceId:'cam',revision:2,application:{state:'pending'}}),saved=vi.fn(),close=vi.fn()
 render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={{...reference,geometryRevision:'new'}} resetGeometry definitions={[]} sources={[]} send={send} onClose={close} onSaved={saved}/>)
 expect(screen.queryByRole('button',{name:'编辑 门'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'取消'}))
 expect(send).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'继续编辑'}))
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 expect(send.mock.calls[0]![0]).toMatchObject({geometryRevision:'new',expectedRevision:1,zones:[],assignments:[],removedZoneIds:['z']})
 expect(base.zones).toHaveLength(1)
})
it('fullscreen arming stays inside the visible fullscreen element and retains draft when leaving fullscreen',()=>{
 const host=document.createElement('div');document.body.append(host)
 let fullscreen:Element|null=host
 const original=Object.getOwnPropertyDescriptor(document,'fullscreenElement')
 Object.defineProperty(document,'fullscreenElement',{configurable:true,get:()=>fullscreen})
 const send=vi.fn()
 const view=render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[]} sources={[]} send={send} onClose={vi.fn()} onSaved={vi.fn()}/>)
 try{
  expect(host.contains(screen.getByRole('dialog'))).toBe(true)
  fireEvent.click(screen.getByRole('button',{name:'移除 门'}));fireEvent.click(screen.getByRole('button',{name:'确认移除热区'}))
  act(()=>{fullscreen=null;document.dispatchEvent(new Event('fullscreenchange'))})
  expect(host.contains(screen.getByRole('dialog'))).toBe(false)
  expect(screen.getByRole('dialog')).toHaveFocus()
  expect(screen.queryByRole('button',{name:'编辑 门'})).not.toBeInTheDocument()
  expect(screen.getByRole('button',{name:'保存布防'})).toBeEnabled()
  expect(send).not.toHaveBeenCalled()
 }finally{view.unmount();if(original)Object.defineProperty(document,'fullscreenElement',original);else Reflect.deleteProperty(document,'fullscreenElement');host.remove()}
})
it('cancel discards the local zone removal without any write',()=>{
 const send=vi.fn(),close=vi.fn()
 render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[]} sources={[]} send={send} onClose={close} onSaved={vi.fn()}/> )
 fireEvent.click(screen.getByRole('button',{name:'移除 门'}));fireEvent.click(screen.getByRole('button',{name:'确认移除热区'}))
 expect(send).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(close).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'放弃布防修改'}));expect(close).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled()
})
it('uncertain save locks draft and retries exact operation; pending application stays pending',async()=>{
 const send=vi.fn().mockRejectedValueOnce(Error('timeout')).mockResolvedValueOnce({saved:true,sourceId:'cam',revision:2,application:{state:'pending'}}),saved=vi.fn()
 render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[]} sources={[]} send={send} onClose={vi.fn()} onSaved={saved}/> )
 fireEvent.click(screen.getByRole('button',{name:'移除 门'}));fireEvent.click(screen.getByRole('button',{name:'确认移除热区'}));fireEvent.click(screen.getByRole('button',{name:'保存布防'}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'重试确认保存'})).toBeEnabled())
 expect(screen.getByRole('button',{name:'取消'})).toBeDisabled()
 expect(screen.getByRole('button',{name:'新增热区'})).toBeDisabled()
 fireEvent.click(screen.getByRole('button',{name:'重试确认保存'}))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);expect(send.mock.calls[0]![0]).toMatchObject({zones:[],expectedRevision:1})
 expect(saved).toHaveBeenCalledWith(expect.objectContaining({application:{state:'pending'}}))
})
it('undo restores removed zone before a save and does not call backend',()=>{
 const send=vi.fn()
 render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[]} sources={[]} send={send} onClose={vi.fn()} onSaved={vi.fn()}/> )
 fireEvent.click(screen.getByRole('button',{name:'移除 门'}));fireEvent.click(screen.getByRole('button',{name:'确认移除热区'}));fireEvent.click(screen.getByRole('button',{name:'撤销布防修改'}))
 expect(screen.getByRole('button',{name:'编辑 门'})).toBeInTheDocument()
 expect(screen.getByRole('button',{name:'保存布防'})).toBeDisabled();expect(send).not.toHaveBeenCalled()
})

it('closing an inner editor restores focus inside arming instead of the page background',()=>{
 render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[]} sources={[]} onClose={vi.fn()} onSaved={vi.fn()}/> )
 fireEvent.click(screen.getByRole('button',{name:'整个画面选用触发器'}))
 const cancel=screen.getByRole('button',{name:'取消选用修改'})
 cancel.focus();fireEvent.click(cancel)
 expect(screen.getByRole('dialog')).toHaveFocus()
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Tab',shiftKey:true})
 expect(screen.getByRole('button',{name:'取消'})).toHaveFocus()
})
it('picture selection is keyboard accessible and removal requires confirmation',()=>{
 const send=vi.fn(),close=vi.fn()
 render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[]} sources={[]} send={send} onClose={close} onSaved={vi.fn()}/> )
 const zone=screen.getByRole('button',{name:'选择热区 门'})
 fireEvent.keyDown(zone,{key:'Enter'});expect(zone).toHaveAttribute('aria-pressed','true')
 fireEvent.click(screen.getByRole('button',{name:'移除 门'}))
 expect(screen.getByRole('alertdialog',{name:'确认移除热区'})).toHaveFocus()
 expect(screen.getByRole('button',{name:'保存布防'})).toBeDisabled()
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'})
 expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
 expect(screen.getByRole('dialog')).toHaveFocus()
 expect(screen.getByRole('button',{name:'编辑 门'})).toBeInTheDocument()
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(close).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled()
})


it('Tab stays in the removal confirmation instead of returning to the draft',()=>{
 render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[]} sources={[]} onClose={vi.fn()} onSaved={vi.fn()}/>)
 fireEvent.click(screen.getByRole('button',{name:'移除 门'}))
 const root=screen.getByRole('dialog'),panel=screen.getByRole('alertdialog',{name:'确认移除热区'})
 const keep=screen.getByRole('button',{name:'保留热区'}),remove=screen.getByRole('button',{name:'确认移除热区'})
 expect(panel).toHaveFocus()
 fireEvent.keyDown(panel,{key:'Tab',shiftKey:true});expect(remove).toHaveFocus()
 fireEvent.keyDown(remove,{key:'Tab'});expect(keep).toHaveFocus()
 fireEvent.keyDown(keep,{key:'Tab',shiftKey:true});expect(remove).toHaveFocus()
 fireEvent.keyDown(root,{key:'Escape'});expect(root).toHaveFocus()
})
