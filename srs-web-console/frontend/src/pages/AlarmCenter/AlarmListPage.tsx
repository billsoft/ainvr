import {useLocation} from 'react-router-dom'
import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {alarmEventService,type AlarmEvent,type AckDisposition,type AlarmFilters} from '@/api/alarmEventService'
import {aiChannelService} from '@/api/aiChannelService'
import {alarmTriggerService} from '@/api/alarmTriggerService'
import {alarmDefinitionService} from '@/api/alarmDefinitionService'
import {alarmArmingService} from '@/api/alarmArmingService'
import type {ArmingDocument} from '@/features/armingDocument'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
import {behaviorStatisticsService} from '@/api/behaviorStatisticsService'
import {newAlarmOperationId} from '@/api/alarmZoneService'
import {behaviorNames,levelLook,triggerBehaviors,type AlarmTrigger} from '@/features/alarmTriggers'
import {describeAlarm,type AlarmContext} from '@/features/alarmSentences'
import {formatRelativeTime} from '@/utils/format'
import {EvidenceThumb} from './EvidenceThumb'
import {AlarmSheet} from './AlarmSheet'

// Alarm feed: one card per target activity (highest level), newest first, like the
// recognition history. Touch first: every control is at least 44 px.
type Status='pending'|'acknowledged'|'all'
type Range='today'|'7d'|'all'
const pill='btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
const clock=(v:string)=>new Date(v).toLocaleTimeString('zh-CN',{hour12:false})
const midnight=()=>{const d=new Date();d.setHours(0,0,0,0);return d}
function rangeFrom(range:Range){return range==='today'?midnight().toISOString():range==='7d'?new Date(Date.now()-7*86400000).toISOString():undefined}
const ackOk=(outcome:string)=>['succeeded','already_acknowledged'].includes(outcome)

function FeedCard({alarm,trigger,channelName,onConfirm,onOpen}:{alarm:AlarmEvent;trigger:AlarmContext|undefined;channelName:string;onConfirm:(d:AckDisposition)=>Promise<boolean>;onOpen:()=>void}){
 const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false)
 const described=describeAlarm(alarm,trigger),look=levelLook[alarm.behavior]??levelLook.appearance!
 const done=alarm.handling.state==='acknowledged',live=alarm.lifecycle.state==='active'
 const act=async(d:AckDisposition)=>{if(busy)return;setBusy(true);setFailed(false);try{if(!await onConfirm(d))setFailed(true)}finally{setBusy(false)}}
 const shots=(alarm.stages??[]).filter(s=>s.behavior_event_ids?.[0]).slice(-4)
 return <article className={`ui-panel p-4 shadow-card ${done?'opacity-75':''}`}>
  <header className="flex items-center gap-3">
   <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-slate-800 text-slate-300">◉</span>
   <div className="min-w-0 flex-1">
    <div className="truncate text-sm font-semibold text-ink">{channelName}{described.zone&&<span className="font-normal text-ink-subtle"> · {described.zone}</span>}</div>
    <div className="truncate text-xs text-ink-subtle">{clock(alarm.occurred_at)} · {formatRelativeTime(Date.parse(alarm.occurred_at)/1000)} · 触发器「{alarm.rule.name}」</div>
   </div>
   {live&&<span className="flex items-center gap-1.5 text-xs font-medium text-success-700"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-success"/>进行中</span>}
   <span className="rounded-full border px-2.5 py-0.5 text-xs font-semibold" style={{background:look.soft,color:look.ink,borderColor:look.color}}>{behaviorNames[alarm.behavior]??alarm.behavior}</span>
  </header>
  <p className="mt-3 text-sm leading-6 text-ink">{described.sentence}</p>
  {!!alarm.stages?.length&&<ol aria-label="阶段" className="mt-3 flex flex-wrap gap-1.5">{alarm.stages.map(s=>{const top=s.behavior===alarm.behavior
   return <li key={s.event_id} className="rounded-full px-2.5 py-1 text-xs font-medium" style={top?{background:look.color,color:'#fff'}:{background:'#f1f5f9',color:'#334155'}}>{behaviorNames[s.behavior]??s.behavior}<span className="font-normal opacity-85"> {clock(s.at)}</span></li>})}</ol>}
  {!!shots.length&&<div className="mt-3 grid grid-cols-4 gap-2">{shots.map(s=><EvidenceThumb key={s.event_id} eventId={s.behavior_event_ids![0]!} label={behaviorNames[s.behavior]??s.behavior} onOpen={onOpen}/>)}</div>}
  <footer className="mt-3.5 flex flex-wrap items-center gap-2.5">
   {done?<span role="status" className="text-sm text-success-700">{alarm.handling.disposition==='false_positive'?'已标记误报':'已确认'}{alarm.handling.acknowledged_by?` · ${alarm.handling.acknowledged_by}`:''}</span>:<>
    <button type="button" disabled={busy} onClick={()=>void act('handled')} className="btn-primary">确认已处理</button>
    <button type="button" disabled={busy} onClick={()=>void act('false_positive')} className="btn-secondary">标记误报</button></>}
   <button type="button" onClick={onOpen} className="btn-secondary">详情与录像</button>
   {failed&&<span role="alert" className="text-sm text-danger-700">结果未确认，请重试或刷新核对</span>}
  </footer>
 </article>
}
export default function AlarmListPage(){
 // Unhandled alarms are never hidden by the clock: pending defaults to all time,
 // handled history defaults to today, until the user picks a range.
 const [status,setStatus]=useState<Status>('pending'),[level,setLevel]=useState(''),[channel,setChannel]=useState(''),[range,setRange]=useState<Range>('all')
 const rangeTouched=useRef(false)
 const location=useLocation()
 useEffect(()=>{
  const params=new URLSearchParams(location.search)
  if(params.get('status')==='pending'&&params.get('range')==='all'){
   setStatus('pending');setRange('all');setChannel('');setLevel('');rangeTouched.current=false
  }
 },[location.key,location.search])
 const pickStatus=(next:Status)=>{setStatus(next);if(!rangeTouched.current)setRange(next==='pending'?'all':'today')}
 const [channels,setChannels]=useState<{id:string;name:string}[]>([]),[triggers,setTriggers]=useState<AlarmTrigger[]>([])
 const [definitions,setDefinitions]=useState<TriggerDefinition[]>([]),[armings,setArmings]=useState<Record<string,ArmingDocument|null>>({})
 const [rows,setRows]=useState<AlarmEvent[]>([]),[cursor,setCursor]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false)
 const [fresh,setFresh]=useState(0),[detail,setDetail]=useState<string|null>(null)
 const [bulk,setBulk]=useState<'asking'|'working'|null>(null),[bulkResult,setBulkResult]=useState(''),bulkKey=useRef<string|null>(null)
 const [today,setToday]=useState<Record<string,number>|null>(null)
 const filters=useMemo<AlarmFilters>(()=>({...(channel?{channel_id:channel}:{}),...(level?{behavior:level}:{}),...(rangeFrom(range)?{from:rangeFrom(range)}:{})}),[channel,level,range])
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
  setBusy(true);setError(false)
  try{const page=await alarmEventService.list(status,more?cursor??undefined:undefined,filters)
   if(!live.current)return
   setRows(old=>more?[...new Map([...old,...page.items].map(r=>[r.alarm_id,r])).values()]:page.items);setCursor(page.next_cursor);setLoaded(true);if(!more){setFresh(0);setBulkResult('')}}
  catch{if(live.current)setError(true)}finally{if(live.current)setBusy(false)}
 },[status,filters,cursor])
 useEffect(()=>{void load()},[status,filters]) // eslint-disable-line react-hooks/exhaustive-deps
 // Newer alarms are announced, not pushed into the feed under the user's finger.
 useEffect(()=>{const timer=setInterval(()=>{if(document.hidden)return
  void alarmEventService.list(status,undefined,filters).then(page=>{if(live.current)setFresh(page.items.filter(i=>!rows.some(r=>r.alarm_id===i.alarm_id)).length)}).catch(()=>undefined)},15000)
  return()=>clearInterval(timer)},[status,filters,rows])
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
 const markDone=(ids:string[],disposition:AckDisposition)=>setRows(old=>old.map(r=>ids.includes(r.alarm_id)?{...r,handling:{...r.handling,state:'acknowledged',disposition}}:r))
 const confirmOne=async(a:AlarmEvent,note:string,disposition:AckDisposition)=>{
  try{const result=await alarmEventService.confirm([{alarm_id:a.alarm_id,expected_handling_revision:a.handling.revision}],note,newAlarmOperationId(),disposition)
   const ok=result.items.some(i=>i.alarm_id===a.alarm_id&&ackOk(i.outcome));if(ok)markDone([a.alarm_id],disposition);return ok}
  catch{return false}
 }
 const pending=rows.filter(r=>r.handling.state!=='acknowledged')
 const confirmAll=async()=>{
  const items=pending.slice(0,200).map(r=>({alarm_id:r.alarm_id,expected_handling_revision:r.handling.revision}))
  bulkKey.current??=newAlarmOperationId();setBulk('working')
  try{const result=await alarmEventService.confirm(items,'',bulkKey.current,'handled');bulkKey.current=null
   const ok=result.items.filter(i=>ackOk(i.outcome)),conflict=result.items.filter(i=>i.outcome==='version_conflict').length,other=items.length-ok.length-conflict
   markDone(ok.map(i=>i.alarm_id),'handled')
   setBulkResult(`已确认 ${ok.length} 条${conflict?`；${conflict} 条记录已变化，请刷新后重试`:''}${other?`；${other} 条未确认，请刷新核对`:''}。`);setBulk(null)}
  catch{setBulkResult('结果未确认；再次确认会沿用同一操作，不会重复处理。');setBulk('asking')}
 }
 const counts=new Map<string,number>();for(const r of pending)counts.set(r.channel_id,(counts.get(r.channel_id)??0)+1)
 const open=rows.find(r=>r.alarm_id===detail)
 const maxToday=Math.max(1,...triggerBehaviors.map(b=>today?.[b.id]??0))
 return <div className="flex h-full min-h-0 flex-col gap-0 bg-surface-page md:flex-row">
  <nav aria-label="告警通道" className="flex shrink-0 flex-col border-line bg-surface md:w-56 md:border-r">
   <div className="px-5 pb-2 pt-5"><h1 className="page-title">告警列表</h1>
    <p className="mt-1.5 text-sm text-ink-subtle"><span className="text-base font-semibold text-danger-700">{pending.length}{cursor?'+':''}</span> 条待处理（已加载）</p></div>
   <div className="flex gap-1 overflow-x-auto p-3 md:flex-col">{[{id:'',name:'全部通道'},...channels].map(c=><button key={c.id||'all'} type="button" aria-pressed={channel===c.id} onClick={()=>setChannel(c.id)}
    className={`flex shrink-0 items-center justify-between gap-2 rounded-base px-3 py-2 text-left text-sm ${channel===c.id?'bg-primary-50 font-medium text-primary-600':'text-ink-subtle hover:bg-surface-hover'}`}>
    <span className="truncate">{c.name}</span><span className="text-sm text-ink-subtle">{c.id?counts.get(c.id)??'':pending.length||''}</span></button>)}</div>
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
     <div role="group" aria-label="处理状态" className="flex gap-1 rounded-base border border-line bg-surface p-1">{([['pending','待确认'],['acknowledged','已确认'],['all','全部']] as const).map(([id,label])=>
      <button key={id} type="button" aria-pressed={status===id} onClick={()=>pickStatus(id)} className={`rounded-base px-3 py-1.5 text-sm ${status===id?'bg-primary-50 font-medium text-primary-600':'text-ink-subtle'}`}>{label}</button>)}</div>
     <label className="flex items-center gap-2 text-sm text-ink-subtle">时间<select value={range} onChange={e=>{rangeTouched.current=true;setRange(e.target.value as Range)}} className="form-input w-auto py-1.5"><option value="today">今天</option><option value="7d">近 7 天</option><option value="all">全部</option></select></label>
     {fresh>0&&<button type="button" onClick={()=>void load()} className="btn-primary ml-auto">新告警 {fresh} 条 · 点击刷新</button>}
     {status!=='acknowledged'&&pending.length>0&&!bulk&&<button type="button" onClick={()=>setBulk('asking')} className={`btn-secondary ${fresh>0?'':'ml-auto'}`}>全部确认（{Math.min(200,pending.length)}）</button>}
    </div>
    <div role="group" aria-label="级别" className="flex flex-wrap gap-2">{[{id:'',name:'全部级别'},...triggerBehaviors].map(b=><button key={b.id||'all'} type="button" aria-pressed={level===b.id} onClick={()=>setLevel(b.id)} className={pill}>
     <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{background:b.id?levelLook[b.id]!.color:'#cbd5e1'}}/>{b.name}</button>)}</div>
    {bulk&&<div role="group" aria-label="确认全部" className="ui-panel flex flex-wrap items-center gap-3 p-3 text-sm">把已加载的 {Math.min(200,pending.length)} 条告警都标为已处理？行为统计不受影响。
     <button type="button" disabled={bulk==='working'} onClick={()=>void confirmAll()} className="btn-primary">{bulk==='working'?'处理中…':`确认这 ${Math.min(200,pending.length)} 条`}</button>
     <button type="button" disabled={bulk==='working'} onClick={()=>{setBulk(null);bulkKey.current=null}} className="btn-secondary">取消</button></div>}
    {bulkResult&&<p role="status">{bulkResult}</p>}
   </div>
   <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6 md:px-6">
    {error&&<p role="alert">告警读取失败，已加载的记录保留。<button className="btn-secondary ml-2" onClick={()=>void load()}>重试</button></p>}
    {loaded&&!rows.length&&<p className="py-10 text-center text-ink-subtle">当前筛选下没有告警。</p>}
    {rows.map(a=><FeedCard key={a.alarm_id} alarm={a} trigger={triggerOf(a)} channelName={channelName(a.channel_id)} onOpen={()=>setDetail(a.alarm_id)} onConfirm={d=>confirmOne(a,'',d)}/>)}
    {busy&&<p role="status" className="text-center text-sm text-ink-subtle">正在读取…</p>}
    {cursor&&!busy&&<button type="button" onClick={()=>void load(true)} className="btn-secondary mx-auto">加载更早的告警</button>}
   </div>
  </main>
  {open&&<AlarmSheet id={open.alarm_id} channelName={channelName(open.channel_id)} trigger={triggerOf(open)} close={()=>setDetail(null)} confirm={confirmOne}/>}
 </div>
}
