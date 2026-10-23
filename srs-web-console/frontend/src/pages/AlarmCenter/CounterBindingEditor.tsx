import {associationChoiceClass,AssociationChoiceAction} from './AssociationChoice'
import {countingDrawing,countingArrowLabel} from '@/features/counterGeometry'
import {useWorkspaceDraft,type WorkspaceDraftRef} from './workspaceDraft'
import {ArrowLeftRight,Unlink,ExternalLink} from 'lucide-react'
import {useRef,useState} from 'react'
import type {AlarmSource} from '@/api/alarmTriggerService'
import {newAlarmOperationId} from '@/api/alarmZoneService'
import {methodNames,type Counter} from '@/api/flowService'
import {sameDirection,type DraftCounterBinding,type DraftZone} from '@/features/armingDraft'
import {edgeNames,sourceSize} from '@/features/alarmTriggers'
import {labelDisplay} from '@/features/labelNames'

import {isConcaveRegion,pickFrom,pickDirection,tapEdge,type CountingPick} from '@/features/countingSelection'
interface Props {
 workspace:WorkspaceDraftRef;
 sourceId:string;geometryRevision:string;zone:DraftZone;counters:Counter[];sources:AlarmSource[]
 used:string[];initial?:DraftCounterBinding;pick:CountingPick|null
 onPick:(pick:CountingPick|null)=>void;onApply:(binding:DraftCounterBinding,labelVersion:string)=>void
 /** Present when editing an existing selection: stops counting here once saved. */
 onRemove?:()=>void
}
const choice='btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
/** Only updates the arming draft; nothing is saved until 保存布防. */
export function CounterBindingEditor({sourceId,geometryRevision,zone,counters,sources,used,initial,pick,onPick,onApply,onRemove,workspace}:Props){
 const [query,setQuery]=useState(''),[method,setMethod]=useState('')
 const [counterId,setCounterId]=useState(initial?.counterId??'')
 const [processorId,setProcessorId]=useState(initial?.processorId??'')
 const [recount,setRecount]=useState(false),[error,setError]=useState('')
 const generatedId=useRef(`flow-${newAlarmOperationId()}`)
 const original=useRef(JSON.stringify({counterId,processorId,direction:pick?pickDirection(pick):null,recount}))
 const available=counters.filter(c=>!c.deleting&&(c.counter_id===initial?.counterId||!used.includes(c.counter_id)))
 const counter=available.find(c=>c.counter_id===counterId)
 const compatible=counter?sources.filter(s=>s.input_stream_id===sourceId&&s.geometry_revision===geometryRevision&&s.tracking_available&&counter.labels.every(l=>s.labels.some(v=>v.label_id===l.label_id))):[]
 const effective=compatible.find(s=>s.channel_id===processorId)??(!processorId&&compatible.length===1?compatible[0]:undefined)
 const size=sourceSize(geometryRevision),names=edgeNames(zone.points,size?.width,size?.height)
 const edgeLabel=(id?:string)=>{const i=id?zone.edgeIds.indexOf(id):-1;return i<0?'—':`边 ${i+1}（${names[i]}）`}
 const lineDirectionLabel=(side:'inward'|'outward')=>{
  if(!pick?.edge||!size)return '请先选择计数边'
  return countingArrowLabel(countingDrawing({kind:'line',edge:pick.edge,in_side:side},zone.points,zone.edgeIds,size.width,size.height).arrow,size.width,size.height)
 }
 const direction=pick?pickDirection(pick):null
 const concave=isConcaveRegion(zone.points)
 // Earlier passages keep the meaning they had; recounting them is an explicit choice.
 const lineChanged=!!initial&&!initial.needsConfirmation&&!!direction&&!sameDirection(direction,initial.direction)
 const choose=(c:Counter)=>{setCounterId(c.counter_id);onPick(pickFrom(c.method,initial?.counterId===c.counter_id&&!initial.needsConfirmation?initial.direction:undefined))}
 const apply=()=>{
  if(!counter||!effective||!direction){setError('请选择兼容的计数器、处理器并完成方向设置。');return false}
  try{onApply({id:initial?.id??generatedId.current,counterId:counter.counter_id,processorId:effective.channel_id,zoneId:zone.id,direction,needsConfirmation:false,...(lineChanged&&recount?{reclassifyHistory:true}:{})},effective.label_map_version);return true}catch(e){setError(e instanceof Error?e.message:'不能加入草稿');return false}
 }
 useWorkspaceDraft(workspace,{flush:()=>!initial&&!counterId?true:apply(),dirty:()=>JSON.stringify({counterId,processorId,direction,recount})!==original.current})
 const inName=counter?.names.in??'进',outName=counter?.outputs==='both'?counter.names.out:null
 return <section aria-label="选用计数器" className="space-y-4 rounded-panel border border-line p-4">
  <header className="flex items-center gap-2"><h3 className="min-w-0 flex-1 text-sm font-semibold text-ink">{zone.name} · 选用计数器</h3></header>
  {initial?.needsConfirmation&&<p role="alert" className="rounded-base border border-warning bg-amber-50 p-3 text-sm">热区的边已变化，请在画面上重新设置计数线。</p>}
  {!counter&&<p role="status" className="text-sm leading-6 text-ink-subtle">先点击下方计数器选用，再在画面上选择计数边。</p>}
  {!initial&&<div className="space-y-2">
   <input type="search" aria-label="搜索计数器" placeholder="搜索名称或目标类别" className="form-input !min-h-11 w-full" value={query} onChange={e=>setQuery(e.target.value)}/>
   <select aria-label="计数方式筛选" className="form-input !min-h-11 w-full" value={method} onChange={e=>setMethod(e.target.value)}><option value="">全部计数方式</option>{Object.entries(methodNames).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>
   <p className="text-xs text-ink-subtle">可选 {available.length} 个 · 已选项始终保留。每个热区独立计数。</p>
  </div>}
  <div role="radiogroup" aria-label="计数器" className="space-y-2">
   {(initial?available.filter(c=>c.counter_id===initial.counterId):available.filter(c=>c.counter_id===counterId||((!method||c.method===method)&&`${c.name} ${c.labels.map(l=>labelDisplay(l.name)).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))).map(c=><button key={c.counter_id} type="button" role="radio" aria-checked={counterId===c.counter_id} disabled={!!initial}
    onClick={()=>choose(c)} className={`${associationChoiceClass(counterId===c.counter_id)} disabled:cursor-default`}>
    <span className="min-w-0 flex-1"><strong className="block break-words text-sm font-semibold text-ink">{c.name}{c.state==='paused'?'（已暂停）':''}</strong>
    <span className="mt-1 block text-xs leading-5 text-ink-subtle">{methodNames[c.method]} · {c.labels.map(l=>labelDisplay(l.name)).join('、')} · {c.outputs==='both'?`${c.names.in}/${c.names.out}`:c.names.in}</span></span>
    <AssociationChoiceAction selected={counterId===c.counter_id}/>

   </button>)}
   {!available.length&&<p className="text-sm text-ink-subtle">{counters.length?'计数器都已选用到这个热区。':'还没有计数器。'}</p>}
  </div>
  {!initial&&available.length>0&&!available.some(c=>c.counter_id===counterId||((!method||c.method===method)&&`${c.name} ${c.labels.map(l=>labelDisplay(l.name)).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))&&<p role="status" className="text-sm text-ink-subtle">没有匹配的计数器，请调整搜索条件。</p>}
  {!initial&&<a href="/flow-statistics" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-sm text-ink-subtle hover:text-primary"><ExternalLink size={14} aria-hidden="true"/>管理计数器</a>}
  {counter&&<>
   {(compatible.length>1||(!!processorId&&!effective))&&<label className="block text-sm font-medium text-ink">AI 处理器<select className="form-input mt-1.5" value={effective?.channel_id??''} onChange={e=>setProcessorId(e.target.value)}>
    <option value="">请选择 AI 处理器</option>{compatible.map(s=><option key={s.channel_id} value={s.channel_id}>{s.channel_name}</option>)}</select></label>}
   {processorId&&!effective&&<p role="alert" className="text-sm text-danger">原处理器已不可用，请明确选择替代处理器。</p>}
   {!compatible.length&&<p role="status" className="text-sm">没有可用的 AI 处理器：需要当前画面、开启目标跟踪，并能识别{counter.labels.map(l=>labelDisplay(l.name)).join('、')}。</p>}
   <div className="space-y-3 rounded-card border border-line bg-surface-page p-3 text-sm">
    <p className="font-semibold text-ink">计数方式：{methodNames[counter.method]}</p>
    {counter.method!=='line'&&<>
     <p className="text-xs leading-5 text-ink-subtle">不要求两条边平行或相对。{counter.method==='zone'?'需要观察到目标从区外进入、经过区内，再从指定边离开。':'按指定 A、B 边的通过顺序计数。'}</p>
     <div className="flex flex-wrap gap-3 text-xs"><span className="text-green-700">● 绿色：{counter.method==='zone'?'进入边':'A 边'}</span><span className="text-orange-700">● 橙色：{counter.method==='zone'?'离开边':'B 边'}</span></div>
     {concave&&<p role="status" className="rounded-base border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">这是凹多边形。复杂凹形可能中断通行判定而少计，建议在实际通道处另画简单计数区域；原热区可以继续用于告警。</p>}
    </>}
    {counter.method==='line'&&<p className="text-xs leading-5 text-ink-subtle">只统计穿过所选边的目标，越过这条边的延长线不计数。</p>}
    <p className="font-medium text-ink">{counter.method==='line'?'选择计数边':counter.method==='gates'?'在画面上依次点两条边：先 A 后 B':'先选择进入边或离开边，再在画面上点选；重复点选取消该边'}</p>
    {pick&&counter.method==='line'&&<>
     <p>计数线：{edgeLabel(pick.edge)}</p>
     {pick.edge&&<p>顺着箭头通过记为“{inName}”{outName?`，反方向记为“${outName}”`:''}。</p>}
     {pick.edge&&<fieldset className="space-y-2">
      <legend className="text-sm font-medium">哪个方向计为“{inName}”？</legend>
      <div role="group" aria-label="计数方向" className="grid grid-cols-2 gap-2">{(['inward','outward'] as const).map(side=><button key={side} type="button" aria-pressed={pick.inSide===side} className={`${choice} !min-h-11 !px-2 !text-sm`} onClick={()=>onPick({...pick,inSide:side})}>{lineDirectionLabel(side)}</button>)}</div>
     </fieldset>}
    </>}
    {pick&&counter.method==='gates'&&<>
     <div role="group" aria-label="设置哪条计数边" className="flex gap-2">{(['from','to'] as const).map(t=><button type="button" key={t} className={choice} aria-pressed={(pick.target??(!pick.from?'from':'to'))===t} onClick={()=>onPick({...pick,target:t})}>{t==='from'?'设置 A 边':'设置 B 边'}</button>)}</div>
     <p>A：{edgeLabel(pick.from)} → B：{edgeLabel(pick.to)}</p>
     {direction&&<p>从 A 到 B 记为“{inName}”{outName?`，从 B 到 A 记为“${outName}”`:''}。</p>}
     <button type="button" className="btn-secondary" disabled={!direction} onClick={()=>onPick({...pick,from:pick.to,to:pick.from})}><ArrowLeftRight size={16} aria-hidden="true"/>对调 A 与 B</button>
    </>}
    {pick&&counter.method==='zone'&&<>
     <div role="group" aria-label="方向工具" className="flex gap-2">{(['entry','exit'] as const).map(t=><button type="button" key={t} className={choice} aria-pressed={(pick.target??'entry')===t} onClick={()=>onPick({...pick,target:t})}>{t==='entry'?'选择进入边':'选择离开边'}</button>)}</div>
     <p>进入边：{pick.entry.map(edgeLabel).join('、')||'—'}；离开边：{pick.exit.map(edgeLabel).join('、')||'—'}</p>
     <p className="text-xs leading-5 text-ink-subtle">绿色箭头朝区内、橙色箭头朝区外，表示计为“{inName}”的方向；不要求目标沿箭头直走。</p>
     {direction&&<p>从进入边进、离开边出记为“{inName}”{outName?`，反向记为“${outName}”`:''}。</p>}
     <button type="button" className="btn-secondary" disabled={!direction} onClick={()=>onPick({...pick,entry:pick.exit,exit:pick.entry})}><ArrowLeftRight size={16} aria-hidden="true"/>对调进出方向</button>
    </>}
    <div role="group" aria-label="热区的边" className="flex flex-wrap gap-2 pt-1">{zone.edgeIds.map((id,i)=>{
     const on=pick?(pick.edge===id||pick.from===id||pick.to===id||pick.entry.includes(id)||pick.exit.includes(id)):false
     const entry=pick?.method!=='line'&&(pick?.from===id||pick?.entry.includes(id)),exit=pick?.method!=='line'&&(pick?.to===id||pick?.exit.includes(id))
     const tone=entry?'aria-pressed:!border-green-600 aria-pressed:!bg-green-50 aria-pressed:!text-green-800':exit?'aria-pressed:!border-orange-500 aria-pressed:!bg-orange-50 aria-pressed:!text-orange-800':''
     return <button key={id} type="button" aria-pressed={on} className={`${choice} ${tone} !min-h-11`} onClick={()=>pick&&onPick(tapEdge(pick,id))}>边 {i+1}{entry?counter.method==='zone'?' · 进入':' · A':exit?counter.method==='zone'?' · 离开':' · B':''}</button>
    })}</div>
    {counter.method!=='line'&&<p className="text-xs leading-5 text-ink-subtle">从未选定的边进出，不计入所选方向；从同一条边进入再退回不计数。箭头只表示计数方向，不代表实际行走路线。</p>}
    {!direction&&<p role="status" className="text-xs text-ink-subtle">{counter.method==='line'?'请选择一条计数边。':counter.method==='gates'?'请选择两条不同的边，完成后才能关联。':'请分别选择至少一条进入边和离开边，完成后才能关联。'}</p>}
   </div>
  </>}
  {lineChanged&&<fieldset role="group" aria-label="以前的记录" className="space-y-2 rounded-base border border-line p-3 text-sm">
   <legend className="px-1 font-medium text-ink">以前的记录</legend>
   <label className="flex items-start gap-2"><input type="radio" name="recount" className="mt-1" checked={!recount} onChange={()=>setRecount(false)}/><span>保持原统计<span className="block text-xs text-ink-subtle">新计数线从保存时起生效，以前的数量不变。</span></span></label>
   <label className="flex items-start gap-2"><input type="radio" name="recount" className="mt-1" checked={recount} onChange={()=>setRecount(true)}/><span>按新计数线重新统计<span className="block text-xs text-ink-subtle">适合原来方向设反了：以前的通行也按新计数线重新分进出。</span></span></label>
  </fieldset>}
  {error&&<p role="alert" className="text-sm text-danger">{error}</p>}
  {onRemove&&<div className="flex justify-end"><button type="button" className="btn-secondary mr-auto text-danger" onClick={onRemove}><Unlink size={16} aria-hidden="true"/>移除计数</button></div>}
  {counter&&<p className="text-xs text-ink-subtle">增删热区顶点后需重新选择计数边。</p>}
 </section>
}
