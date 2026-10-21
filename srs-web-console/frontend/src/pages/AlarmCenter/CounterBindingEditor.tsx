import {ArrowLeftRight,Plus,Check,X} from 'lucide-react'
import {useEffect,useState} from 'react'
import type {AlarmSource} from '@/api/alarmTriggerService'
import {newAlarmOperationId} from '@/api/alarmZoneService'
import {methodNames,type BindingDirection,type Counter,type CounterMethod} from '@/api/flowService'
import {sameDirection,type DraftCounterBinding,type DraftZone} from '@/features/armingDraft'
import {edgeNames,sourceSize} from '@/features/alarmTriggers'
import {labelDisplay} from '@/features/labelNames'

/** Counting line being set on the canvas; incomplete while the user is still tapping edges. */
export interface CountingPick {method:CounterMethod;edge?:string;inSide:'inward'|'outward';from?:string;to?:string;entry:string[];exit:string[]}
export function pickFrom(method:CounterMethod,d?:BindingDirection):CountingPick{
 const base:CountingPick={method,inSide:'inward',entry:[],exit:[]}
 if(!d)return base
 if(d.kind==='line')return {...base,edge:d.edge,inSide:d.in_side}
 if(d.kind==='gates')return {...base,from:d.from,to:d.to}
 if(d.kind==='edges')return {...base,entry:[...d.entry],exit:[...d.exit]}
 return base
}
/** One tap on an edge: a line moves or flips, gates fill A then B, a zone edge cycles entry → exit → none. */
export function tapEdge(pick:CountingPick,id:string):CountingPick{
 if(pick.method==='line')return pick.edge===id?{...pick,inSide:pick.inSide==='inward'?'outward':'inward'}:{...pick,edge:id}
 if(pick.method==='gates'){
  if(!pick.from||pick.to)return {...pick,from:id,to:undefined}
  return id===pick.from?pick:{...pick,to:id}
 }
 if(pick.entry.includes(id))return {...pick,entry:pick.entry.filter(e=>e!==id),exit:[...pick.exit,id]}
 if(pick.exit.includes(id))return {...pick,exit:pick.exit.filter(e=>e!==id)}
 return {...pick,entry:[...pick.entry,id]}
}
export function pickDirection(pick:CountingPick):BindingDirection|null{
 if(pick.method==='line')return pick.edge?{kind:'line',edge:pick.edge,in_side:pick.inSide}:null
 if(pick.method==='gates')return pick.from&&pick.to?{kind:'gates',from:pick.from,to:pick.to}:null
 return pick.entry.length&&pick.exit.length?{kind:'edges',entry:pick.entry,exit:pick.exit}:null
}
interface Props {
 sourceId:string;geometryRevision:string;zone:DraftZone;counters:Counter[];sources:AlarmSource[]
 used:string[];initial?:DraftCounterBinding;pick:CountingPick|null
 onPick:(pick:CountingPick|null)=>void;onApply:(binding:DraftCounterBinding,labelVersion:string)=>void;onCancel:()=>void;onCreateCounter:()=>void
}
const choice='btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
/** Only updates the arming draft; nothing is saved until 保存布防. */
export function CounterBindingEditor({sourceId,geometryRevision,zone,counters,sources,used,initial,pick,onPick,onApply,onCancel,onCreateCounter}:Props){
 const [counterId,setCounterId]=useState(initial?.counterId??'')
 const [processorId,setProcessorId]=useState(initial?.processorId??'')
 const [recount,setRecount]=useState(false)
 const available=counters.filter(c=>c.state!=='archived'&&(c.counter_id===initial?.counterId||!used.includes(c.counter_id)))
 const counter=available.find(c=>c.counter_id===counterId)
 const compatible=counter?sources.filter(s=>s.input_stream_id===sourceId&&s.geometry_revision===geometryRevision&&s.tracking_available&&counter.labels.every(l=>s.labels.some(v=>v.label_id===l.label_id))):[]
 const effective=compatible.find(s=>s.channel_id===processorId)??(!processorId&&compatible.length===1?compatible[0]:undefined)
 const size=sourceSize(geometryRevision),names=edgeNames(zone.points,size?.width,size?.height)
 const edgeLabel=(id?:string)=>{const i=id?zone.edgeIds.indexOf(id):-1;return i<0?'—':`边 ${i+1}（${names[i]}）`}
 const direction=pick?pickDirection(pick):null
 // Earlier passages keep the meaning they had; recounting them is an explicit choice.
 const lineChanged=!!initial&&!initial.needsConfirmation&&!!direction&&!sameDirection(direction,initial.direction)
 const choose=(c:Counter)=>{setCounterId(c.counter_id);onPick(pickFrom(c.method,initial?.counterId===c.counter_id&&!initial.needsConfirmation?initial.direction:undefined))}
 // The only choice is preselected; an existing selection opens on its own counter.
 useEffect(()=>{const only=initial?available.find(c=>c.counter_id===initial.counterId):available.length===1?available[0]:undefined;if(only&&!counterId)choose(only)},[])
 const apply=()=>{
  if(!counter||!effective||!direction)return
  onApply({id:initial?.id??`flow-${newAlarmOperationId()}`,counterId:counter.counter_id,processorId:effective.channel_id,zoneId:zone.id,direction,needsConfirmation:false,...(lineChanged&&recount?{reclassifyHistory:true}:{})},effective.label_map_version)
 }
 const inName=counter?.names.in??'进',outName=counter?.outputs==='both'?counter.names.out:null
 return <section aria-label="选用计数器" className="space-y-4 rounded-panel border border-line p-4">
  <header className="flex items-center gap-2"><h3 className="min-w-0 flex-1 text-sm font-semibold text-ink">{zone.name} · 选用计数器</h3></header>
  {initial?.needsConfirmation&&<p role="alert" className="rounded-base border border-warning bg-amber-50 p-3 text-sm">热区的边已变化，请在画面上重新设置计数线。</p>}
  <div role="radiogroup" aria-label="计数器" className="space-y-2">
   {available.map(c=><button key={c.counter_id} type="button" role="radio" aria-checked={counterId===c.counter_id} disabled={!!initial}
    onClick={()=>choose(c)} className={`relative w-full rounded-panel border p-3 text-left transition-colors disabled:cursor-default ${counterId===c.counter_id?'border-primary bg-primary-50 ring-1 ring-primary':'border-line bg-surface hover:bg-surface-hover'}`}>
    <strong className="block text-sm font-semibold text-ink">{c.name}{c.state==='paused'?'（已暂停）':''}</strong>
    <span className="mt-0.5 block text-xs text-ink-subtle">{methodNames[c.method]} · {c.labels.map(l=>labelDisplay(l.name)).join('、')} · {c.outputs==='both'?`${c.names.in}/${c.names.out}`:c.names.in}</span>
    {counterId===c.counter_id&&<span aria-hidden="true" className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-xs text-white">✓</span>}
   </button>)}
   {!available.length&&<p className="text-sm text-ink-subtle">{counters.length?'计数器都已选用到这个热区。':'还没有计数器。'}</p>}
   {!initial&&<button type="button" className="btn-secondary" onClick={onCreateCounter}><Plus size={16} aria-hidden="true"/>新建计数器</button>}
  </div>
  {counter&&<>
   {compatible.length>1&&<label className="block text-sm font-medium text-ink">AI 处理器<select className="form-input mt-1.5" value={effective?.channel_id??''} onChange={e=>setProcessorId(e.target.value)}>
    <option value="">请选择 AI 处理器</option>{compatible.map(s=><option key={s.channel_id} value={s.channel_id}>{s.channel_name}</option>)}</select></label>}
   {!compatible.length&&<p role="status" className="text-sm">没有可用的 AI 处理器：需要当前画面、开启目标跟踪，并能识别{counter.labels.map(l=>labelDisplay(l.name)).join('、')}。</p>}
   <div className="space-y-2 rounded-base bg-surface-page p-3 text-sm">
    <p className="font-medium text-ink">{counter.method==='line'?'在画面上点一条边作为计数线':counter.method==='gates'?'在画面上依次点两条边：先 A 后 B':'在画面上点边：第一次设为进入边（绿），再点设为离开边（橙），再点取消'}</p>
    {pick&&counter.method==='line'&&<>
     <p>计数线：{edgeLabel(pick.edge)}</p>
     {pick.edge&&<p>箭头方向记为“{inName}”{outName?`，反方向记为“${outName}”`:''}。</p>}
     <button type="button" className="btn-secondary" disabled={!pick.edge} onClick={()=>onPick({...pick,inSide:pick.inSide==='inward'?'outward':'inward'})}><ArrowLeftRight size={16} aria-hidden="true"/>翻转方向</button>
    </>}
    {pick&&counter.method==='gates'&&<>
     <p>A：{edgeLabel(pick.from)} → B：{edgeLabel(pick.to)}</p>
     {direction&&<p>从 A 到 B 记为“{inName}”{outName?`，从 B 到 A 记为“${outName}”`:''}。</p>}
     <button type="button" className="btn-secondary" disabled={!direction} onClick={()=>onPick({...pick,from:pick.to,to:pick.from})}><ArrowLeftRight size={16} aria-hidden="true"/>对调 A 与 B</button>
    </>}
    {pick&&counter.method==='zone'&&<>
     <p>进入边：{pick.entry.map(edgeLabel).join('、')||'—'}；离开边：{pick.exit.map(edgeLabel).join('、')||'—'}</p>
     {direction&&<p>从进入边进、离开边出记为“{inName}”{outName?`，反向记为“${outName}”`:''}。</p>}
     <button type="button" className="btn-secondary" disabled={!direction} onClick={()=>onPick({...pick,entry:pick.exit,exit:pick.entry})}><ArrowLeftRight size={16} aria-hidden="true"/>对调方向</button>
    </>}
    <div role="group" aria-label="热区的边" className="flex flex-wrap gap-2 pt-1">{zone.edgeIds.map((id,i)=>{
     const on=pick?(pick.edge===id||pick.from===id||pick.to===id||pick.entry.includes(id)||pick.exit.includes(id)):false
     return <button key={id} type="button" aria-pressed={on} className={choice} onClick={()=>pick&&onPick(tapEdge(pick,id))}>边 {i+1}</button>
    })}</div>
   </div>
  </>}
  {lineChanged&&<fieldset role="group" aria-label="以前的记录" className="space-y-2 rounded-base border border-line p-3 text-sm">
   <legend className="px-1 font-medium text-ink">以前的记录</legend>
   <label className="flex items-start gap-2"><input type="radio" name="recount" className="mt-1" checked={!recount} onChange={()=>setRecount(false)}/><span>保持原统计<span className="block text-xs text-ink-subtle">新计数线从保存时起生效，以前的数量不变。</span></span></label>
   <label className="flex items-start gap-2"><input type="radio" name="recount" className="mt-1" checked={recount} onChange={()=>setRecount(true)}/><span>按新计数线重新统计<span className="block text-xs text-ink-subtle">适合原来方向设反了：以前的通行也按新计数线重新分进出。</span></span></label>
  </fieldset>}
  <div className="flex flex-wrap justify-end gap-2"><button type="button" className="btn-secondary" onClick={onCancel}><X size={16} aria-hidden="true"/>取消</button>
   <button type="button" className="btn-primary" disabled={!counter||!effective||!direction} onClick={apply}><Check size={16} aria-hidden="true"/>加入布防草稿</button></div>
  <p className="text-xs text-ink-subtle">只更新草稿，点击“保存布防”后生效。拖动顶点不影响计数线；增删顶点后需要重新设置。</p>
 </section>
}
