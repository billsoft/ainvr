import {useEffect,useRef,useState} from 'react'
import {Link} from 'react-router-dom'
import {Play,X} from 'lucide-react'
import {alarmEventService,type AlarmEvent,type AckDisposition,type AckItem} from '@/api/alarmEventService'
import {behaviorNames,levelLook} from '@/features/alarmTriggers'
import {describeAlarm,stageNote,type AlarmContext} from '@/features/alarmSentences'
import {BehaviorEvidence} from './BehaviorEvidence'
import {EvidenceThumb} from './EvidenceThumb'
import {playbackHref,PLAYBACK_MARGIN_MS} from '@/features/alarmNavigation'

const clock=(v:string)=>new Date(v).toLocaleTimeString('zh-CN',{hour12:false})
export interface PendingAcknowledgement {items:AckItem[];note:string;disposition:AckDisposition;key:string}
interface Props {
 pendingAttempt?:PendingAcknowledgement
 id:string;intent?:AckDisposition;initialStageId?:string;channelName:string;trigger:AlarmContext|undefined;close:()=>void
 confirm:(alarm:AlarmEvent,note:string,disposition:AckDisposition)=>Promise<boolean>
}
// One bounded detail layer for evidence, stages, recording and handling.
export function AlarmSheet({id,intent,pendingAttempt,initialStageId,channelName,trigger,close,confirm}:Props){
 const [snapshot,setSnapshot]=useState<{id:string;value:AlarmEvent}|null>(null),[failedLoad,setFailedLoad]=useState<{id:string;retry:number}|null>(null),[retry,setRetry]=useState(0)
 const [stage,setStage]=useState<string|null>(null),[note,setNote]=useState(pendingAttempt?.note??''),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false)
 const [retryDisposition,setRetryDisposition]=useState<AckDisposition|null>(null)
 const closeRef=useRef<HTMLButtonElement>(null),dialog=useRef<HTMLElement>(null)
 useEffect(()=>{let active=true;void alarmEventService.get(id).then(v=>{if(active){setSnapshot({id,value:v});setStage(v.stages?.find(s=>s.event_id===initialStageId)?.event_id??v.stages?.at(-1)?.event_id??null)}}).catch(()=>{if(active)setFailedLoad({id,retry})});return()=>{active=false}},[id,retry,initialStageId])
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;document.body.style.overflow='hidden';closeRef.current?.focus();return()=>{document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus();else document.querySelector<HTMLElement>('[aria-label="处理状态"] button')?.focus()}},[])
 const value=snapshot?.id===id?snapshot.value:null
 const error=failedLoad?.id===id&&failedLoad.retry===retry
 const described=value?describeAlarm(value,trigger):null,look=levelLook[value?.behavior??'']??levelLook.appearance!
 const selected=value?.stages?.find(s=>s.event_id===stage)
 const act=async(disposition:AckDisposition)=>{
  if(!value||busy)return
  setBusy(true);setFailed(false)
  try{if(await confirm(value,pendingAttempt?.note??note,pendingAttempt?.disposition??disposition))close();else{setFailed(true);setRetryDisposition(disposition)}}finally{setBusy(false)}
 }
 const done=value?.handling.state==='acknowledged'
 return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-2 sm:p-4" onClick={e=>{if(e.target===e.currentTarget&&!busy)close()}}>
  <section ref={dialog} role="dialog" aria-modal="true" aria-label={intent?intent==='handled'?'确认告警':'标记误报':'告警详情'} onKeyDown={e=>{
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!busy)close();return}
   if(e.key!=='Tab')return
   const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')??[])
   const first=nodes[0],last=nodes[nodes.length-1]
   if(!first){e.preventDefault();return}
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
  }} className={`flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-panel bg-surface text-ink shadow-modal ${intent?'max-w-lg':'max-w-6xl'}`}>
   <header className="flex items-center gap-3 border-b border-line px-6 py-3">
    <div className="min-w-0 flex-1">
     <div className="flex flex-wrap items-center gap-2"><span className="rounded-full border px-2.5 py-0.5 text-xs font-semibold" style={{background:look.soft,color:look.ink,borderColor:look.color}}>{behaviorNames[value?.behavior??'']??'告警'}</span>
      <h2 className="text-base font-semibold text-ink">{intent?intent==='handled'?'确认已处理 · ':'标记误报 · ':''}{channelName}{described?.zone?` · ${described.zone}`:''}</h2></div>
     {value&&<p className="mt-1 text-sm text-ink-subtle">首次触发 {new Date(value.occurred_at).toLocaleString('zh-CN',{hour12:false})} · 最近阶段 {clock(value.last_seen_at)} · 触发器「{value.rule.name}」 · 目标：{described?.target}</p>}
    </div>
    <button ref={closeRef} type="button" aria-label="关闭详情" disabled={busy} onClick={close} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-base text-ink-faint hover:bg-surface-page hover:text-ink"><X size={20} aria-hidden="true"/></button>
   </header>
   {pendingAttempt&&<p role="status" className="px-5 py-2 text-sm text-warning-700">上次处理结果尚未确认；将重试原备注和原处理方式，请勿重复新建操作。</p>}
   {error?<p role="alert" className="p-6">读取失败。<button className="btn-secondary" onClick={()=>setRetry(n=>n+1)}>重试</button></p>:!value?<p role="status" className="p-6">正在读取…</p>:
   intent?<div className="min-h-0 space-y-4 overflow-y-auto p-5">
    <p className="text-sm text-ink">{described?.sentence}</p>
    {done?<p role="status" className="text-sm text-success-700">此告警已经处理，请关闭后核对列表。</p>:<>
     <label className="block text-sm font-medium">处理备注<textarea className="mt-1 block min-h-24 w-full rounded-base border border-line p-2.5 text-base" maxLength={500} value={pendingAttempt?.note??note} disabled={busy||!!pendingAttempt||!!retryDisposition} placeholder="选填" onChange={e=>setNote(e.target.value)}/></label>
     {failed&&<p role="alert" className="text-sm text-danger-700">处理结果未确认，请重试原操作或刷新核对。</p>}
     <div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={close} className="btn-secondary !min-h-11">取消</button><button type="button" disabled={busy} onClick={()=>void act(intent)} className="btn-primary !min-h-11">{busy?'处理中…':intent==='handled'?'确认已处理':'确认标记误报'}</button></div>
    </>}
   </div>:<div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_22rem]">
    <div className="min-w-0 space-y-3 p-6">
     <p className="text-sm leading-6 text-ink">{described?.sentence}</p>
     {selected?.behavior_event_ids?.[0]?<BehaviorEvidence key={selected.behavior_event_ids[0]} eventId={selected.behavior_event_ids[0]}/>:<p className="rounded-card bg-surface-page p-4 text-sm text-ink-subtle">此阶段没有截图。</p>}
     {playbackHref(value)?<div className="space-y-1"><Link to={playbackHref(value)!} target="_blank" rel="noopener noreferrer" className="btn-primary !min-h-11"><Play size={16} aria-hidden="true"/>查看录像（{clock(new Date(Date.parse(value.occurred_at)-PLAYBACK_MARGIN_MS).toISOString())}–{clock(new Date(Date.parse(value.last_seen_at)+PLAYBACK_MARGIN_MS).toISOString())}）</Link><p className="text-xs text-ink-subtle">在新页面打开对应来源和时间段，保留当前告警列表。</p></div>:<p className="text-sm text-ink-subtle">此告警没有有效的原帧时间或输入画面，无法跳转录像。</p>}
    </div>
    <aside className="flex min-w-0 flex-col gap-4 border-line p-6 md:border-l">
     <h3 className="font-semibold">经过</h3>
     <ol className="space-y-2">{(value.stages??[]).map(s=><li key={s.event_id}>
      <button type="button" aria-pressed={s.event_id===stage} onClick={()=>setStage(s.event_id)} className={`flex min-h-14 w-full items-center gap-3 rounded-card border p-2 text-left ${s.event_id===stage?'border-primary bg-primary-50':'border-line'}`}>
       <span className="w-16 shrink-0">{s.behavior_event_ids?.[0]?<EvidenceThumb compact eventId={s.behavior_event_ids[0]} label={behaviorNames[s.behavior]??s.behavior}/>:null}</span>
       <span className="min-w-0"><b style={{color:(levelLook[s.behavior]??levelLook.appearance!).color}}>{behaviorNames[s.behavior]??s.behavior}</b><span className="block text-sm text-ink-subtle">{clock(s.at)} · {stageNote(s,described!.edgeName)}</span></span>
      </button></li>)}</ol>
     {done?<p role="status" className="rounded-card bg-success-50 p-3 text-sm text-success-700">{value.handling.disposition==='false_positive'?'已标记误报':'已确认'} · {value.handling.acknowledged_by} · {value.handling.acknowledged_at?new Date(value.handling.acknowledged_at).toLocaleString():''}{value.handling.note?` · ${value.handling.note}`:''}</p>:
     <div className="mt-auto space-y-2">
      <label className="block text-sm font-medium">处理备注<textarea className="mt-1 block min-h-20 w-full rounded-card border border-line p-2.5" maxLength={500} value={pendingAttempt?.note??note} disabled={busy||!!pendingAttempt||!!retryDisposition} onChange={e=>setNote(e.target.value)}/></label>
      {failed&&<p role="alert" className="text-sm text-danger-700">处理结果未确认，请重试或刷新核对。</p>}
      <div className="flex gap-2"><button type="button" disabled={busy||(pendingAttempt?.disposition??retryDisposition)==='false_positive'} onClick={()=>void act('handled')} className="btn-primary flex-1">确认已处理</button>
       <button type="button" disabled={busy||(pendingAttempt?.disposition??retryDisposition)==='handled'} onClick={()=>void act('false_positive')} className="btn-secondary">标记误报</button></div>
     </div>}
     {!!value.logs?.length&&<details className="text-sm"><summary className="cursor-pointer py-2 text-sm font-medium text-ink">处理记录（{value.logs.length}）</summary><ul>{value.logs.map(l=><li key={l.operation_id} className="border-t border-line py-1.5">{new Date(l.at).toLocaleString()} · {l.action==='acknowledged'?'已确认':l.action==='false_positive'?'标记误报':l.action==='created'?'生成告警':l.action} · {l.actor}{l.note?` · ${l.note}`:''}</li>)}</ul></details>}
    </aside>
   </div>}
  </section>
 </div>
}
