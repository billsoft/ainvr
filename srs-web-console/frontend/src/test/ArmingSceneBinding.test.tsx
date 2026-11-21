import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {ArmingModal} from '@/pages/AlarmCenter/ArmingModal'
import {buildArmingRequest,readArmingSnapshot,type ArmingDocument} from '@/features/armingDocument'
import {sceneEditorDocument,withSceneEdits,type SceneEditingContext} from '@/features/armingSceneDraft'
vi.mock('@/components/PtzProtectionNotice',()=>({PtzProtectionNotice:()=>null}))
const base:ArmingDocument={source_id:'cam',geometry_revision:'g',revision:1,zones:[{
 zone_id:'z',channel_id:'cam',geometry_revision:'g',version:1,state:'active',name:'门',
 points:[[.1,.1],[.5,.1],[.5,.5]],edge_ids:['a','b','c']}],assignments:[]}
const reference={url:'blob:frozen',width:1000,height:500,geometryRevision:'g',capturedAt:'now'}
const frame:SceneEditingContext={processorId:'ai',frame:{frame_id:'frame-1',image_url:'/api/frame',width:1000,height:500,
 captured_at:'now',geometry_revision:'g',identity:'camera',epoch:'epoch-1',items:[],binding_mode:'preset',preset_id:'32',preset_name:'入口',preset_fingerprint:'preset-rev'}}
function bound(matched=true):SceneEditingContext {
 return {...frame,frame:{...frame.frame,items:[{zone_id:'z',processor_id:'ai',revision:4,reference_points:base.zones[0]!.points,
  current_points:matched?[[.2,.2],[.6,.2],[.6,.6]]:null,state:matched?'matched':'unmatched',reference_frame_id:'reference-0',binding_mode:'preset',preset_id:'32'}]}}
}
const result={saved:true,sourceId:'cam',revision:2,application:{state:'pending'}}
function mount(context:SceneEditingContext|undefined=frame,send=vi.fn().mockResolvedValue(result)) {
 const saved=vi.fn(),close=vi.fn()
 const props={sourceId:'cam',sourceName:'门',base,reference,sceneContext:context,definitions:[],sources:[],send,onSaved:saved,onClose:close}
 const ui=render(<ArmingModal {...props}/>);return{ui,props,send,saved,close}
}
afterEach(()=>{cleanup();vi.restoreAllMocks()})
it('opts in one zone explicitly and sends a frozen scene CAS only on Save',async()=>{
 const f=mount();fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}))
 const check=screen.getByRole('checkbox',{name:'仅在此预置位布防'});expect(check).not.toBeChecked()
 fireEvent.click(check);expect(f.send).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}))
 await waitFor(()=>expect(f.saved).toHaveBeenCalledOnce())
 expect(f.send.mock.calls[0]![0]).toMatchObject({expectedRevision:1,sceneEdits:[{zone_id:'z',expected_revision:0,mode:'bind',frame_id:'frame-1'}]})
})
it('does not offer scene binding for entire-frame arming or accept a not-yet-saved polygon',()=>{
 const empty:ArmingDocument={...base,zones:[]}
 render(<ArmingModal sourceId="cam" sourceName="empty" base={empty} reference={reference} sceneContext={frame} definitions={[]} sources={[]} onSaved={vi.fn()} onClose={vi.fn()}/>)
 expect(screen.queryByRole('checkbox',{name:'仅在此预置位布防'})).not.toBeInTheDocument()
 const request=buildArmingRequest(readArmingSnapshot('cam','g',base),null)
 expect(withSceneEdits(request,null,frame,{z:'bind'}).sceneEdits?.[0]).toMatchObject({binding_mode:'preset',mode:'bind'})
 expect(()=>withSceneEdits(request,null,{...frame,frame:{...frame.frame,binding_mode:undefined}},{z:'bind'})).toThrow('请先保存新热区')
})
it('undo and cancel preserve opt-in as a local draft without any write',()=>{
 const f=mount();fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}))
 fireEvent.click(screen.getByRole('checkbox',{name:'仅在此预置位布防'}))
 fireEvent.click(screen.getByRole('button',{name:'撤销布防修改'}))
 expect(screen.getByRole('checkbox',{name:'仅在此预置位布防'})).not.toBeChecked()
 fireEvent.click(screen.getByRole('checkbox',{name:'仅在此预置位布防'}));fireEvent.click(screen.getByRole('button',{name:'取消'}))
 expect(screen.getByRole('alertdialog',{name:'放弃布防修改'})).toBeInTheDocument();expect(f.close).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));expect(screen.getByRole('checkbox')).toBeChecked();expect(f.send).not.toHaveBeenCalled()
})
it('retains all draft edits and the original frozen epoch after a conflict and parent rerender',async()=>{
 const conflict=Object.assign(new Error('scene epoch changed'),{status:409})
 const f=mount(frame,vi.fn().mockRejectedValue(conflict))
 fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}));fireEvent.click(screen.getByRole('checkbox',{name:'仅在此预置位布防'}))
 fireEvent.change(screen.getByLabelText('热区名称'),{target:{value:'办公室'}});fireEvent.blur(screen.getByLabelText('热区名称'))
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}));await screen.findByText(/全部草稿已保留/)
 expect(screen.getByRole('checkbox')).toBeChecked();expect(screen.getByLabelText('热区名称')).toHaveValue('办公室')
 f.ui.rerender(<ArmingModal {...f.props} sceneContext={{...frame,frame:{...frame.frame,frame_id:'new-frame',epoch:'new-epoch'}}} reference={{...reference,url:'blob:new'}}/>)
 expect(screen.getByAltText('布防参考画面')).toHaveAttribute('src','blob:frozen')
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}));await waitFor(()=>expect(f.send).toHaveBeenCalledTimes(2))
 expect(f.send.mock.calls[1]![0].sceneEdits[0].frame_id).toBe('frame-1')
 expect(f.close).not.toHaveBeenCalled();expect(f.saved).not.toHaveBeenCalled()
})
it('keeps fixed-camera editing unchanged with no binding controls or scene fields',async()=>{
 const f=mount(undefined)
 // Default parameter is deliberately avoided to represent the fixed-camera path.
 f.ui.rerender(<ArmingModal {...f.props} sceneContext={undefined}/>)
 // Mount a genuinely independent fixed editor (frozen PTZ context cannot switch).
 f.ui.unmount()
 const send=vi.fn().mockResolvedValue(result)
 render(<ArmingModal {...f.props} sceneContext={undefined} send={send}/>)
 fireEvent.click(screen.getByRole('button',{name:'选择热区 门'}));expect(screen.queryByRole('checkbox',{name:'仅在此预置位布防'})).not.toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('热区名称'),{target:{value:'固定区域'}});fireEvent.blur(screen.getByLabelText('热区名称'))
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}));await waitFor(()=>expect(send).toHaveBeenCalledOnce())
 expect(send.mock.calls[0]![0]).not.toHaveProperty('sceneEdits')
})
it('hides unmatched canonical geometry and requires explicit redraw instead of a misleading projection',()=>{
 mount(bound(false))
 expect(screen.queryByRole('button',{name:'选择热区 门'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'门'}))
 expect(screen.getByRole('checkbox',{name:'仅在此预置位布防'})).toBeDisabled()
 expect(screen.getByRole('button',{name:'重新绘制并绑定此预置位'})).toBeEnabled()
})
it.each(['pending','matched'] as const)('hides %s with null points, preserves canonical base and refuses implicit editing',state=>{
 const context=bound(false);context.frame.items[0]!.state=state
 const original=structuredClone(base)
 mount(context)
 expect(screen.queryByRole('button',{name:'选择热区 门'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'门'}))
 expect(screen.getByRole('checkbox',{name:'仅在此预置位布防'})).toBeDisabled()
 expect(screen.getByRole('button',{name:'重新绘制并绑定此预置位'})).toBeEnabled()
 const snapshot=readArmingSnapshot('cam','g',sceneEditorDocument(base,context))
 expect(withSceneEdits(buildArmingRequest(snapshot,base),base,context,{}).zones[0]).toMatchObject({points:original.zones[0]!.points,version:1})
 snapshot.zones[0]!.points=[[.3,.3],[.7,.3],[.7,.7]]
 expect(()=>withSceneEdits(buildArmingRequest(snapshot,base),base,context,{})).toThrow('场景尚未匹配')
 expect(base).toEqual(original)
})
it('does not promote runtime projections to new canonical reference points',()=>{
 const context=bound(),view=sceneEditorDocument(base,context)!
 const snapshot=readArmingSnapshot('cam','g',view);snapshot.zones[0]!.name='改名'
 const request=withSceneEdits(buildArmingRequest(snapshot,base),base,context,{})
 expect(request.zones[0]).toMatchObject({points:base.zones[0]!.points,name:'改名',version:2})
 expect(request.sceneEdits).toBeUndefined();expect(base.zones[0]!.name).toBe('门')
 snapshot.zones[0]!.points=[[.3,.3],[.7,.3],[.7,.7]]
 const edited=withSceneEdits(buildArmingRequest(snapshot,base),base,context,{})
 expect(edited.sceneEdits).toEqual([{zone_id:'z',expected_revision:4,mode:'edit',frame_id:'frame-1',binding_mode:'preset'}])
 expect(edited.zones[0]).toMatchObject({points:snapshot.zones[0]!.points})
})
it('uses current frozen screen points for explicit unbind and rejects absent projection',()=>{
 const context=bound(),snapshot=readArmingSnapshot('cam','g',sceneEditorDocument(base,context))
 const request=withSceneEdits(buildArmingRequest(snapshot,base),base,context,{z:'unbind'})
 expect(request.sceneEdits?.[0]).toMatchObject({mode:'unbind',expected_revision:4,frame_id:'frame-1'})
 expect(request.zones[0]).toMatchObject({points:context.frame.items[0]!.current_points})
 expect(()=>withSceneEdits(buildArmingRequest(readArmingSnapshot('cam','g',base),base),base,bound(false),{z:'unbind'})).toThrow('当前场景未匹配')
})
