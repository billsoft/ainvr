import {useEffect,useRef,useState} from 'react'
import {Link} from 'react-router-dom'
import {alarmEventService,type AlarmEvent,type AckDisposition} from '@/api/alarmEventService'
import {behaviorNames,levelLook} from '@/features/alarmTriggers'
import {describeAlarm,stageNote,type AlarmContext} from '@/features/alarmSentences'
import {BehaviorEvidence} from './BehaviorEvidence'
import {EvidenceThumb} from './EvidenceThumb'

const clock=(v:string)=>new Date(v).toLocaleTimeString('zh-CN',{hour12:false})
const PLAYBACK_MARGIN_MS=15000
/** Recording window around the activity, opened in playback for the input camera. */
export function playbackHref(alarm:AlarmEvent){
 if(!alarm.input_stream_id)return null
 const from=Date.parse(alarm.occurred_at)-PLAYBACK_MARGIN_MS,to=Date.parse(alarm.last_seen_at)+PLAYBACK_MARGIN_MS
 return `/playback/${encodeURIComponent(alarm.input_stream_id)}?from=${from}&to=${to}`
}
interface Props {
 id:string;channelName:string;trigger:AlarmContext|undefined;close:()=>void
 confirm:(alarm:AlarmEvent,note:string,disposition:AckDisposition)=>Promise<boolean>
}
// Bottom sheet: everything about one alarm on one layer, no nested dialogs.
export function AlarmSheet({id,channelName,trigger,close,confirm}:Props){
 const [value,setValue]=useState<AlarmEvent|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0)
 const [stage,setStage]=useState<string|null>(null),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false)
 const closeRef=useRef<HTMLButtonElement>(null)
 useEffect(()=>{let active=true;setError(false);void alarmEventService.get(id).then(v=>{if(active){setValue(v);setStage(v.stages?.at(-1)?.event_id??null)}}).catch(()=>{if(active)setError(true)});return()=>{active=false}},[id,retry])
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;closeRef.current?.focus();return()=>previous?.focus()},[])
 const described=value?describeAlarm(value,trigger):null,look=levelLook[value?.behavior??'']??levelLook.appearance!
 const selected=value?.stages?.find(s=>s.event_id===stage)
 const act=async(disposition:AckDisposition)=>{
  if(!value||busy)return
  setBusy(true);setFailed(false)
  try{if(await confirm(value,note,disposition))close();else setFailed(true)}finally{setBusy(false)}
 }
 const done=value?.handling.state==='acknowledged'
 return <div className="fixed inset-0 z-50 flex flex-col justify-end bg-slate-900/55" onClick={e=>{if(e.target===e.currentTarget&&!busy)close()}}>
  <section role="dialog" aria-modal="true" aria-label="告警详情" onKeyDown={e=>{if(e.key==='Escape'&&!busy)close()}}
   className="flex max-h-[92vh] flex-col rounded-t-3xl bg-surface text-ink shadow-modal">
   <div aria-hidden="true" className="mx-auto mt-2.5 h-1.5 w-14 rounded-full bg-slate-300"/>
   <header className="flex items-center gap-3 border-b border-line px-6 py-3">
    <div className="min-w-0 flex-1">
     <div className="flex flex-wrap items-center gap-2"><span className="rounded-full border px-2.5 py-0.5 text-xs font-semibold" style={{background:look.soft,color:look.ink,borderColor:look.color}}>{behaviorNames[value?.behavior??'']??'告警'}</span>
      <h2 className="text-base font-semibold text-ink">{channelName}{described?.zone?` · ${described.zone}`:''}</h2></div>
     {value&&<p className="mt-1 text-sm text-ink-subtle">首次触发 {clock(value.occurred_at)} · 最近阶段 {clock(value.last_seen_at)} · 触发器「{value.rule.name}」 · 目标：{described?.target}</p>}
    </div>
    <button ref={closeRef} type="button" aria-label="关闭详情" disabled={busy} onClick={close} className="flex h-9 w-9 items-center justify-center rounded-base text-ink-faint hover:bg-surface-page hover:text-ink">×</button>
   </header>
   {error?<p role="alert" className="p-6">读取失败。<button className="btn-secondary" onClick={()=>setRetry(n=>n+1)}>重试</button></p>:!value?<p role="status" className="p-6">正在读取…</p>:
   <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_22rem]">
    <div className="min-w-0 space-y-3 p-6">
     <p className="text-sm leading-6 text-ink">{described?.sentence}</p>
     {selected?.behavior_event_ids?.[0]?<BehaviorEvidence key={selected.behavior_event_ids[0]} eventId={selected.behavior_event_ids[0]}/>:<p className="rounded-card bg-surface-page p-4 text-sm text-ink-subtle">此阶段没有截图。</p>}
     {playbackHref(value)?<Link to={playbackHref(value)!} className="btn-primary">▶ 查看录像（{clock(new Date(Date.parse(value.occurred_at)-PLAYBACK_MARGIN_MS).toISOString())}–{clock(new Date(Date.parse(value.last_seen_at)+PLAYBACK_MARGIN_MS).toISOString())}）</Link>:<p className="text-sm text-ink-subtle">此告警没有记录输入画面，无法跳转录像。</p>}
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
      <label className="block text-sm font-medium">处理备注<textarea className="mt-1 block min-h-20 w-full rounded-card border border-line p-2.5" maxLength={500} value={note} disabled={busy} onChange={e=>setNote(e.target.value)}/></label>
      {failed&&<p role="alert" className="text-sm text-danger-700">处理结果未确认，请重试或刷新核对。</p>}
      <div className="flex gap-2"><button type="button" disabled={busy} onClick={()=>void act('handled')} className="btn-primary flex-1">确认已处理</button>
       <button type="button" disabled={busy} onClick={()=>void act('false_positive')} className="btn-secondary">标记误报</button></div>
     </div>}
     {!!value.logs?.length&&<details className="text-sm"><summary className="cursor-pointer py-2 text-sm font-medium text-ink">处理记录（{value.logs.length}）</summary><ul>{value.logs.map(l=><li key={l.operation_id} className="border-t border-line py-1.5">{new Date(l.at).toLocaleString()} · {l.action==='acknowledged'?'已确认':l.action==='false_positive'?'标记误报':l.action==='created'?'生成告警':l.action} · {l.actor}{l.note?` · ${l.note}`:''}</li>)}</ul></details>}
    </aside>
   </div>}
  </section>
 </div>
}
