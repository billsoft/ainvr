import {PtzProtectionNotice} from '@/components/PtzProtectionNotice'
import {ZoneHandles} from './ZoneHandles'
import {ZoneDrawing} from './ZoneDrawing'
import {zoneGeometryError,type ZonePoint} from '@/features/alarmGeometry'
import {ApproachBand} from './ApproachBand'
import {SquarePlus,Trash2,RectangleHorizontal,Pentagon,MousePointerClick,Globe,Undo2,Redo2,Save,X,ArrowLeft,RefreshCw} from 'lucide-react'
import {ToolButton,ToolSelect,ToolDivider} from './ToolButton'
import {ArmingMarkers,ArmingSelection} from './ArmingMarkers'
import type {MarkerTarget} from '@/features/armingMarkerLayout'
import {CounterBindingEditor} from './CounterBindingEditor'
import {previewDirection,pickFrom,tapEdge,type CountingPick} from '@/features/countingSelection'
import type {WorkspaceDraft} from './workspaceDraft'
import {flowService} from '@/api/flowService'
import {alarmDefinitionService} from '@/api/alarmDefinitionService'
import {countingDrawing,countingArrows,arrowHead,countingColors} from '@/features/counterGeometry'
import type {Counter} from '@/api/flowService'
import {ZoneEdgeLabels} from './ZoneEdgeLabels'
import {erpDisplayPolygons} from '@/features/erpGeometry'
import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import type {AlarmSource} from '@/api/alarmTriggerService'
import type {AlarmZone} from '@/api/alarmZoneService'
import {newAlarmOperationId} from '@/api/alarmZoneService'
import {alarmArmingService} from '@/api/alarmArmingService'
import {createArmingSaveSession,type ArmingSaveResult} from '@/features/armingSaveSession'
import {readArmingSnapshot,buildArmingRequest,resetArmingForGeometry,type ArmingDocument} from '@/features/armingDocument'
import {edgeIdsAfterEdit,createArmingDraft,type DraftAssignment,type DraftCounterBinding} from '@/features/armingDraft'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
import {ZoneEditor,type ZoneDraft} from './ZoneEditor'
import {AssignmentPicker} from './AssignmentPicker'
import {AssignmentEditor} from './AssignmentEditor'
import {FitFrame} from './FitFrame'
/** Selection key of the whole picture, which carries triggers that need no zone. */
const FRAME='*'
import {useFullscreenPortalHost} from '@/hooks/useFullscreenPortalHost'
interface Props {
 sourceId:string;sourceName:string;base:ArmingDocument|null;legacyZones?:AlarmZone[];warning?:string;resetGeometry?:boolean;resetLegacyGeometry?:boolean;
 reference:{url:string;width:number;height:number;geometryRevision:string;capturedAt:string};
 definitions:TriggerDefinition[];sources:AlarmSource[];counters?:Counter[];
 /** The source feeds an AI processor configured for 360° panorama pictures. */
 panoramic?:boolean
 onClose:()=>void;onSaved:(result:ArmingSaveResult)=>void;
 send?:typeof alarmArmingService.save
}
export function ArmingModal({sourceId,sourceName,base,reference,definitions:initialDefinitions,sources,counters:initialCounters=[],onClose,onSaved,send=alarmArmingService.save,legacyZones=[],warning,resetGeometry=false,resetLegacyGeometry=false,panoramic=false}:Props){
 const portalHost=useFullscreenPortalHost()
 const replacingGeometry=resetGeometry||resetLegacyGeometry
 const [draft]=useState(()=>{
  const snapshot=resetGeometry&&base?resetArmingForGeometry(sourceId,reference.geometryRevision,base):readArmingSnapshot(sourceId,reference.geometryRevision,base)
  // A panoramic source starts wrap-around; existing planar zones keep their meaning.
  if(panoramic&&!snapshot.coordinateSpace&&!snapshot.zones.length)snapshot.coordinateSpace='erp'
  const value=createArmingDraft(snapshot)
  if(!base)for(const zone of legacyZones){
   if(zone.channel_id!==sourceId||zone.geometry_revision!==reference.geometryRevision)throw Error('历史热区来源不匹配')
   value.addZone({id:zone.zone_id,name:zone.name,points:zone.points,edgeIds:zone.points.map((_,i)=>`edge-${i}`),version:0})
  }
  return value
 })
 const [counters,setCounters]=useState(initialCounters),[definitions,setDefinitions]=useState(initialDefinitions),[refreshing,setRefreshing]=useState(false)
 const editor=useRef<WorkspaceDraft|null>(null)
 const [toolbarHost,setToolbarHost]=useState<HTMLDivElement|null>(null)
 const [localDiscard,setLocalDiscard]=useState(false)
 const [counting,setCounting]=useState<{zoneId:string;initial?:DraftCounterBinding}|null>(null),[pick,setPick]=useState<CountingPick|null>(null)
 const [session]=useState(()=>createArmingSaveSession(send,newAlarmOperationId))
 const [,refresh]=useState(0),[editZone,setEditZone]=useState<string|null>(null)
 const [select,setSelect]=useState<{zoneId:string|null;initial?:DraftAssignment}|null>(null)
 const [activeZone,setActiveZone]=useState<string|null>(null),[removeZone,setRemoveZone]=useState<string|null>(null)
 const [approach,setApproach]=useState<{id:string;value:number}|null>(null),[approachEdit,setApproachEdit]=useState<{id:string;value:number;revision:number}>()
 const [highlight,setHighlight]=useState<{entry:string[];exit:string[]}>({entry:[],exit:[]})
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[discard,setDiscard]=useState(false)
 const confirmation=useRef<HTMLElement>(null)
 const labels=useRef<Record<string,string>>({}),dialog=useRef<HTMLDivElement>(null)
 const [frameReady,setFrameReady]=useState(false)
 useEffect(()=>setFrameReady(false),[reference.url,reference.width,reference.height])
 const frame=useRef<HTMLDivElement>(null)
 const [drawing,setDrawing]=useState<'rectangle'|'polygon'|null>(null),[drawingPoints,setDrawingPoints]=useState<ZonePoint[]>([])
 const [zonePreview,setZonePreview]=useState<{id:string;points:ZonePoint[]}|null>(null)
 const [nameDraft,setNameDraft]=useState<{id:string;value:string}|null>(null)
 const current=draft.read(),locked=busy||session.hasPending()
 if(zonePreview){const z=current.zones.find(z=>z.id===zonePreview.id);if(z)z.points=zonePreview.points}
 const flushName=()=>{if(!nameDraft)return true;try{draft.renameZone(nameDraft.id,nameDraft.value);setNameDraft(null);refresh(n=>n+1);setError('');return true}catch(e){setError((e as Error).message);return false}}
 const nameDirty=()=>!!nameDraft&&nameDraft.value!==draft.read().zones.find(z=>z.id===nameDraft.id)?.name
 const reshape=(id:string,points:ZonePoint[])=>{const z=draft.read().zones.find(z=>z.id===id);if(!z)return;try{draft.replaceZone({...z,points,edgeIds:edgeIdsAfterEdit(z.points,z.edgeIds,points,false,newAlarmOperationId)});changed()}catch(e){setError((e as Error).message)}}
 const cancelDrawing=()=>{setDrawing(null);setDrawingPoints([]);setError('')}
 const finishDrawing=(points:ZonePoint[])=>{const problem=zoneGeometryError(points,current.coordinateSpace==='erp');if(problem){setError(problem);return}const id=newAlarmOperationId();draft.addZone({id,name:newZoneName(),points,erpWrap:current.coordinateSpace==='erp',edgeIds:points.map(()=>newAlarmOperationId()),version:0});cancelDrawing();setActiveZone(id);changed()}
 const startDrawing=(mode:'rectangle'|'polygon')=>{if(!leaveEditor())return;setDrawing(mode);setDrawingPoints([]);setActiveZone(null)}
 const labelKey=(a:DraftAssignment)=>JSON.stringify([a.id,a.triggerId,a.processorId])
 const bindingLabels=useRef<Record<string,string>>({})
 const startCounting=(zoneId:string,initial?:DraftCounterBinding)=>{if(counting?.zoneId===zoneId&&counting.initial?.id===initial?.id)return;if(!leaveEditor())return;setActiveZone(zoneId);setCounting({zoneId,initial});const c=initial&&counters.find(x=>x.counter_id===initial.counterId);setPick(c?pickFrom(c.method,initial.needsConfirmation?undefined:initial.direction):null)}
 const stopCounting=()=>{setCounting(null);setPick(null)}
 const changed=()=>{refresh(n=>n+1);setError('')}
 const clearEditor=()=>{setApproach(null);setApproachEdit(undefined);editor.current=null;setEditZone(null);setSelect(null);stopCounting();setHighlight({entry:[],exit:[]});setError('');dialog.current?.focus()}
 const discardEditor=()=>{if(locked)return;if(editor.current?.dirty())setLocalDiscard(true);else clearEditor()}
 const leaveEditor=(offerDiscard=true)=>{
  if(locked||!flushName())return false
  try{
   if(editor.current?.dirty()&&!editor.current.flush()){if(offerDiscard)setLocalDiscard(true);return false}
   clearEditor();return true
  }catch(e){setError(e instanceof Error?e.message:'请检查当前设置');if(offerDiscard)setLocalDiscard(true);return false}
 }
 const chooseTarget=(id:string|null)=>{if(drawing){setError('请先完成绘制或取消绘制。');return}if(leaveEditor())setActiveZone(id)}
 const refreshLibraries=async()=>{if(refreshing||locked)return;setRefreshing(true);try{const [a,b]=await Promise.all([alarmDefinitionService.list(),flowService.list()]);setDefinitions(a.items);setCounters(b.items)}catch(e){setError(e instanceof Error?e.message:'读取关联库失败')}finally{setRefreshing(false)}}

 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow
  document.body.style.overflow='hidden';dialog.current?.focus()
  return()=>{document.body.style.overflow=overflow;previous?.focus()}
 },[])
 useEffect(()=>{
  // Portal moves and removed editor controls can leave focus on the page body.
  // Keep an existing editor focus, otherwise return keyboard use to this dialog.
  if(removeZone||discard||localDiscard){confirmation.current?.focus();return}
  if(dialog.current&&!dialog.current.contains(document.activeElement))dialog.current.focus()
 },[portalHost,editZone,select,counting,removeZone,discard,localDiscard])
 // One cancel leaves the whole arming, whatever is open inside; one confirmation if anything would be lost.
 const close=()=>{if(locked)return;if(draft.dirty()||replacingGeometry||editor.current?.dirty()||nameDirty()||drawingPoints.length)setDiscard(true);else onClose()}
 const save=async()=>{
  if(busy)return
  if(reference.geometryRevision!==draft.read().geometryRevision){setError('来源画面已改变，请重新打开布防确认区域。');return}
  if(drawing){setError('请先完成绘制或取消绘制，再保存布防。');return}
  if(!session.hasPending()&&!leaveEditor(false))return
  if(!session.hasPending()&&!replacingGeometry&&!draft.dirty())return
  const snapshot=draft.read()
  if(!session.hasPending()&&(snapshot.assignments.some(a=>a.needsDirectionConfirmation)||snapshot.counterBindings.some(b=>b.needsConfirmation))){setError('请先处理标记为需重新确认的方向或计数线。');return}
  setBusy(true);setError('')
  try{
   const result=session.hasPending()?await session.retry():await session.save(buildArmingRequest(draft.read(),base,{...Object.fromEntries(draft.read().assignments.flatMap(a=>labels.current[labelKey(a)]?[[a.id,labels.current[labelKey(a)]!]]:[])),...bindingLabels.current},resetGeometry))
   onSaved(result)
  }catch(e){setError(e instanceof Error?e.message:'保存结果未确认，请保留草稿后重试')}
  finally{setBusy(false)}
 }
 const editing=editZone?current.zones.find(z=>z.id===editZone):undefined
 const selectedZone=select?.zoneId?current.zones.find(z=>z.id===select.zoneId):null
 const triggerName=(id:string)=>definitions.find(t=>t.trigger_id===id)?.name??'触发器'
 const processorName=(id:string)=>sources.find(s=>s.channel_id===id)?.channel_name??'AI 处理器'
 const zoneName=(id:string|null)=>current.zones.find(z=>z.id===id)?.name??'整个画面'
 const counterOf=(id:string)=>counters.find(c=>c.counter_id===id)
 const countingZone=counting?current.zones.find(z=>z.id===counting.zoneId):undefined
 const pickDrawing=countingZone&&pick?previewDirection(pick):null
 const busyPanel=!!select||!!counting
 const unsetCounting=current.counterBindings.filter(b=>b.needsConfirmation).length
 const drawCounting=(key:string,direction:Parameters<typeof countingDrawing>[0],zone:{points:[number,number][];edgeIds:string[]},faint=false)=>{
  const d=countingDrawing(direction,zone.points,zone.edgeIds,reference.width,reference.height),W=reference.width,H=reference.height

  return <g key={key} className="pointer-events-none" opacity={faint?.85:1}>
   {d.edges.map((e,i)=><line key={i} x1={e.p[0]*W} y1={e.p[1]*H} x2={e.q[0]*W} y2={e.q[1]*H} stroke={countingColors[e.role]} strokeWidth="5" vectorEffect="non-scaling-stroke"/>)}
   {countingArrows(d).map((arrow,i)=>{const from:[number,number]=[arrow.from[0]*W,arrow.from[1]*H],to:[number,number]=[arrow.to[0]*W,arrow.to[1]*H],color=arrow.role?countingColors[arrow.role]:countingColors.arrow,head=arrowHead(from,to,Math.min(Math.min(W,H)*.025,Math.hypot(to[0]-from[0],to[1]-from[1])*.4));return <g key={i}><line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke={countingColors.outline} strokeWidth="7" strokeLinecap="round" vectorEffect="non-scaling-stroke"/><line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke={color} strokeWidth="3.5" strokeLinecap="round" vectorEffect="non-scaling-stroke"/><polygon points={head.map(p=>p.join(',')).join(' ')} fill={color} stroke={countingColors.outline} strokeWidth="1.5"/></g>})}
  </g>
 }
 const commitZone=(value:ZoneDraft)=>{
  if(editing){setActiveZone(editing.id);draft.replaceZone({...editing,name:value.name,points:value.points,erpWrap:value.erpWrap,edgeIds:edgeIdsAfterEdit(editing.points,editing.edgeIds,value.points,!!value.redrawn,newAlarmOperationId)})}
  else{const id=newAlarmOperationId();draft.addZone({id,name:value.name,points:value.points,erpWrap:value.erpWrap,edgeIds:value.points.map(()=>newAlarmOperationId()),version:0});setActiveZone(id)}
  changed()
 }
 const showSpace=panoramic||current.coordinateSpace==='erp'
 const openTrigger=(a:DraftAssignment)=>{if(select?.initial?.id===a.id)return;if(!leaveEditor())return;setApproach(null);setApproachEdit(undefined);setActiveZone(a.zoneId??FRAME);setHighlight({entry:a.entryEdges,exit:a.exitEdges});setSelect({zoneId:a.zoneId,initial:a})}
 const targets:MarkerTarget[]=[
  {id:FRAME,name:'整个画面',frame:true,counters:[],triggers:current.assignments.filter(a=>!a.zoneId).map(a=>({id:a.id,name:triggerName(a.triggerId),label:`调整 ${triggerName(a.triggerId)} · 整个画面`,muted:definitions.find(t=>t.trigger_id===a.triggerId)?.state!=='enabled'}))},
  ...current.zones.map(z=>({id:z.id,name:z.name,points:z.points,erpWrap:z.erpWrap,noCounting:z.erpWrap?'全景环绕区域暂不支持计数':'',
   triggers:current.assignments.filter(a=>a.zoneId===z.id).map(a=>({id:a.id,name:triggerName(a.triggerId),label:`调整 ${triggerName(a.triggerId)} · ${z.name}`,warn:a.needsDirectionConfirmation,muted:definitions.find(t=>t.trigger_id===a.triggerId)?.state!=='enabled'})),
   counters:current.counterBindings.filter(b=>b.zoneId===z.id).map(b=>{const c=counterOf(b.counterId);return {id:b.id,name:`${c?.name??'计数器'}${b.needsConfirmation?' · 需重新设置计数线':c?.state==='paused'?' · 已暂停':''}`,label:`调整计数线 ${c?.name??'计数器'} · ${z.name}`,warn:b.needsConfirmation,muted:c?.state==='paused'}})})),
 ]
 const newZoneName=()=>{let n=current.zones.length+1;while(current.zones.some(z=>z.name===`热区 ${n}`))n++;return `热区 ${n}`}
 const title=<h2 className="hidden lg:block max-w-[12rem] shrink-0 truncate text-base font-semibold text-ink" title={`布防 · ${sourceName}`}>布防 · {sourceName}</h2>
 const selectedTarget=targets.find(t=>t.id===activeZone)
 const hint=drawing?(drawing==='rectangle'?'拖出矩形，松手后即可改名和关联。':'逐点绘制多边形，点“完成绘制”后即可关联。'):counting?(pick?'在画面上点热区的边设置计数线，箭头为“进”的方向。':'先在右侧选用计数器，再在画面上设置计数线。'):select?'直接编辑设置；返回或切换对象会保留有效修改，最后统一保存布防。':activeZone?'直接拖动选中热区；右侧修改名称和关联；所有修改统一保存。':'点画面中的热区或它的标记选中；所有修改在“保存布防”后统一生效。'
 return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4">
  <div role="dialog" aria-modal="true" aria-label={`布防 · ${sourceName}`} tabIndex={-1} ref={dialog} className="alarm-workspace relative flex h-full w-full flex-col overflow-hidden rounded-panel bg-surface shadow-modal outline-none" onKeyDown={e=>{
   if(e.key==='Escape'){
    e.preventDefault();e.stopPropagation()
    // Innermost first: a confirmation, then an open editor, then the whole arming.
    if(removeZone)setRemoveZone(null);else if(discard)setDiscard(false);else if(localDiscard)setLocalDiscard(false);else if(drawing)cancelDrawing();else if(counting||select||editZone)discardEditor();else close()
    return
   }
   if(e.key!=='Tab')return
   const scope=(removeZone||discard||localDiscard)?confirmation.current:dialog.current
   const nodes=Array.from(scope?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')??[])
   const first=nodes[0],last=nodes[nodes.length-1]
   if(e.shiftKey&&(document.activeElement===first||document.activeElement===scope)){e.preventDefault();last?.focus()}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
  }}>
   <div role="toolbar" aria-label={editZone?'热区绘制工具':'布防工具'} className="flex h-16 shrink-0 flex-nowrap items-center gap-2 border-b border-line px-3 py-1">
    <span className={editZone?'hidden xl:contents':'contents'}>{title}</span>
    <div ref={setToolbarHost} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
     {!editZone&&<>
     <ToolDivider/>
     <ToolButton icon={<SquarePlus size={20} aria-hidden="true"/>} label="新增热区" disabled={locked||!frameReady||!!drawing} onClick={()=>startDrawing('rectangle')}/>
     {drawing&&<><ToolButton icon={<RectangleHorizontal size={20}/>} label="矩形" pressed={drawing==='rectangle'} onClick={()=>{setDrawing('rectangle');setDrawingPoints([])}}/><ToolButton icon={<Pentagon size={20}/>} label="多边形" pressed={drawing==='polygon'} onClick={()=>{setDrawing('polygon');setDrawingPoints([])}}/>{drawing==='polygon'&&<button type="button" className="btn-primary shrink-0" onClick={()=>finishDrawing(drawingPoints)}>完成绘制</button>}<button type="button" className="btn-secondary shrink-0" onClick={cancelDrawing}>取消绘制</button></>}
     <ToolButton icon={<Trash2 size={20}/>} label="删除热区" name="删除所选热区" disabled={locked||!!drawing||!activeZone||activeZone===FRAME} onClick={()=>{if(leaveEditor())setRemoveZone(activeZone)}}/>
     <ToolSelect icon={<MousePointerClick size={20} aria-hidden="true"/>} label={activeZone===FRAME?'整个画面':current.zones.find(z=>z.id===activeZone)?.name??'选择热区'} name="选择热区" disabled={locked||!!drawing} value={activeZone??''} onChange={v=>chooseTarget(v||null)}>
      <option value="">不选中</option><option value={FRAME}>整个画面</option>{current.zones.map(z=><option key={z.id} value={z.id}>{z.name}</option>)}
     </ToolSelect>
     {!editZone&&<><ToolDivider/>
     <ToolButton icon={<Undo2 size={20} aria-hidden="true"/>} label="撤销" name="撤销布防修改" disabled={locked||!!drawing||!!editZone||!draft.canUndo()} onClick={()=>{if(leaveEditor()){draft.undo();setNameDraft(null);changed()}}}/>
     <ToolButton icon={<Redo2 size={20} aria-hidden="true"/>} label="重做" name="重做布防修改" disabled={locked||!!drawing||!!editZone||!draft.canRedo()} onClick={()=>{if(leaveEditor()){draft.redo();setNameDraft(null);changed()}}}/></>}
     {showSpace&&!editZone&&<><ToolDivider/><ToolSelect icon={<Globe size={20} aria-hidden="true"/>} label={current.coordinateSpace==='erp'?'360° 全景':'普通平面'} name="布防画面类型" disabled={locked||busyPanel||!!editZone||!!drawing} value={current.coordinateSpace??'planar'} onChange={v=>{try{draft.setCoordinateSpace(v as 'planar'|'erp');changed()}catch(err){setError((err as Error).message)}}}><option value="planar">普通平面</option><option value="erp">360° 全景（左右相连）</option></ToolSelect></>}
     </>}
    </div>
    {(draft.dirty()||nameDirty()||replacingGeometry)&&!busy&&<span className="hidden shrink-0 text-xs text-ink-faint lg:inline">有未保存的修改</span>}

    <button type="button" className="btn-secondary shrink-0" disabled={locked||!!removeZone} onClick={editZone?discardEditor:close}>{editZone?'取消本处修改':'取消'}</button>
    {editZone?<button type="button" className="btn-primary shrink-0" disabled={locked} onClick={()=>leaveEditor(false)}>完成编辑</button>:<button type="button" className="btn-primary shrink-0" disabled={busy||!!drawing||!!removeZone||(!replacingGeometry&&!draft.dirty()&&!nameDirty()&&!session.hasPending()&&!editZone&&!busyPanel)} onClick={()=>void save()}><Save size={16} aria-hidden="true"/>{busy?'正在保存…':session.hasPending()?'重试确认保存':'保存布防'}</button>}
    <button type="button" aria-label="关闭" title="取消并关闭" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover" disabled={locked||!!removeZone} onClick={close}><X size={20} aria-hidden="true"/></button>
   </div>
   <PtzProtectionNotice sourceId={sourceId} allowNavigation={false}/>
   {(replacingGeometry||warning)&&<div className="shrink-0 space-y-1 border-b border-line px-4 py-2 text-sm">
    {replacingGeometry&&<p role="alert" className="text-amber-800">正在按当前画面重新布防。保存后以本次热区与选用为准，旧记录保留；取消则保留原配置。</p>}
    {warning&&<p role="status" className="text-ink-subtle">{warning}</p>}
   </div>}
   {editZone?<ZoneEditor referenceZones={current.zones.filter(z=>z.id!==editing?.id)} workspace={editor} onCommit={commitZone} panoramaAllowed={current.coordinateSpace==='erp'} key={editZone} reference={reference} toolbarHost={toolbarHost} defaultName={editZone==='new'?newZoneName():''} initial={editing?{name:editing.name,points:editing.points,geometryRevision:reference.geometryRevision,erpWrap:editing.erpWrap}:undefined} onCancel={()=>leaveEditor()} onEscape={discardEditor}/>:<div className="flex min-h-0 flex-1 portrait:flex-col">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-page p-3">
     <FitFrame frameRef={frame} width={reference.width} height={reference.height}>
      <img src={reference.url} alt="布防参考画面" draggable={false} className="absolute inset-0 h-full w-full" onLoad={e=>{const ok=e.currentTarget.naturalWidth===reference.width&&e.currentTarget.naturalHeight===reference.height;setFrameReady(ok);if(!ok)setError('参考图尺寸不匹配，暂时不能调整形状。')}} onError={()=>{setFrameReady(false);setError('参考画面加载失败，暂时不能调整形状。')}}/>
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${reference.width} ${reference.height}`} preserveAspectRatio="none" onClick={e=>{if(e.target===e.currentTarget&&!locked)chooseTarget(null)}}>
       {current.zones.map(z=><g key={z.id}>
        {erpDisplayPolygons(z.points,z.erpWrap).map((poly,copy)=><polygon key={copy} role="button" aria-label={`选择热区 ${z.name}`} aria-pressed={activeZone===z.id} tabIndex={locked?-1:0}
         onClick={()=>{if(!locked)chooseTarget(z.id)}} onKeyDown={e=>{if((e.key==='Enter'||e.key===' ')&&!locked){e.preventDefault();chooseTarget(z.id)}}}
         points={poly.map(([x,y])=>`${x*reference.width},${y*reference.height}`).join(' ')} fill={activeZone===z.id?'rgba(22,119,255,.32)':'rgba(22,119,255,.12)'} stroke={activeZone===z.id?'#facc15':'#60a5fa'} strokeWidth={activeZone===z.id?3:2} vectorEffect="non-scaling-stroke" className="cursor-pointer"/>)}
        {erpDisplayPolygons(z.points,z.erpWrap).flatMap((poly,copy)=>poly.map((p,i)=>{const q=poly[(i+1)%poly.length]!,id=z.edgeIds[i]!,isEntry=select?.zoneId===z.id&&highlight.entry.includes(id),isExit=select?.zoneId===z.id&&highlight.exit.includes(id);return (isEntry||isExit)?<line key={`${id}:${copy}`} className="pointer-events-none" x1={p[0]*reference.width} y1={p[1]*reference.height} x2={q[0]*reference.width} y2={q[1]*reference.height} stroke={isEntry?'#4ade80':'#fb923c'} strokeWidth="5" vectorEffect="non-scaling-stroke"/>:null}))}
       </g>)}
       {select&&selectedZone&&!selectedZone.erpWrap&&approach&&<ApproachBand points={selectedZone.points} width={reference.width} height={reference.height} percent={approach.value} onChange={value=>{setApproach({...approach,value});setApproachEdit({id:approach.id,value,revision:Date.now()})}}/>}
       {current.counterBindings.filter(b=>b.id!==counting?.initial?.id&&!b.needsConfirmation).flatMap(b=>{const z=current.zones.find(z=>z.id===b.zoneId);return z?[drawCounting(b.id,b.direction,z,true)]:[]})}
       {countingZone&&pickDrawing&&drawCounting('pick',pickDrawing,countingZone)}
       {countingZone&&pick&&!countingZone.erpWrap&&countingZone.points.map((p,i)=>{const q=countingZone.points[(i+1)%countingZone.points.length]!,id=countingZone.edgeIds[i]!;return <line key={`tap-${id}`} role="button" tabIndex={0} aria-label={`设置计数线：边 ${i+1}`} aria-disabled={locked}
        x1={p[0]*reference.width} y1={p[1]*reference.height} x2={q[0]*reference.width} y2={q[1]*reference.height} stroke="transparent" strokeWidth="44" vectorEffect="non-scaling-stroke" className="cursor-pointer outline-none"
        onClick={()=>{if(!locked)setPick(tapEdge(pick,id))}} onKeyDown={e=>{if(!locked&&(e.key==='Enter'||e.key===' ')){e.preventDefault();setPick(tapEdge(pick,id))}}}/>})}
      </svg>
      {current.zones.filter(z=>z.id===(select?.zoneId??counting?.zoneId)).map(z=><ZoneEdgeLabels key={z.id} points={z.points} wrap={z.erpWrap} entry={z.edgeIds.flatMap((id,i)=>highlight.entry.includes(id)&&select?.zoneId===z.id?[i]:[])} exit={z.edgeIds.flatMap((id,i)=>highlight.exit.includes(id)&&select?.zoneId===z.id?[i]:[])}/>)}
      {!drawing&&!busyPanel&&activeZone&&current.zones.filter(z=>z.id===activeZone).map(z=><ZoneHandles key={z.id} zone={z} frame={frame} width={reference.width} height={reference.height} disabled={locked||!frameReady} onPreview={points=>setZonePreview(points?{id:z.id,points}:null)} onChange={points=>reshape(z.id,points)}/>)}
      {drawing&&<ZoneDrawing mode={drawing} points={drawingPoints} frame={frame} width={reference.width} height={reference.height} onPoints={setDrawingPoints} onComplete={finishDrawing}/>}
      {!drawing&&!busyPanel&&<ArmingMarkers targets={targets} selected={activeZone} disabled={locked} onSelect={chooseTarget}
       onGroup={(t,kind)=>{if(!leaveEditor())return;setActiveZone(t.id);const items=kind==='trigger'?t.triggers:t.counters;if(items.length===1){if(kind==='trigger'){const a=current.assignments.find(a=>a.id===items[0]!.id);if(a)openTrigger(a)}else{const b=current.counterBindings.find(b=>b.id===items[0]!.id);if(b)startCounting(t.id,b)}}else if(!items.length){if(kind==='trigger')setSelect({zoneId:t.frame?null:t.id});else if(!t.noCounting)startCounting(t.id)}}}/> }
     </FitFrame>
    </div>
    {(busyPanel||selectedTarget)&&<aside aria-label="编辑窗" className="flex w-[340px] max-w-[38%] shrink-0 flex-col gap-3 overflow-hidden border-l border-line p-4 portrait:max-h-[46%] portrait:w-full portrait:max-w-none portrait:border-l-0 portrait:border-t [&>div>fieldset>section]:rounded-none [&>div>fieldset>section]:border-0 [&>div>fieldset>section]:p-0">
     <div className="flex items-center justify-between gap-2 border-b border-line pb-2">
      <button type="button" className="btn-secondary min-h-11" disabled={locked} onClick={()=>{if(leaveEditor()&&!busyPanel)setActiveZone(null)}}><ArrowLeft size={16} aria-hidden="true"/>{busyPanel?'返回关联':'收起面板'}</button>
      <button type="button" className="btn-secondary min-h-11" aria-label="刷新触发器和计数器库" disabled={refreshing||locked} onClick={()=>void refreshLibraries()}><RefreshCw size={16} aria-hidden="true"/>{refreshing?'读取中':'刷新库'}</button>
     </div>
     <div data-scroll-region className="min-h-0 flex-1 space-y-3 overflow-y-auto">
     {!busyPanel&&selectedTarget&&!selectedTarget.frame&&<div className="space-y-2"><label className="block text-xs font-medium text-ink-subtle" htmlFor="arming-zone-name">热区名称</label><input id="arming-zone-name" aria-label="热区名称" maxLength={128} className="form-input w-full" disabled={locked} value={nameDraft?.id===selectedTarget.id?nameDraft.value:selectedTarget.name} onChange={e=>setNameDraft({id:selectedTarget.id,value:e.target.value})} onBlur={flushName}/><p className="text-xs text-ink-faint">拖内部平移；矩形拖旋转柄旋转、角点等比缩放、边中点调整宽高。</p>{selectedTarget.noCounting&&<button className="btn-secondary" type="button" disabled={locked} onClick={()=>{if(leaveEditor())setEditZone(selectedTarget.id)}}>360° 视角调整</button>}</div>}
     {!busyPanel&&selectedTarget&&<ArmingSelection target={selectedTarget} disabled={locked}
       onTrigger={id=>{const a=current.assignments.find(x=>x.id===id);if(a)openTrigger(a)}}
       onCounter={id=>{const b=current.counterBindings.find(x=>x.id===id);if(b)startCounting(b.zoneId,b)}}
       onAddTrigger={()=>{if(!leaveEditor())return;setHighlight({entry:[],exit:[]});setSelect({zoneId:selectedTarget.frame?null:selectedTarget.id})}}
       onAddCounter={()=>startCounting(selectedTarget.id)}/>}
     <fieldset disabled={locked} className="min-w-0 space-y-3">
     {counting&&countingZone?<CounterBindingEditor workspace={editor} key={`${counting.zoneId}:${counting.initial?.id??'new'}`} sourceId={sourceId} geometryRevision={reference.geometryRevision} zone={countingZone} counters={counters} sources={sources}
       used={current.counterBindings.filter(b=>b.zoneId===counting.zoneId&&b.id!==counting.initial?.id).map(b=>b.counterId)} initial={counting.initial} pick={pick} onPick={setPick}
       onRemove={counting.initial?()=>{draft.removeCounterBinding(counting.initial!.id);stopCounting();changed()}:undefined}
       onApply={(binding,labelVersion)=>{draft.putCounterBinding(binding);bindingLabels.current[binding.id]=labelVersion;changed()}}/>:
      select?select.initial?<AssignmentEditor workspace={editor} key={`${select.zoneId}:${select.initial?.id??'new'}`} sourceId={sourceId} geometryRevision={reference.geometryRevision} zone={selectedZone??null} definitions={definitions} sources={sources} initial={select.initial} approachEdit={approachEdit} onApproachChange={setApproach} onDirectionChange={setHighlight}
       onRemove={()=>{draft.removeAssignment(select.initial!.id);setSelect(null);changed()}}
       onApply={(assignment,labelVersion)=>{draft.putAssignment(assignment);labels.current[labelKey(assignment)]=labelVersion;changed()}}/>:
       <AssignmentPicker workspace={editor} sourceId={sourceId} geometryRevision={reference.geometryRevision} zone={selectedZone??null} definitions={definitions} sources={sources} approachEdit={approachEdit} onApproachChange={setApproach} onDirectionChange={setHighlight} onApply={items=>{draft.putAssignments(items.map(i=>i.assignment));for(const item of items)labels.current[labelKey(item.assignment)]=item.labelVersion;changed()}}/>:null}
     </fieldset>
     </div>
     {busyPanel&&<div className="shrink-0 space-y-2 border-t border-line bg-surface pt-3">
      <button type="button" className="btn-primary min-h-11 w-full" disabled={locked} onClick={()=>leaveEditor(false)}>完成关联</button>
      <p className="text-xs leading-5 text-ink-subtle">返回后保留本次关联，最后点击顶部“保存布防”统一生效。</p>
      <button type="button" className="min-h-11 text-sm text-ink-subtle underline hover:text-danger" disabled={locked} onClick={discardEditor}>撤销本处修改</button>
     </div>}
    </aside>}
   </div>}
   {!editZone&&<div className="flex min-h-9 shrink-0 flex-nowrap overflow-x-auto whitespace-nowrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-1.5 text-xs" aria-live="polite">
    <span className="text-ink-faint">{hint}</span>
    {current.coordinateSpace==='erp'&&<span className="text-ink-faint">跨左右接缝时跟踪编号可能改变，请尽量在远离接缝处布防。</span>}
    {unsetCounting>0&&<span role="status" className="font-medium text-amber-700">有 {unsetCounting} 条计数线因热区的边变化需要重新设置，点画面上带 ⚠ 的计数器重新设置后才能保存。</span>}
    {error&&<span role="alert" className="text-sm text-danger">{error}</span>}
    {!busy&&session.hasPending()&&<span role="status" className="text-sm">上次保存结果尚未确认，草稿已锁定。请点“重试确认保存”，避免重复写入。</span>}
   </div>}
   {localDiscard&&<div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 p-4">
    <section ref={confirmation} tabIndex={-1} role="alertdialog" aria-label="放弃本处修改" className="w-full max-w-md space-y-3 rounded-panel bg-surface p-5 shadow-modal">
     <header className="flex items-center justify-between gap-2"><h3 className="text-base font-semibold">放弃当前未保存的设置？</h3><button type="button" aria-label="关闭" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover" onClick={()=>setLocalDiscard(false)}><X size={20} aria-hidden="true"/></button></header><p className="text-sm text-ink-subtle">只撤销当前编辑，其他已暂存的布防修改保留。返回可保留有效草稿；Esc 用于放弃当前编辑。</p>
     <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={()=>setLocalDiscard(false)}>继续编辑</button><button type="button" className="btn-primary" onClick={()=>{setLocalDiscard(false);clearEditor()}}>放弃本处修改</button></div>
    </section>
   </div>}
   {removeZone&&<div className="absolute inset-0 z-10 flex items-center justify-center rounded-panel bg-black/30 p-4">
    <section ref={confirmation} tabIndex={-1} role="alertdialog" aria-label="确认移除热区" className="w-full max-w-md space-y-3 rounded-panel bg-surface p-5 shadow-modal outline-none">
     <header className="flex items-center justify-between gap-2"><h3 className="text-base font-semibold">移除 {zoneName(removeZone)}？</h3><button type="button" aria-label="关闭" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover" onClick={()=>setRemoveZone(null)}><X size={20} aria-hidden="true"/></button></header>
     <p className="text-sm text-ink-subtle">以下选用将一并解除；保存布防后生效，历史记录保留。</p>
     <ul className="list-disc pl-5 text-sm">{current.assignments.filter(a=>a.zoneId===removeZone).map(a=><li key={a.id}>{triggerName(a.triggerId)} · {processorName(a.processorId)}</li>)}
      {current.counterBindings.filter(b=>b.zoneId===removeZone).map(b=><li key={b.id}>计数：{counterOf(b.counterId)?.name??'计数器'}（停止这里的计数，已有统计保留）</li>)}</ul>
     {!current.assignments.some(a=>a.zoneId===removeZone)&&!current.counterBindings.some(b=>b.zoneId===removeZone)&&<p className="text-sm">此热区尚未选用触发器或计数器。</p>}
     <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={()=>setRemoveZone(null)}>保留热区</button><button type="button" className="btn-primary bg-danger hover:bg-danger-700" onClick={()=>{draft.removeZone(removeZone);setRemoveZone(null);setActiveZone(null);changed()}}>确认移除热区</button></div>
    </section>
   </div>}
   {discard&&<div className="absolute inset-0 z-10 flex items-center justify-center rounded-panel bg-black/30 p-4">
    <section ref={confirmation} tabIndex={-1} role="alertdialog" aria-label="放弃布防修改" className="w-full max-w-md space-y-3 rounded-panel bg-surface p-5 shadow-modal outline-none">
     <header className="flex items-center justify-between gap-2"><h3 className="text-base font-semibold">放弃本次布防的修改？</h3><button type="button" aria-label="关闭" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover" onClick={()=>setDiscard(false)}><X size={20} aria-hidden="true"/></button></header>
     <p className="text-sm text-ink-subtle">未保存的热区、触发器和计数器选用都会丢弃，已保存的配置不变。</p>
     <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={()=>setDiscard(false)}>继续编辑</button><button type="button" className="btn-primary bg-danger hover:bg-danger-700" onClick={onClose}>放弃布防修改</button></div>
    </section>
   </div>}
  </div>
 </div>,portalHost)
}
