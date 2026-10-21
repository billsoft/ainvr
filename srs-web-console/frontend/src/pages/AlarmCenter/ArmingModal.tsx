import {Plus,Link2,Undo2,Redo2,Pencil,Trash2,Save,SlidersHorizontal,Unlink,X} from 'lucide-react'
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
import {createArmingDraft,type DraftAssignment} from '@/features/armingDraft'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
import {ZoneEditor} from './ZoneEditor'
import {AssignmentPicker} from './AssignmentPicker'
import {AssignmentEditor} from './AssignmentEditor'
import {FitFrame} from './FitFrame'
import {useFullscreenPortalHost} from '@/hooks/useFullscreenPortalHost'
interface Props {
 sourceId:string;sourceName:string;base:ArmingDocument|null;legacyZones?:AlarmZone[];warning?:string;resetGeometry?:boolean;resetLegacyGeometry?:boolean;
 reference:{url:string;width:number;height:number;geometryRevision:string;capturedAt:string};
 definitions:TriggerDefinition[];sources:AlarmSource[];
 /** The source feeds an AI processor configured for 360° panorama pictures. */
 panoramic?:boolean
 onClose:()=>void;onSaved:(result:ArmingSaveResult)=>void;
 send?:typeof alarmArmingService.save
}
export function ArmingModal({sourceId,sourceName,base,reference,definitions,sources,onClose,onSaved,send=alarmArmingService.save,legacyZones=[],warning,resetGeometry=false,resetLegacyGeometry=false,panoramic=false}:Props){
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
 const [session]=useState(()=>createArmingSaveSession(send,newAlarmOperationId))
 const [,refresh]=useState(0),[editZone,setEditZone]=useState<string|null>(null)
 const [select,setSelect]=useState<{zoneId:string|null;initial?:DraftAssignment}|null>(null)
 const [activeZone,setActiveZone]=useState<string|null>(null),[removeZone,setRemoveZone]=useState<string|null>(null)
 const [highlight,setHighlight]=useState<{entry:string[];exit:string[]}>({entry:[],exit:[]})
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[discard,setDiscard]=useState(false)
 const confirmation=useRef<HTMLElement>(null)
 const labels=useRef<Record<string,string>>({}),dialog=useRef<HTMLDivElement>(null)
 const current=draft.read(),locked=busy||session.hasPending()
 const labelKey=(a:DraftAssignment)=>JSON.stringify([a.id,a.triggerId,a.processorId])
 const changed=()=>{refresh(n=>n+1);setError('')}
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow
  document.body.style.overflow='hidden';dialog.current?.focus()
  return()=>{document.body.style.overflow=overflow;previous?.focus()}
 },[])
 useEffect(()=>{
  // Portal moves and removed editor controls can leave focus on the page body.
  // Keep an existing editor focus, otherwise return keyboard use to this dialog.
  if(removeZone||discard){confirmation.current?.focus();return}
  if(dialog.current&&!dialog.current.contains(document.activeElement))dialog.current.focus()
 },[portalHost,editZone,select,removeZone,discard])
 // One cancel leaves the whole arming, whatever is open inside; one confirmation if anything would be lost.
 const close=()=>{if(locked)return;if(draft.dirty()||replacingGeometry||editZone||select)setDiscard(true);else onClose()}
 const save=async()=>{
  if(busy)return
  setBusy(true);setError('')
  try{
   const result=session.hasPending()?await session.retry():await session.save(buildArmingRequest(draft.read(),base,Object.fromEntries(draft.read().assignments.flatMap(a=>labels.current[labelKey(a)]?[[a.id,labels.current[labelKey(a)]!]]:[])),resetGeometry))
   onSaved(result)
  }catch(e){setError(e instanceof Error?e.message:'保存结果未确认，请保留草稿后重试')}
  finally{setBusy(false)}
 }
 const editing=editZone?current.zones.find(z=>z.id===editZone):undefined
 const selectedZone=select?.zoneId?current.zones.find(z=>z.id===select.zoneId):null
 const triggerName=(id:string)=>definitions.find(t=>t.trigger_id===id)?.name??'触发器'
 const processorName=(id:string)=>sources.find(s=>s.channel_id===id)?.channel_name??'AI 处理器'
 const zoneName=(id:string|null)=>current.zones.find(z=>z.id===id)?.name??'整个画面'
 const showSpace=panoramic||current.coordinateSpace==='erp'
 return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4">
  <div role="dialog" aria-modal="true" aria-label={`布防 · ${sourceName}`} tabIndex={-1} ref={dialog} className="alarm-workspace relative flex h-[96dvh] w-full max-w-[1400px] flex-col rounded-panel bg-surface shadow-modal outline-none" onKeyDown={e=>{
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(removeZone)setRemoveZone(null);else if(discard)setDiscard(false);else close();return}
   if(e.key!=='Tab')return
   const scope=(removeZone||discard)?confirmation.current:dialog.current
   const nodes=Array.from(scope?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')??[])
   const first=nodes[0],last=nodes[nodes.length-1]
   if(e.shiftKey&&(document.activeElement===first||document.activeElement===scope)){e.preventDefault();last?.focus()}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
  }}>
   <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-5 py-3">
    <h2 className="text-base font-semibold text-ink">布防 · {sourceName}</h2>
    <p className="text-sm text-ink-subtle">录像和推理继续运行；所有修改在点击“保存布防”后统一应用。</p>
    {showSpace&&<label className="ml-auto flex items-center gap-2 text-sm text-ink-subtle">画面类型<select aria-label="布防画面类型" className="form-input w-auto py-1.5" disabled={locked||!!editZone||!!select} value={current.coordinateSpace??'planar'} onChange={e=>{try{draft.setCoordinateSpace(e.target.value as 'planar'|'erp');changed()}catch(err){setError((err as Error).message)}}}><option value="planar">普通平面</option><option value="erp">360° 全景（左右相连）</option></select></label>}
   </header>
   <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
    {editZone?<ZoneEditor panoramaAllowed={current.coordinateSpace==='erp'} key={editZone} reference={reference} draftOnly initial={editing?{name:editing.name,points:editing.points,geometryRevision:reference.geometryRevision,erpWrap:editing.erpWrap}:undefined} onCancel={()=>setEditZone(null)} onSave={async value=>{
     if(editing){draft.replaceZone({...editing,name:value.name,points:value.points,erpWrap:value.erpWrap,edgeIds:value.points.length===editing.edgeIds.length?editing.edgeIds:value.points.map(()=>newAlarmOperationId())})}
     else draft.addZone({id:newAlarmOperationId(),name:value.name,points:value.points,erpWrap:value.erpWrap,edgeIds:value.points.map(()=>newAlarmOperationId()),version:0})
     setEditZone(null);changed()
    }}/>:<>
     <div className="flex min-h-[40dvh] min-w-0 flex-1 flex-col gap-3">
      <FitFrame width={reference.width} height={reference.height}>
       <img src={reference.url} alt="布防参考画面" draggable={false} className="absolute inset-0 h-full w-full"/>
       <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${reference.width} ${reference.height}`} preserveAspectRatio="none">
        {current.zones.map(z=><g key={z.id}>
         {erpDisplayPolygons(z.points,z.erpWrap).map((poly,copy)=><polygon key={copy} role="button" aria-label={`选择热区 ${z.name}`} aria-pressed={activeZone===z.id} tabIndex={locked||select?-1:0}
          onClick={()=>{if(!locked&&!select)setActiveZone(z.id)}} onKeyDown={e=>{if((e.key==='Enter'||e.key===' ')&&!locked&&!select){e.preventDefault();setActiveZone(z.id)}}}
          points={poly.map(([x,y])=>`${x*reference.width},${y*reference.height}`).join(' ')} fill={activeZone===z.id?'rgba(22,119,255,.32)':'rgba(22,119,255,.12)'} stroke={activeZone===z.id?'#facc15':'#60a5fa'} strokeWidth={activeZone===z.id?3:2} vectorEffect="non-scaling-stroke" className="cursor-pointer"/>)}
         {erpDisplayPolygons(z.points,z.erpWrap).flatMap((poly,copy)=>poly.map((p,i)=>{const q=poly[(i+1)%poly.length]!,id=z.edgeIds[i]!,isEntry=select?.zoneId===z.id&&highlight.entry.includes(id),isExit=select?.zoneId===z.id&&highlight.exit.includes(id);return <g key={`${id}:${copy}`} className="pointer-events-none">
          {(isEntry||isExit)&&<line x1={p[0]*reference.width} y1={p[1]*reference.height} x2={q[0]*reference.width} y2={q[1]*reference.height} stroke={isEntry?'#4ade80':'#fb923c'} strokeWidth="5" vectorEffect="non-scaling-stroke"/>}

         </g>}))}
        </g>)}
       </svg>
       {current.zones.filter(z=>z.id===(select?.zoneId??activeZone)).map(z=><ZoneEdgeLabels key={z.id} points={z.points} wrap={z.erpWrap} entry={z.edgeIds.flatMap((id,i)=>highlight.entry.includes(id)&&select?.zoneId===z.id?[i]:[])} exit={z.edgeIds.flatMap((id,i)=>highlight.exit.includes(id)&&select?.zoneId===z.id?[i]:[])}/>)}
      </FitFrame>
      <div role="toolbar" aria-label="布防工具" className="flex shrink-0 flex-wrap items-center gap-2">
       <button type="button" className="btn-primary" disabled={locked||!!select} onClick={()=>setEditZone('new')}><Plus size={16} aria-hidden="true"/>新增热区</button>
       <button type="button" className="btn-secondary" disabled={locked||!!select} onClick={()=>{setHighlight({entry:[],exit:[]});setSelect({zoneId:null})}}><Link2 size={16} aria-hidden="true"/>整个画面选用触发器</button>
       <span className="mx-1 h-6 w-px bg-line" aria-hidden="true"/>
       <button type="button" className="btn-secondary" disabled={locked||!!select||!draft.canUndo()} onClick={()=>{draft.undo();changed()}}><Undo2 size={16} aria-hidden="true"/>撤销布防修改</button>
       <button type="button" className="btn-secondary" disabled={locked||!!select||!draft.canRedo()} onClick={()=>{draft.redo();changed()}}><Redo2 size={16} aria-hidden="true"/>重做布防修改</button>
       <span className="ml-auto text-xs text-ink-faint">点画面中的热区选中；重叠时可在右侧列表选择。</span>
      </div>
     </div>
     <aside data-scroll-region aria-label="热区与选用" className="flex min-h-0 shrink-0 basis-[38%] flex-col gap-3 overflow-y-auto lg:basis-auto lg:w-[380px]">
      {replacingGeometry&&<p role="alert" className="rounded-base border border-warning bg-amber-50 p-3 text-sm">正在按当前画面重新布防。保存后以本次热区与选用为准，旧记录保留；取消则保留原配置。</p>}
      {warning&&<p role="status" className="text-sm text-ink-subtle">{warning}</p>}
      {current.coordinateSpace==='erp'&&<p role="status" className="rounded-base bg-surface-page p-3 text-xs text-ink-subtle">跨画面左右接缝时跟踪编号可能改变，穿过计数、持续出现和同目标去重暂不能保证连续，请尽量在远离接缝处布防。</p>}
      {select?select.initial?<AssignmentEditor key={`${select.zoneId}:${select.initial?.id??'new'}`} sourceId={sourceId} geometryRevision={reference.geometryRevision} zone={selectedZone??null} definitions={definitions} sources={sources} initial={select.initial} onDirectionChange={setHighlight} onCancel={()=>setSelect(null)} onApply={(assignment,labelVersion)=>{draft.putAssignment(assignment);labels.current[labelKey(assignment)]=labelVersion;setSelect(null);changed()}}/>:<AssignmentPicker sourceId={sourceId} geometryRevision={reference.geometryRevision} zone={selectedZone??null} definitions={definitions} sources={sources} onDirectionChange={setHighlight} onCancel={()=>setSelect(null)} onApply={items=>{draft.putAssignments(items.map(i=>i.assignment));for(const item of items)labels.current[labelKey(item.assignment)]=item.labelVersion;setSelect(null);changed()}}/>:<>
       <section aria-label="热区列表" className="space-y-2">
        <h3 className="text-sm font-medium text-ink">热区 <span className="text-ink-faint">{current.zones.length}</span></h3>
        {!current.zones.length&&<p className="text-sm text-ink-subtle">尚未绘制热区。只选用“出现”时可以不画热区。</p>}
        {current.zones.map(z=><div key={z.id} className={`ui-panel space-y-2 p-3 ${activeZone===z.id?'border-primary bg-primary-50':''}`}>
         <button type="button" className="flex w-full items-center gap-2 text-left text-sm font-medium text-ink" aria-pressed={activeZone===z.id} onClick={()=>setActiveZone(z.id)}>{z.name}<span className="text-xs font-normal text-ink-faint">{z.erpWrap?'全景环绕':'平面区域'} · 选用 {current.assignments.filter(a=>a.zoneId===z.id).length}</span></button>
         <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary px-3 py-1.5" disabled={locked} onClick={()=>setEditZone(z.id)}><Pencil size={16} aria-hidden="true"/>编辑 {z.name}</button>
          <button type="button" className="btn-secondary px-3 py-1.5" disabled={locked} onClick={()=>{setActiveZone(z.id);setHighlight({entry:[],exit:[]});setSelect({zoneId:z.id})}}><Link2 size={16} aria-hidden="true"/>为 {z.name} 选用触发器</button>
          <button type="button" className="btn-secondary px-3 py-1.5 text-danger" disabled={locked} onClick={()=>setRemoveZone(z.id)}><Trash2 size={16} aria-hidden="true"/>移除 {z.name}</button>
         </div>
        </div>)}
       </section>
       <section aria-label="选用列表" className="space-y-2">
        <h3 className="text-sm font-medium text-ink">已选用触发器 <span className="text-ink-faint">{current.assignments.length}</span></h3>
        {!current.assignments.length&&<p className="text-sm text-ink-subtle">尚未选用。选中热区后点“选用触发器”，或为整个画面选用“出现”。</p>}
        {current.assignments.map(a=><div key={a.id} className="ui-panel flex flex-wrap items-center gap-2 p-3">
         <div className="mr-auto min-w-0 text-sm"><p className="truncate font-medium text-ink">{triggerName(a.triggerId)} · {zoneName(a.zoneId)}</p><p className="truncate text-xs text-ink-subtle">{processorName(a.processorId)}{a.needsDirectionConfirmation?' · 区域已修改，需确认方向':''}</p></div>
         <button type="button" className="btn-secondary px-3 py-1.5" disabled={locked} onClick={()=>{setHighlight({entry:a.entryEdges,exit:a.exitEdges});setSelect({zoneId:a.zoneId,initial:a})}}><SlidersHorizontal size={16} aria-hidden="true"/>调整选用</button>
         <button type="button" className="btn-secondary px-3 py-1.5" disabled={locked} onClick={()=>{draft.removeAssignment(a.id);changed()}}><Unlink size={16} aria-hidden="true"/>移除选用</button>
        </div>)}
       </section>
      </>}
     </aside>
    </>}
   </div>
   {(error||session.hasPending())&&<div className="shrink-0 space-y-1 border-t border-line px-5 py-2 text-sm">{error&&<p role="alert" className="text-danger">{error}</p>}{!busy&&session.hasPending()&&<p role="status">上次保存结果尚未确认，草稿已锁定。请重试确认原操作，避免重复写入。</p>}</div>}
   <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
    {(editZone||select)&&<span className="mr-auto text-xs text-ink-faint">{editZone?'正在编辑热区：完成后加入草稿，或直接取消整个布防。':'正在选用触发器：确认后加入草稿。'}</span>}
    <button type="button" className="btn-secondary" disabled={locked||!!removeZone} onClick={close}><X size={16} aria-hidden="true"/>取消</button>
    <button type="button" className="btn-primary" disabled={busy||!!editZone||!!select||!!removeZone||(!replacingGeometry&&!draft.dirty()&&!session.hasPending())} onClick={()=>void save()}><Save size={16} aria-hidden="true"/>{busy?'正在保存…':session.hasPending()?'重试确认保存':'保存布防'}</button>
   </footer>
   {removeZone&&<div className="absolute inset-0 z-10 flex items-center justify-center rounded-panel bg-black/30 p-4">
    <section ref={confirmation} tabIndex={-1} role="alertdialog" aria-label="确认移除热区" className="w-full max-w-md space-y-3 rounded-panel bg-surface p-5 shadow-modal outline-none">
     <h3 className="text-base font-semibold">移除 {zoneName(removeZone)}？</h3>
     <p className="text-sm text-ink-subtle">以下选用将一并解除；保存布防后生效，历史记录保留。</p>
     <ul className="list-disc pl-5 text-sm">{current.assignments.filter(a=>a.zoneId===removeZone).map(a=><li key={a.id}>{triggerName(a.triggerId)} · {processorName(a.processorId)}</li>)}</ul>
     {!current.assignments.some(a=>a.zoneId===removeZone)&&<p className="text-sm">此热区尚未选用触发器。</p>}
     <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={()=>setRemoveZone(null)}>保留热区</button><button type="button" className="btn-primary bg-danger hover:bg-danger-700" onClick={()=>{draft.removeZone(removeZone);setRemoveZone(null);setActiveZone(null);changed()}}>确认移除热区</button></div>
    </section>
   </div>}
   {discard&&<div className="absolute inset-0 z-10 flex items-center justify-center rounded-panel bg-black/30 p-4">
    <section ref={confirmation} tabIndex={-1} role="alertdialog" aria-label="放弃布防修改" className="w-full max-w-md space-y-3 rounded-panel bg-surface p-5 shadow-modal outline-none">
     <h3 className="text-base font-semibold">放弃本次布防的修改？</h3>
     <p className="text-sm text-ink-subtle">未保存的热区和触发器选用都会丢弃，已保存的配置不变。</p>
     <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={()=>setDiscard(false)}>继续编辑</button><button type="button" className="btn-primary bg-danger hover:bg-danger-700" onClick={onClose}>放弃布防修改</button></div>
    </section>
   </div>}
  </div>
 </div>,portalHost)
}
