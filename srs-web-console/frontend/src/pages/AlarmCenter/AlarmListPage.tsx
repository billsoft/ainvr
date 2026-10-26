import {useLocation} from 'react-router-dom'
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react'
import {alarmEventService,type AlarmEvent,type AckDisposition,type AlarmFilters,type AckItem} from '@/api/alarmEventService'
import {aiChannelService} from '@/api/aiChannelService'
import {alarmTriggerService} from '@/api/alarmTriggerService'
import {alarmDefinitionService} from '@/api/alarmDefinitionService'
import {alarmArmingService} from '@/api/alarmArmingService'
import type {ArmingDocument} from '@/features/armingDocument'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
import {behaviorStatisticsService} from '@/api/behaviorStatisticsService'
import {newAlarmOperationId} from '@/api/alarmZoneService'
import {levelLook,triggerBehaviors,type AlarmTrigger} from '@/features/alarmTriggers'
import type {AlarmContext} from '@/features/alarmSentences'
import {AlarmRow} from './AlarmRow'
import {AlarmSheet,type PendingAcknowledgement} from './AlarmSheet'
import {AlarmConfirmation} from './AlarmConfirmation'
import {AlarmPurgeDialog} from './AlarmPurgeDialog'

// One compact row per target activity (highest level), newest first.
// Evidence and stage history open in one detail layer; controls keep 44 px targets.
type Status='pending'|'acknowledged'|'all'|'human'|'ai'
type Range='today'|'7d'|'all'
const pill='btn-secondary !min-h-11 aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
const midnight=()=>{const d=new Date();d.setHours(0,0,0,0);return d}
function rangeFrom(range:Range){return range==='today'?midnight().toISOString():range==='7d'?new Date(Date.now()-7*86400000).toISOString():undefined}
const ackOk=(outcome:string)=>['succeeded','already_acknowledged'].includes(outcome)

export default function AlarmListPage(){
 // Unhandled alarms are never hidden by the clock: pending defaults to all time,
 // handled history defaults to today, until the user picks a range.
 const [status,setStatus]=useState<Status>('pending'),[level,setLevel]=useState(''),[channel,setChannel]=useState(''),[range,setRange]=useState<Range>('all')
 const [review,setReview]=useState('')
 const rangeTouched=useRef(false)
 const location=useLocation()
 useEffect(()=>{
  const params=new URLSearchParams(location.search)
  if(params.get('status')==='pending'&&params.get('range')==='all'){
   setStatus('pending');setRange('all');setChannel('');setLevel('');setReview('');rangeTouched.current=false
  }
 },[location.key,location.search])
 const pickStatus=(next:Status)=>{setStatus(next);if(next==='pending')setReview('');if(!rangeTouched.current)setRange(next==='pending'?'all':'today')}
 const [channels,setChannels]=useState<{id:string;name:string}[]>([]),[triggers,setTriggers]=useState<AlarmTrigger[]>([])
 const [definitions,setDefinitions]=useState<TriggerDefinition[]>([]),[armings,setArmings]=useState<Record<string,ArmingDocument|null>>({})
 const [rows,setRows]=useState<AlarmEvent[]>([]),[cursor,setCursor]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false)
 const [purge,setPurge]=useState(false)
 const [detail,setDetail]=useState<{id:string;stageId?:string;intent?:AckDisposition}|null>(null)
 const [bulk,setBulk]=useState<{phase:'asking'|'working';items:AckItem[];key:string;scope:string;uncertain?:boolean}|null>(null),[bulkResult,setBulkResult]=useState('')
 const [singleAttempts,setSingleAttempts]=useState<Record<string,PendingAcknowledgement>>({})
 const loadRequest=useRef(0)
 const [automaticReview,setAutomaticReview]=useState(false)
 const [reference,setReference]=useState<{active:boolean;counts:Record<string,number>}|null>(null)
 useEffect(()=>{let active=true;const poll=()=>{if(document.hidden)return;void alarmEventService.summary().then(r=>{if(active){setReference(r.reference??null);setAutomaticReview(r.automatic_review?.mode==='confirm_only')}}).catch(()=>{if(active){setReference(null);setAutomaticReview(false)}})};poll();const timer=setInterval(poll,15000);return()=>{active=false;clearInterval(timer)}},[])
 const [today,setToday]=useState<Record<string,number>|null>(null)
 const filters=useMemo<AlarmFilters>(()=>({...(review?{disposition:review}:{}),...(channel?{channel_id:channel}:{}),...(level?{behavior:level}:{}),...(rangeFrom(range)?{from:rangeFrom(range)}:{})}),[channel,level,range,review])
 const live=useRef(true)
 useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 useEffect(()=>{
  void aiChannelService.list().then(r=>{if(live.current)setChannels(r.map(c=>({id:c.id,name:c.name})))}).catch(()=>undefined)
  void alarmTriggerService.list().then(r=>{if(live.current)setTriggers(r.items)}).catch(()=>undefined)
  void alarmDefinitionService.list().then(r=>{if(live.current)setDefinitions(r.items)}).catch(()=>undefined)
  void behaviorStatisticsService.query({from:midnight().toISOString(),to:new Date(Date.now()+60000).toISOString(),bucket:'day',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'})
   .then(r=>{if(live.current)setToday(Object.fromEntries(r.items.map(i=>[i.event_type,i.occurrences])))}).catch(()=>undefined)
 },[])
 const load=useCallback(async(more=false)=>{
  const requestId=++loadRequest.current
  setBusy(true);setError(false)
  try{const page=await alarmEventService.list(status,more?cursor??undefined:undefined,filters)
   if(!live.current||requestId!==loadRequest.current)return
   setRows(old=>more?[...new Map([...old,...page.items].map(r=>[r.alarm_id,r])).values()]:page.items);setCursor(page.next_cursor);setLoaded(true);if(!more){setBulkResult('')}}
  catch{if(live.current&&requestId===loadRequest.current)setError(true)}finally{if(live.current&&requestId===loadRequest.current)setBusy(false)}
 },[status,filters,cursor])
 useEffect(()=>{setRows([]);setCursor(null);setLoaded(false);void load()},[status,filters]) // eslint-disable-line react-hooks/exhaustive-deps
 // Refresh only list data. Dialogs and uncertain writes retain their snapshot.
 const scroll=useRef<HTMLDivElement>(null)
 const anchor=useRef<{id:string;top:number}|null>(null)
 const rowsRef=useRef(rows);rowsRef.current=rows
 const interaction=useRef(0)
 useLayoutEffect(()=>{
  const a=anchor.current;anchor.current=null
  if(!a||!scroll.current)return
  const node=Array.from(scroll.current.querySelectorAll<HTMLElement>('[data-alarm-id]')).find(n=>n.dataset.alarmId===a.id)
  if(node)scroll.current.scrollTop+=node.getBoundingClientRect().top-a.top
 },[rows])
 useEffect(()=>{
  let active=true,running=false
  const poll=async()=>{
   if(running||document.hidden||busy||detail||bulk||purge||Object.keys(singleAttempts).length||Date.now()-interaction.current<1500)return
   running=true;const revision=loadRequest.current
   try{
    const previous=rowsRef.current
    const page=await alarmEventService.list(status,undefined,filters)
    // Reconcile loaded history too: absence from the first page does not mean deletion.
    const retained:AlarmEvent[]=[]
    for(let offset=0;offset<previous.length;offset+=5){
     if(!active||revision!==loadRequest.current)return
     const batch=previous.slice(offset,offset+5).filter(r=>!page.items.some(n=>n.alarm_id===r.alarm_id))
     const refreshed=await Promise.all(batch.map(async r=>{
      try{return await alarmEventService.get(r.alarm_id)}
      catch(error){if((error as {status?:number}).status===404)return null;throw error}
     }))
     retained.push(...refreshed.filter((r):r is AlarmEvent=>r!==null))
    }
    if(!active||revision!==loadRequest.current||Date.now()-interaction.current<1500)return
    const matches=(r:AlarmEvent)=>
     (status!=='pending'||r.handling.state!=='acknowledged')&&
     (status!=='human'||r.handling.reviewed_by_kind==='human')&&
     (status!=='ai'||r.handling.reviewed_by_kind==='ai')&&
     (status!=='acknowledged'||r.handling.state==='acknowledged')&&
     (!review||r.handling.disposition===review)&&(!channel||r.channel_id===channel)&&(!level||r.behavior===level)&&
     (!filters.from||Date.parse(r.occurred_at)>=Date.parse(filters.from))
    const container=scroll.current
    if(container&&container.scrollTop>0){
     const node=Array.from(container.querySelectorAll<HTMLElement>('[data-alarm-id]')).find(n=>n.getBoundingClientRect().bottom>container.getBoundingClientRect().top)
     if(node)anchor.current={id:node.dataset.alarmId!,top:node.getBoundingClientRect().top}
    }
    setRows([...new Map([...retained,...page.items].filter(matches).map(r=>[r.alarm_id,r])).values()].sort((a,b)=>Date.parse(b.occurred_at)-Date.parse(a.occurred_at)||b.alarm_id.localeCompare(a.alarm_id)))
    if(previous.length===0||!retained.length)setCursor(page.next_cursor)
    setError(false)
    window.dispatchEvent(new Event('ainvr:alarms-changed'))
   }catch{/* Keep the last usable view; ordinary refresh can recover. */}finally{running=false}
  }
  const timer=setInterval(()=>void poll(),3000)
  return()=>{active=false;clearInterval(timer)}
 },[status,filters,review,channel,level,busy,detail,bulk,purge,singleAttempts])
 // Zone names come from the source's arming; read each source once while its alarms are shown.
 useEffect(()=>{
  for(const id of new Set(rows.flatMap(r=>r.input_stream_id&&!(r.input_stream_id in armings)?[r.input_stream_id]:[]))){
   setArmings(old=>({...old,[id]:null}))
   void alarmArmingService.read(id).then(r=>{if(live.current)setArmings(old=>({...old,[id]:r.arming}))}).catch(()=>undefined)
  }
 },[rows,armings])
 const triggerOf=(a:AlarmEvent):AlarmContext|undefined=>{
  const id=a.trigger_id??a.rule.id.split('@')[0]
  const definition=definitions.find(t=>t.trigger_id===id)
  if(!definition)return triggers.find(t=>t.trigger_id===id)  // alarms from earlier configurations
  const arming=a.input_stream_id?armings[a.input_stream_id]:null
  const zoneId=[...(a.stages??[])].reverse().find(s=>s.zone_id)?.zone_id
  const zone=zoneId?arming?.zones.find(z=>z.zone_id===zoneId):undefined
  const width=Number(/:(\d+)x\d+$/.exec(arming?.geometry_revision??'')?.[1])
  return {labels:definition.labels,duration_ms:definition.duration_ms,bindings:arming?[{channel_id:a.channel_id,geometry_revision:arming.geometry_revision,
   ...(definition.approach_width_percent!==undefined&&width?{approach_px:Math.round(width*definition.approach_width_percent/100)}:{}),
   zone_snapshot:zone?{name:zone.name,points:zone.points}:null}]:[]}
 }
 const channelName=(id:string)=>channels.find(c=>c.id===id)?.name??'已删除的通道'
 const activeFilter=useRef({status,review});activeFilter.current={status,review}
 const markDone=(ids:string[],disposition:AckDisposition)=>{
  // A list request started before acknowledgement must not restore stale pending rows.
  ++loadRequest.current;setBusy(false)
  const current=activeFilter.current
  setRows(old=>old.flatMap(r=>{
   if(!ids.includes(r.alarm_id))return [r]
   if(current.status==='pending'||current.status==='ai'||(current.review&&current.review!==disposition))return []
   return [{...r,handling:{...r.handling,state:'acknowledged',revision:r.handling.revision+1,reviewed_by_kind:'human' as const,disposition}}]
  }))
 }
 // Replayed acknowledgements may have been completed by another reviewer.
 const reconcile=async(items:{alarm_id:string;outcome:string}[],disposition:AckDisposition)=>{
  markDone(items.filter(i=>i.outcome==='succeeded').map(i=>i.alarm_id),disposition)
  for(const item of items.filter(i=>i.outcome==='already_acknowledged')){
   try{const actual=await alarmEventService.get(item.alarm_id);if(!live.current)return
    const current=activeFilter.current
    setRows(old=>old.flatMap(r=>r.alarm_id!==item.alarm_id?[r]:
     (current.status==='pending'&&actual.handling.state==='acknowledged')||
     (current.status==='human'&&actual.handling.reviewed_by_kind!=='human')||
     (current.status==='ai'&&actual.handling.reviewed_by_kind!=='ai')||
     (current.review&&actual.handling.disposition!==current.review)?[]:[actual]))
   }catch{setError(true)}
  }
 }
 const confirmOne=async(a:AlarmEvent,note:string,disposition:AckDisposition)=>{
  const attempt=singleAttempts[a.alarm_id]??{items:[{alarm_id:a.alarm_id,expected_handling_revision:a.handling.revision}],note,disposition,key:newAlarmOperationId()}
  setSingleAttempts(old=>({...old,[a.alarm_id]:attempt}))
  try{const result=await alarmEventService.confirm(attempt.items,attempt.note,attempt.key,attempt.disposition)
   setSingleAttempts(old=>{const next={...old};delete next[a.alarm_id];return next})
   const ok=result.items.some(i=>i.alarm_id===a.alarm_id&&ackOk(i.outcome));if(ok)await reconcile(result.items,attempt.disposition);return ok}
  catch{return false}
 }
 const groups=[...rows.reduce((map,a)=>{const zone=a.stages?.at(-1)?.zone_id??'frame';const key=JSON.stringify([a.channel_id,zone,Math.floor(Date.parse(a.occurred_at)/60000)]);map.set(key,[...(map.get(key)??[]),a]);return map},new Map<string,AlarmEvent[]>()).entries()]
 const pending=rows.filter(r=>r.handling.state!=='acknowledged')
 const askBulk=()=>setBulk({phase:'asking',items:pending.slice(0,200).map(r=>({alarm_id:r.alarm_id,expected_handling_revision:r.handling.revision})),key:newAlarmOperationId(),scope:`${channel?channelName(channel):'全部通道'} · ${triggerBehaviors.find(b=>b.id===level)?.name??'全部级别'} · ${range==='all'?'全部时间':range==='today'?'今天':'近7天'}`})
 const confirmAll=async()=>{
  if(!bulk||bulk.phase==='working')return
  const batch=bulk;setBulk({...batch,phase:'working'})
  try{const result=await alarmEventService.confirm(batch.items,'',batch.key,'handled')
   const ok=result.items.filter(i=>ackOk(i.outcome)),conflict=result.items.filter(i=>i.outcome==='version_conflict').length,other=batch.items.length-ok.length-conflict
   await reconcile(ok,'handled')
   setBulkResult(`已确认 ${ok.length} 条${conflict?`；${conflict} 条记录已变化，请刷新后重试`:''}${other?`；${other} 条未确认，请刷新核对`:''}。`);setBulk(null)}
  catch{setBulkResult('结果未确认；再次确认会沿用同一操作，不会重复处理。');setBulk({...batch,phase:'asking',uncertain:true})}
 }
 const counts=new Map<string,number>();for(const r of rows)counts.set(r.channel_id,(counts.get(r.channel_id)??0)+1)
 const open=rows.find(r=>r.alarm_id===detail?.id)
 const maxToday=Math.max(1,...triggerBehaviors.map(b=>today?.[b.id]??0))
 return <div className="flex h-full min-h-0 flex-col gap-0 bg-surface-page md:flex-row">
  <nav aria-label="告警通道" className="flex shrink-0 flex-col border-line bg-surface md:w-56 md:border-r">
   <div className="px-5 pb-2 pt-5"><h1 className="page-title">告警列表</h1>
    <p className="mt-1.5 text-sm text-ink-subtle"><span className={`text-base font-semibold ${status==='pending'?'text-danger-700':'text-primary-600'}`}>{rows.length}{cursor?'+':''}</span> 条{status==='pending'?'未审核':status==='ai'?'已 AI 审核':status==='human'?'已人工审核':'告警'}（已加载）</p></div>
   <div className="flex gap-1 overflow-x-auto p-3 md:flex-col">{[{id:'',name:'全部通道'},...channels].map(c=><button key={c.id||'all'} type="button" aria-pressed={channel===c.id} onClick={()=>setChannel(c.id)}
    className={`flex !min-h-11 shrink-0 items-center justify-between gap-2 rounded-base px-3 py-2 text-left text-sm ${channel===c.id?'bg-primary-50 font-medium text-primary-600':'text-ink-subtle hover:bg-surface-hover'}`}>
    <span className="truncate">{c.name}</span><span className="text-sm text-ink-subtle">{c.id?counts.get(c.id)??'':rows.length||''}</span></button>)}</div>
   <aside aria-label="今日概况" className="mx-3 mb-3 mt-auto hidden rounded-panel border border-line p-3 md:block"><h2 className="mb-2 text-sm font-semibold">今天行为记录</h2>
    <div className="space-y-2">{[...triggerBehaviors].reverse().map(b=><div key={b.id}><div className="flex justify-between text-sm"><span>{b.name}</span><span className="tabular-nums">{today?.[b.id]??0}</span></div>
     <div className="mt-1 h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded" style={{width:`${Math.round((today?.[b.id]??0)/maxToday*100)}%`,background:levelLook[b.id]!.color}}/></div></div>)}</div>
    {!today&&<p className="mt-2 text-xs text-ink-subtle">统计暂不可用</p>}
   </aside>
   <p className="hidden border-t border-line p-4 text-sm leading-relaxed text-ink-subtle md:block">同一通道的同一目标只有一条告警，显示命中的最高级别。</p>
  </nav>
  <main className="alarm-workspace flex min-w-0 flex-1 flex-col">
   <div className="space-y-3 px-4 pb-3 pt-4 md:px-6">
    <div className="flex flex-wrap items-center gap-3">
     <div role="group" aria-label="处理状态" className="flex gap-1 rounded-base border border-line bg-surface p-1">{([['pending','未审核'],['human','已人工审核'],['ai','已 AI 审核'],['all','全部']] as const).map(([id,label])=>
      <button key={id} type="button" aria-pressed={status===id} onClick={()=>pickStatus(id)} className={`!min-h-11 rounded-base px-3 py-1.5 text-sm ${status===id?'bg-primary-50 font-medium text-primary-600':'text-ink-subtle'}`}>{label}</button>)}</div>
     <label className="flex items-center gap-2 text-sm text-ink-subtle">结论<select aria-label="审核结论" disabled={status==='pending'} title={status==='pending'?'未审核告警尚无确认或误报结论':undefined} value={review} onChange={e=>setReview(e.target.value)} className="form-input !min-h-11 w-auto"><option value="">全部</option><option value="handled">确认</option><option value="false_positive">误报</option></select></label>
     <label className="flex items-center gap-2 text-sm text-ink-subtle">时间<select value={range} onChange={e=>{rangeTouched.current=true;setRange(e.target.value as Range)}} className="form-input !min-h-11 w-auto py-1.5"><option value="today">今天</option><option value="7d">近 7 天</option><option value="all">全部</option></select></label>
     {status!=='acknowledged'&&pending.length>0&&<button type="button" disabled={!!bulk} onClick={askBulk} className={`btn-secondary !min-h-11 ml-auto`}>确认已加载（{Math.min(200,pending.length)}）</button>}
     <button type="button" disabled={!!bulk||purge} onClick={()=>setPurge(true)} className="btn-secondary !min-h-11 text-danger-700">清空所有告警</button>
    </div>
    <div role="group" aria-label="级别" className="flex flex-wrap gap-2">{[{id:'',name:'全部级别'},...triggerBehaviors].map(b=><button key={b.id||'all'} type="button" aria-pressed={level===b.id} onClick={()=>setLevel(b.id)} className={pill}>
     <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{background:b.id?levelLook[b.id]!.color:'#cbd5e1'}}/>{b.name}</button>)}</div>
    {bulk&&<AlarmConfirmation busy={bulk.phase==='working'} close={()=>setBulk(null)}><div role="group" aria-label="确认全部" className="flex flex-wrap items-center justify-end gap-3 text-sm"><p className="basis-full leading-relaxed"><strong>{bulk.scope}</strong>：确认这批已加载的 {bulk.items.length} 条告警？切换筛选不会改变此批次，行为统计不受影响。</p>
     {bulk.uncertain&&<p role="status" className="basis-full text-warning-700">上次结果未确认；重试沿用原批次，不会重复处理。</p>}
     <button type="button" disabled={bulk.phase==='working'} onClick={()=>setBulk(null)} className="btn-secondary !min-h-11">{bulk.uncertain?'关闭并稍后核对':'取消'}</button>
     <button type="button" disabled={bulk.phase==='working'} onClick={()=>void confirmAll()} className="btn-primary !min-h-11">{bulk.phase==='working'?'处理中…':`确认这 ${bulk.items.length} 条`}</button></div></AlarmConfirmation>}
    {bulkResult&&!bulk&&<p role="status">{bulkResult}</p>}
    {automaticReview&&<p role="status" className="text-sm text-ink-subtle">AI 自动审核已启用：优先处理最新告警，关键帧判断一致时自动确认并移入“已 AI 审核”。疑似误报、证据不足或判断冲突保留人工审核；模型准确率尚未全面验证，可人工改判。</p>}
    {!automaticReview&&reference&&<p role="status" className="text-sm text-ink-subtle">AI 参考分析：{reference.active?'后台运行中':'后台未运行'} · 已分析 {reference.counts.completed??0} · 分析中 {reference.counts.running??0} · 待分析 {(reference.counts.waiting??0)+(reference.counts.queued??0)} · 无法分析 {reference.counts.failed??0}。优先分析最新未审核告警；模型待验证，参考分数不改变审核结论。</p>}
   </div>
   <div ref={scroll} onPointerDownCapture={()=>{interaction.current=Date.now()}} onKeyDownCapture={()=>{interaction.current=Date.now()}} aria-busy={busy} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4 md:px-6">
    {error&&<p role="alert">告警读取失败，请重试当前筛选。<button className="btn-secondary ml-2" onClick={()=>void load()}>重试</button></p>}
    {loaded&&!rows.length&&<p className="py-10 text-center text-ink-subtle">{cursor?'本批已处理完，可继续加载更早的未审核告警。':'当前筛选下没有告警。'}</p>}
    {!!rows.length&&<div aria-label="告警记录" className="shrink-0 overflow-hidden rounded-panel border border-line bg-surface">{groups.map(([key,items])=>{const content=items.map(a=><div key={a.alarm_id} data-alarm-id={a.alarm_id}><AlarmRow alarm={a} trigger={triggerOf(a)} channelName={channelName(a.channel_id)} onOpen={stageId=>setDetail({id:a.alarm_id,stageId})} onHandle={intent=>setDetail({id:a.alarm_id,intent})}/></div>);return items.length===1?<div key={key}>{content}</div>:<details key={key} open className="border-b border-line"><summary className="min-h-11 cursor-pointer bg-surface-subtle px-3 py-2 text-sm">{channelName(items[0]!.channel_id)} · 同一区域一分钟内 {items.length} 条告警（分别审核）</summary>{content}</details>})}</div>}
    {busy&&<p role="status" className="text-center text-sm text-ink-subtle">正在读取…</p>}
    {cursor&&!busy&&<button type="button" onClick={()=>void load(true)} className="btn-secondary mx-auto">加载更早的告警</button>}
   </div>
  </main>
  {purge&&<AlarmPurgeDialog close={()=>setPurge(false)} cleared={count=>{
   setPurge(false);setDetail(null);setSingleAttempts({});
   window.dispatchEvent(new Event('ainvr:alarms-changed'))
   void load().then(()=>{setBulkResult(`已清空 ${count} 条告警，录像和流量统计保留。`);void alarmEventService.summary().then(r=>setReference(r.reference??null)).catch(()=>undefined)})
  }}/>}
  {open&&<AlarmSheet key={`${open.alarm_id}:${detail?.intent??'details'}`} id={open.alarm_id} pendingAttempt={singleAttempts[open.alarm_id]} intent={detail?.intent?singleAttempts[open.alarm_id]?.disposition??detail.intent:undefined} initialStageId={detail?.stageId} channelName={channelName(open.channel_id)} trigger={triggerOf(open)} close={()=>setDetail(null)} confirm={confirmOne}/>}
 </div>
}
