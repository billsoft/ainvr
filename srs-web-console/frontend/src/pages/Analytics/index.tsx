import { CalendarClock, ChevronDown, Download, Info, RefreshCw, ScanSearch, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { alarmEventService, type AlarmStatistics } from '@/api/alarmEventService'
import { flowService, type Counter, type CounterResult } from '@/api/flowService'
import { DateTimeRangePicker } from '@/components/ui/DateTimeRangePicker'
import { field, fieldSelect, segment, segmented } from '@/components/ui/filterStyles'
import { labelDisplay } from '@/features/labelNames'
import { periodSlots } from '@/pages/Flow/FlowChart'
import { RecordsDrawer } from '@/pages/Flow/RecordsDrawer'
import { rangeOf, validateCustomRange, type CustomRange, type Preset } from '@/pages/Flow/flowRange'
import { toDatetimeLocalValue } from '@/utils/timeRange'
import { bucketComplete, bucketValue, changeText, complete, counterUnit, measured, queryFlow, scopeKey, selectedRows, statGroups, sumKnown, toCsv, totalsOf, weekPattern, weekWindow, weekdayNames, type Location, type Row, type Slot } from './analyticsSource'
import { PlanPanel } from './plan/PlanPanel'
import { TrendChart } from './TrendChart'
import { WeekHourPanel } from './WeekHourPanel'
import { DwellPanel } from './DwellPanel'
import type { HeatVariant } from './RegionHeatPanel'
import { zoneKey, type MapReading, type ZoneInfo } from './plan/planModel'
import { useAnalyticsLink, type ChoiceSummary, type StatChoice } from './analyticsLinkContext'
import { formatRangeLabel } from '@/pages/Flow/counterText'

const button = 'btn-secondary !min-h-7 !px-2.5 !py-1 text-xs aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary [@media(pointer:coarse)]:!min-h-11'
const presets = [['today','今天'],['yesterday','昨天'],['7d','近 7 天'],['30d','近 30 天']] as const
type Result = {items:CounterResult[]}
const coverageName = (state:string|undefined) => ({complete:'完整',partial:'部分覆盖',no_data:'无覆盖',unknown:'未知'}[state??'unknown']??'未知')
const fmt = (n:number|null) => n === null ? '—' : n.toLocaleString('zh-CN', {maximumFractionDigits:1})
const signed = (n:number) => (n > 0 ? '+' : '') + fmt(n)
function parseIds(value:string|null):string[]|null { if(value===null)return null;try{const v:unknown=JSON.parse(value);return Array.isArray(v)&&v.every(x=>typeof x==='string')?v:[]}catch{return []} }
function initialCustom(params:URLSearchParams):CustomRange|null {const a=params.get('from'),b=params.get('to');if(!a||!b)return null;const from=new Date(a),to=new Date(new Date(b).getTime()-1000);return validateCustomRange(from,to)===null?{from,to}:null}
function whyCoverage(row:Row) {
  const c=row.zone.in?.coverage, ratio=measured(c)
  if (c?.qualifier === 'applicability_history_incomplete') return '适用时段历史不完整，覆盖未知'
  if (c?.qualifier === 'observation_intervals_unavailable') return '观测时段未知'
  if (ratio !== null) return `${(ratio*100).toFixed(1)}%（${coverageName(c?.state)}）`
  if (c?.expected_ms === 0) return '不适用'
  return `未知（${coverageName(c?.state)}）`
}
function comparison(now:number|null, before:number|null, valid:boolean, label:string) {
  if (!valid || now === null || before === null) return `${label}：覆盖不完整或未知，不计算变化率（已记录 ${fmt(before)}）`
  if (before === 0) return now === 0 ? '两期均无通行' : `较${label}新增 ${fmt(now)} 次（基期为零）`
  return `较${label} ${((now-before)/before*100).toFixed(1)}%`
}
function Kpi({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return <div role="group" aria-label={label} className="ui-panel flex min-w-0 flex-col justify-center px-3 py-1.5">
    <span className="text-[11px] text-ink-subtle">{label}</span>
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <strong className="text-xl font-semibold leading-7 tabular-nums text-ink">{value}</strong>{children}
    </div>
  </div>
}
const totalValue = (key:string) => 'total:' + key
/** Alarm analysis moved to 告警分析; an old statistics link opens it with the same period, places and filters. */
export function alarmAnalysisSearch(old:URLSearchParams):string {
  const p=new URLSearchParams({view:'analysis'})
  const copy=(from:string,to=from)=>{const v=old.get(from);if(v!==null)p.set(to,v)}
  copy('range');copy('compare');copy('from','afrom');copy('to','ato');copy('alarm_locations');copy('alarm_scope_origin');copy('trigger_id','rule');copy('event_kind');copy('primary_type')
  if(old.get('alarm_tab')==='quality')p.set('alarm_tab','quality')
  return p.toString()
}
export default function AnalyticsPage() {
  const [params]=useSearchParams()
  return params.get('subject')==='alarms'?<Navigate replace to={'/alarms?'+alarmAnalysisSearch(params)}/>:<FlowAnalyticsPage/>
}
function FlowAnalyticsPage() {
  const link=useAnalyticsLink()
  const [params,setParams]=useSearchParams()
  const preset=(presets.find(p=>p[0]===params.get('range'))?.[0] ?? 'today') as Preset
  const initialParams=useRef(new URLSearchParams(params))
  const [custom,setCustom]=useState<CustomRange|null>(()=>initialCustom(initialParams.current)),[picker,setPicker]=useState<{from:string;to:string}|null>(null)
  const [counters,setCounters]=useState<Counter[]|null>(null),[counterIds,setCounterIds]=useState<string[]>([]),[bindings,setBindings]=useState<string[]>([])
  const [view,setView]=useState<'trend'|'rank'>('trend')
  const [slotIndex,setSlotIndex]=useState<number|null>(null),[recordBinding,setRecordBinding]=useState('')
  const [compare,setCompare]=useState(()=>initialParams.current.get('compare')!=='0'),[revision,setRevision]=useState(0),[now,setNow]=useState(()=>new Date())
  const [current,setCurrent]=useState<Result|null>(null),[previous,setPrevious]=useState<Result|null>(null),[week,setWeek]=useState<Result|null>(null),[totals,setTotals]=useState<CounterResult[]|null>(null),[previousTotals,setPreviousTotals]=useState<CounterResult[]|null>(null)
  const [error,setError]=useState(''),[configError,setConfigError]=useState(''),[previousError,setPreviousError]=useState(''),[weekError,setWeekError]=useState(''),[loading,setLoading]=useState(false)
  const [alarm,setAlarm]=useState<AlarmStatistics|null>(null),[alarmError,setAlarmError]=useState('')
  const [drawer,setDrawer]=useState<{result:CounterResult;bindingId?:string;output:'in'|'out';from:string;to:string}|null>(null)
  const [mapEditing,setMapEditing]=useState(false),[observing,setObserving]=useState(false)
  const [observationActive,setObservationActive]=useState(false)
  const [activeZone,setActiveZone]=useState<string|null>(null)
  const [sourceHeat,setSourceHeat]=useState<{zoneKey:string;variant:HeatVariant}|null>(null)
  const receiveHeat=useCallback((zoneKey:string,variant:HeatVariant|null)=>setSourceHeat(old=>variant?old?.zoneKey===zoneKey&&old.variant===variant?old:{zoneKey,variant}:old?.zoneKey===zoneKey?null:old),[])
  const selectionRef=useRef({counterIds,bindings});selectionRef.current={counterIds,bindings}
  const initialized=useRef(false)
  const currentVersion=useRef(0),shownIds=useRef(''),priorKey=useRef(''),weekIds=useRef('')
  const range=useMemo(()=>rangeOf(custom?'custom':preset,now,custom),[custom,preset,now])
  const window4=useMemo(()=>weekWindow(now),[now])
  const selectedCounters=useMemo(()=>(counters??[]).filter(c=>counterIds.includes(c.counter_id)),[counters,counterIds])
  const groups=useMemo(()=>statGroups(counters??[]),[counters])
  const unit=selectedCounters[0]?counterUnit(selectedCounters[0]):'次'
  const vehicles=unit==='车次'
  const names=selectedCounters[0]?.names??{in:'进入',out:'离开'}
  const both=selectedCounters[0]?.outputs!=='in'
  const choice:StatChoice|null=counterIds.length===1?{kind:'counter',id:counterIds[0]!}:selectedCounters[0]?{kind:'total',key:scopeKey(selectedCounters[0])}:null
  const choiceName=choice?.kind==='counter'?selectedCounters[0]?.name??'':choice?`合计（${counterIds.length} 个）`:''
  const selected:Location[]=useMemo(()=>selectedCounters.flatMap(c=>c.bindings.filter(b=>bindings.includes(b.binding_id)).map(b=>({counterId:c.counter_id,bindingId:b.binding_id}))),[selectedCounters,bindings])
  const rows=useMemo(()=>selectedRows(current?.items ?? [],selected),[current,selected])
  const prior=useMemo(()=>selectedRows(previous?.items ?? [],selected),[previous,selected])
  const weekly=useMemo(()=>selectedRows(week?.items ?? [],selected),[week,selected])
  const query:Slot={from:range.from.toISOString(),to:range.to.toISOString()}
  const slots=useMemo(()=>periodSlots(range.from,range.to,range.bucket),[range])
  const locations=useMemo(()=>Array.from(new Map(selectedCounters.flatMap(c=>c.bindings.filter(b=>bindings.includes(b.binding_id)).map(b=>[b.processor_id+'\u0000'+b.zone_id,{channel_id:b.processor_id,zone_id:b.zone_id}] as const))).values()),[selectedCounters,bindings])
  const dwellLocations=useMemo(()=>locations.map(l=>({...l,name:rows.find(r=>r.zone.processor_id===l.channel_id&&r.zone.zone_id===l.zone_id)?.zone.zone_name||l.zone_id})),[locations,rows])
  const dwellLabels=useMemo(()=>selectedCounters[0]?.labels.map(l=>l.label_id)??[],[selectedCounters])
  const alarmScopeValid=locations.length>0&&locations.length<=100&&JSON.stringify(locations).length<=4096
  // Router updaters see the params of the last render, so two writes before the next render (the selection
  // sync and a tab click) would overwrite each other. Every write builds on the newest pending one instead.
  const pendingParams=useRef<URLSearchParams|null>(null)
  useEffect(()=>{pendingParams.current=null},[params])
  const updateParams=useCallback((change:(p:URLSearchParams)=>void)=>{
    const base=pendingParams.current??params,next=new URLSearchParams(base);change(next)
    if(next.toString()===base.toString())return
    pendingParams.current=next;setParams(next,{replace:true})
  },[params,setParams])
  const setParam=(key:string,value:string)=>updateParams(p=>p.set(key,value))
  useEffect(()=>{
    let live=true;setConfigError('')
    void flowService.list({includeInactiveBindings:true}).then(r=>{
      if(!live)return
      const requested=initialized.current?selectionRef.current.counterIds:parseIds(initialParams.current.get('counters'))
      const requestedBindings=initialized.current?selectionRef.current.bindings:parseIds(initialParams.current.get('bindings'))
      const usable=r.items.filter(c=>!c.deleting)
      // Old vehicle-analysis links open on the first vehicle statistic.
      const legacyVehicle=!initialized.current&&requested===null&&initialParams.current.get('subject')==='vehicles'?usable.find(c=>counterUnit(c)==='车次'):undefined
      const first=legacyVehicle??usable.find(c=>requested===null||requested.includes(c.counter_id))
      const chosen=first?usable.filter(c=>(requested===null?c.counter_id===first.counter_id:requested.includes(c.counter_id))&&scopeKey(c)===scopeKey(first)).slice(0,50):[]
      setCounters(r.items);setCounterIds(chosen.map(c=>c.counter_id))
      setBindings(chosen.flatMap(c=>c.bindings.filter(b=>requestedBindings===null||legacyVehicle?b.active:requestedBindings.includes(b.binding_id)).map(b=>b.binding_id)))
      initialized.current=true
    }).catch(e=>{if(live)setConfigError(e instanceof Error?e.message:'统计读取失败')})
    return()=>{live=false}
  },[revision,link.reload])
  useEffect(()=>{if(!counters)return;updateParams(next=>{if(next.get('subject')==='vehicles')next.delete('subject');next.delete('tab');next.set('counters',JSON.stringify(counterIds));next.set('bindings',JSON.stringify(bindings));next.set('compare',compare?'1':'0');if(custom){next.set('from',custom.from.toISOString());next.set('to',new Date(custom.to.getTime()+1000).toISOString())}else{next.delete('from');next.delete('to')}})},[counters,counterIds,bindings,compare,custom,updateParams])
  // A segment picked in region observation pauses the refresh only while that panel is open; closed, the screen keeps updating.
  const watchingSegment=observing&&observationActive
  useEffect(()=>{if(mapEditing||drawer||picker||watchingSegment)return;const timer=setInterval(()=>{if(!document.hidden){setNow(new Date())}},60000);return()=>clearInterval(timer)},[mapEditing,drawer,picker,watchingSegment])
  useEffect(()=>{
    const id=++currentVersion.current,key=JSON.stringify(counterIds)
    if(!counterIds.length){setCurrent(null);setLoading(false);shownIds.current='';return}
    // Same statistic, newer time: keep the screen as it is until the new answer arrives.
    if(shownIds.current!==key){setCurrent(null);shownIds.current=key}
    setLoading(true);setError('')
    void queryFlow(range.from,range.to,range.bucket,counterIds).then(r=>{if(id===currentVersion.current)setCurrent(r)})
      .catch(e=>{if(id===currentVersion.current)setError(e instanceof Error?e.message:'统计读取失败')})
      .finally(()=>{if(id===currentVersion.current)setLoading(false)})
    return()=>{currentVersion.current++}
  },[counterIds,range])
  // Every statistic's period totals in one light query, so the column can show numbers before a choice.
  const hasCounters=!!counters?.length
  // A timed refresh keeps the numbers on screen; another period clears them, so no card shows the old period's figures.
  const periodId=custom?custom.from.getTime()+'-'+custom.to.getTime():preset
  const totalsPeriod=useRef(''),previousPeriod=useRef('')
  useEffect(()=>{
    let live=true
    if(totalsPeriod.current!==periodId){setTotals(null);totalsPeriod.current=periodId}
    if(hasCounters) void flowService.query({from:range.from.toISOString(),to:range.to.toISOString(),bucket:null,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',totals_only:true}).then(r=>{if(live)setTotals(r.items)}).catch(()=>{if(live)setTotals(null)})
    return()=>{live=false}
  },[hasCounters,periodId,range,revision,link.reload])
  useEffect(()=>{
    let live=true
    if(!compare||previousPeriod.current!==periodId){setPreviousTotals(null);previousPeriod.current=periodId}
    if(hasCounters&&compare) void flowService.query({from:range.previous.from.toISOString(),to:range.previous.to.toISOString(),bucket:null,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',totals_only:true}).then(r=>{if(live)setPreviousTotals(r.items)}).catch(()=>undefined)
    return()=>{live=false}
  },[hasCounters,periodId,compare,range,revision,link.reload])
  useEffect(()=>{
    let live=true;setPreviousError('')
    const key=JSON.stringify([compare,counterIds]);if(priorKey.current!==key){setPrevious(null);priorKey.current=key}
    if(compare&&counterIds.length) void queryFlow(range.previous.from,range.previous.to,range.bucket,counterIds).then(r=>{if(live)setPrevious(r)}).catch(e=>{if(live)setPreviousError(e instanceof Error?e.message:'对比期读取失败')})
    return()=>{live=false}
  },[compare,counterIds,range])
  useEffect(()=>{
    let live=true;setWeekError('')
    const key=JSON.stringify(counterIds);if(weekIds.current!==key){setWeek(null);weekIds.current=key}
    if(counterIds.length) void queryFlow(window4.from,window4.to,'hour',counterIds).then(r=>{if(live)setWeek(r)}).catch(e=>{if(live)setWeekError(e instanceof Error?e.message:'规律读取失败')})
    return()=>{live=false}
  },[counterIds,window4.from.getTime(),window4.to.getTime(),revision])
  useEffect(()=>{
    let live=true;setAlarm(null);setAlarmError('')
    if(!alarmScopeValid&&locations.length) setAlarmError('位置范围超出告警查询限制，请减少位置')
    if(alarmScopeValid) void alarmEventService.statistics(query.from,query.to,locations).then(r=>{if(live)setAlarm(r)}).catch(e=>{if(live)setAlarmError(e instanceof Error?e.message:'告警统计不可用')})
    return()=>{live=false}
  },[locations,query.from,query.to,alarmScopeValid,revision])
  const choose=(next:StatChoice)=>{
    const list=next.kind==='counter'?(counters??[]).filter(c=>c.counter_id===next.id):groups.find(g=>g.key===next.key)?.counters.slice(0,50)??[]
    if(!list.length)return
    setCounterIds(list.map(c=>c.counter_id));setBindings(list.flatMap(c=>c.bindings.filter(b=>b.active).map(b=>b.binding_id)))
  }
  const publish=link.publish
  const openRecords=(counterId:string,bindingId:string,output:'in'|'out')=>{const r=rows.find(x=>x.result.counter.counter_id===counterId&&x.zone.binding_id===bindingId);if(r)records(r,output)}
  const rangeText=formatRangeLabel(range.from,range.to)
  const toggleBinding=(id:string)=>setBindings(old=>old.includes(id)?old.filter(x=>x!==id):[...old,id])
  const inn=totalsOf(rows,'in'),out=totalsOf(rows,'out')
  const grid=weekPattern(weekly.length===selected.length?weekly:[],window4.from,window4.to)
  const trend=slots.map(s=>({slot:s,in:sumKnown(rows.map(r=>bucketValue(r.zone.in,s,query))),out:sumKnown(rows.map(r=>bucketValue(r.zone.out,s,query))),valid:rows.length>0&&rows.length===selected.length&&rows.every(r=>bucketComplete(r.zone.in?.coverage,s,query))}))
  const peak=trend.filter(t=>t.in!==null&&t.in>0).sort((a,b)=>(b.in??0)-(a.in??0))[0]
  const peakComplete=trend.length>0&&trend.every(t=>t.valid)
  const previousQuery = { from: range.previous.from.toISOString(), to: range.previous.to.toISOString() }
  const previousSlots=useMemo(()=>periodSlots(range.previous.from,range.previous.to,range.bucket),[range])
  // The comparison period, slot for slot, as a dashed line; only when every location answered for both periods.
  const reference=compare&&previous&&prior.length===selected.length&&prior.length>0?{name:`${names.in}（${range.compare}）`,color:'#64748b',values:slots.map((_,i)=>previousSlots[i]?sumKnown(prior.map(r=>bucketValue(r.zone.in,previousSlots[i]!,previousQuery))):null)}:null
  const zoneMap = new Map<string, ZoneInfo>()
  const mapReadings: MapReading[] = selectedCounters.flatMap(c => c.bindings.filter(b => bindings.includes(b.binding_id)).map(b => {
    const key = zoneKey(b.zone_id), zone = zoneMap.get(key) ?? { key, zoneId: b.zone_id, channelId: b.processor_id, name: b.zone_name || b.zone_id, counters: [] }
    if (!zone.counters.some(item => item.id === c.counter_id)) zone.counters.push({ id: c.counter_id, name: c.name })
    zoneMap.set(key, zone)
    const reading = rows.find(r => r.result.counter.counter_id === c.counter_id && r.zone.binding_id === b.binding_id)
    return { counterId: c.counter_id, bindingId: b.binding_id, zoneKey: key, in: reading ? totalsOf([reading], 'in') : null, out: reading ? totalsOf([reading], 'out') : null }
  }))
  const zones = [...zoneMap.values()]
  const exportCsv=()=>{const blob=new Blob([toCsv(rows,slots,query,Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',query.to)],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='统计分析.csv';a.click();URL.revokeObjectURL(url)}
  const dataReady=!!current && rows.length>0
  const coverageValues = rows.map(r => r.zone.in?.coverage)
  const coverageKnown = coverageValues.length > 0 && rows.length === selected.length && coverageValues.every(c => typeof c?.expected_ms === 'number' && typeof c?.covered_ms === 'number')
  const expectedCoverage = coverageKnown ? coverageValues.reduce((n, c) => n + c!.expected_ms!, 0) : null
  const coveredCoverage = coverageKnown ? coverageValues.reduce((n, c) => n + c!.covered_ms!, 0) : null
  const coverageSummary = expectedCoverage === null ? '未知' : expectedCoverage === 0 ? '不适用' : ((coveredCoverage! / expectedCoverage) * 100).toFixed(1) + '%'
  const coverageIssue = rows.length !== selected.length || rows.some(r => measured(r.zone.in?.coverage) !== 1)
  const qualitySummary = coverageIssue ? '部分位置覆盖不足或未知，已记录量可能偏低。' : '所选位置采集覆盖完整。'
  const coverageRows = <ul aria-label="各位置采集覆盖" className="space-y-1.5">{rows.map(r => {
      const c = r.zone.in?.coverage, ratio = measured(c), detail = whyCoverage(r)
      return <li key={r.result.counter.counter_id + ':' + r.zone.binding_id} className="flex items-center gap-2 text-xs" title={`${r.result.counter.name} · ${r.zone.zone_name || r.zone.zone_id}：${detail}`}>
        <span className="min-w-0 max-w-40 flex-1 truncate text-ink">{r.zone.zone_name || r.zone.zone_id}</span>
        <span aria-hidden="true" className={`h-1.5 min-w-4 flex-1 overflow-hidden rounded-full bg-surface-page ${ratio === null ? 'border border-dashed border-line' : ''}`}>
          {ratio !== null && <span className={`block h-full rounded-full ${ratio === 1 ? 'bg-success' : 'bg-warning'}`} style={{ width: `${ratio * 100}%` }} />}
        </span>
        <span aria-label={detail} className="w-14 shrink-0 text-right tabular-nums text-ink-subtle">{ratio === null ? c?.expected_ms === 0 ? '不适用' : '未知' : (ratio * 100).toFixed(1) + '%'}</span>
      </li>
    })}</ul>
  const records=(r:Row,output:'in'|'out',s?:Slot)=>setDrawer({result:{...r.result,zones:r.result.zones.filter(z=>bindings.includes(z.binding_id))},bindingId:r.zone.binding_id,output,from:s?new Date(Math.max(Date.parse(s.from),Date.parse(query.from))).toISOString():query.from,to:s?new Date(Math.min(Date.parse(s.to),Date.parse(query.to))).toISOString():query.to})
  // One statistic: a time slot opens its records straight away (the drawer picks the location). A total spans
  // several statistics, so the location is chosen below the chart first.
  const single=new Set(rows.map(r=>r.result.counter.counter_id)).size===1
  const openSlot=(i:number|null)=>{
    setSlotIndex(i)
    const s=i===null?undefined:slots[i]
    if(!s||!single||!rows[0])return
    const r=rows[0]
    setDrawer({result:{...r.result,zones:r.result.zones.filter(z=>bindings.includes(z.binding_id))},bindingId:rows.length===1?r.zone.binding_id:undefined,output:'in',from:new Date(Math.max(Date.parse(s.from),Date.parse(query.from))).toISOString(),to:new Date(Math.min(Date.parse(s.to),Date.parse(query.to))).toISOString()})
  }
  const heatPanel=<PlanPanel zones={zones} counters={selectedCounters.map(c=>({id:c.counter_id,name:c.name,names:c.names,outputs:c.outputs,unit:counterUnit(c)}))} readings={mapReadings} period={{...query,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}} loading={false} error="" countsFailed={false} onEditingChange={setMapEditing} selectedZone={activeZone} onSelectZone={setActiveZone} sourceHeat={sourceHeat}
    actions={<button type="button" aria-expanded={observing} aria-controls="region-observation" className="btn-secondary !px-2.5 !py-1 text-xs aria-expanded:border-primary aria-expanded:bg-primary-50 aria-expanded:text-primary [@media(pointer:coarse)]:min-h-11" title="停留片段与原画面热度，在地图上叠加查看" onClick={()=>setObserving(v=>!v)}><ScanSearch size={14} aria-hidden="true"/>区域观测</button>}/>
  const weekPanel=weekError?<section className="ui-panel p-3" role="alert">规律读取失败：{weekError}</section>:!week?<section className="ui-panel p-3" role="status">正在读取规律…</section>:<WeekHourPanel grid={grid}/>
  const rank=[...rows].sort((a,b)=>(totalsOf([b],'in')??-1)-(totalsOf([a],'in')??-1))
  const rankMax=Math.max(1,...rank.map(r=>totalsOf([r],'in')??0))
  useEffect(()=>{setSlotIndex(null);setRecordBinding('')},[query.from,query.to,selected])
  const selectedRecordRow=rows.find(r=>r.result.counter.counter_id+':'+r.zone.binding_id===recordBinding)
  const trendPanel = <section className="ui-panel flex min-h-[16rem] min-w-0 flex-col gap-1 overflow-auto p-3" aria-label="客流趋势">
    <header className="flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold text-ink">{vehicles?'车流趋势':'客流趋势'}</h2>
      <div className={segmented + ' ml-auto'} role="group" aria-label="视图">
        <button type="button" className={segment + ' !min-h-8 [@media(pointer:coarse)]:!min-h-11'} aria-pressed={view === 'trend'} onClick={() => setView('trend')}>趋势</button>
        <button type="button" className={segment + ' !min-h-8 [@media(pointer:coarse)]:!min-h-11'} aria-pressed={view === 'rank'} onClick={() => setView('rank')}>排名</button>
      </div>
    </header>
    {view === 'trend' ? <>
      <TrendChart key={query.from + '|' + query.to} label={names.in+(both?"与"+names.out:"")+"趋势"} bucket={range.bucket} slots={slots} onSelect={openSlot} complete={trend.map(t => t.valid)} reference={reference}
        series={[{ name: names.in, color: '#16a34a', values: trend.map(t => t.in) }, ...(both?[{ name: names.out, color: '#f97316', values: trend.map(t => t.out) }]:[])]} />
      {!single && slotIndex !== null && slots[slotIndex] && <div className="flex flex-wrap items-center gap-1 text-xs">
        <label>查看该时段记录 <select aria-label="趋势记录位置" className="form-input !w-auto !py-1" value={recordBinding} onChange={e => setRecordBinding(e.target.value)}>
          <option value="">选择位置</option>{rows.map(r => <option key={r.result.counter.counter_id + ':' + r.zone.binding_id} value={r.result.counter.counter_id + ':' + r.zone.binding_id}>{r.result.counter.name} · {r.zone.zone_name || r.zone.zone_id}</option>)}
        </select></label>
        {selectedRecordRow && (['in', 'out'] as const).filter(dir => !!selectedRecordRow.zone[dir]).map(dir => <button type="button" key={dir} className={button} onClick={() => records(selectedRecordRow, dir, slots[slotIndex])}>{selectedRecordRow.result.counter.names[dir]}记录</button>)}
      </div>}
    </> : <ol className="min-h-0 flex-1 space-y-1.5 overflow-auto" aria-label="统计位置排名">{rank.map((r, i) => {
      const n = totalsOf([r], 'in')
      return <li key={r.result.counter.counter_id + ':' + r.zone.binding_id} className="flex items-center gap-2 text-xs">
        <span className="w-4 shrink-0 text-ink-subtle">{i + 1}</span>
        <span className="w-40 shrink-0 truncate text-ink" title={r.result.counter.name + ' · ' + (r.zone.zone_name || r.zone.zone_id)}>{r.zone.zone_name || r.zone.zone_id}</span>
        <span aria-hidden="true" className="h-2.5 min-w-2 flex-1 rounded-full bg-surface-page"><span className="block h-2.5 rounded-full bg-success" style={{ width: `${(n ?? 0) / rankMax * 100}%` }} /></span>
        <button type="button" className="min-w-14 py-1 text-right tabular-nums text-ink hover:text-primary [@media(pointer:coarse)]:min-h-11" title={whyCoverage(r)} onClick={() => records(r, 'in')}>{fmt(n)} {unit}</button>
      </li>
    })}</ol>}
  </section>
  const validInComparison = rows.length === selected.length && complete(rows, 'in', query) && complete(prior, 'in', previousQuery) && prior.length === rows.length
  const validOutComparison = rows.length === selected.length && complete(rows, 'out', query) && complete(prior, 'out', previousQuery) && prior.length === rows.length
  const inComparison = comparison(inn, totalsOf(prior, 'in'), validInComparison, range.compare)
  const outComparison = comparison(out, totalsOf(prior, 'out'), validOutComparison, range.compare)
  const slotLabel = (s:Slot) => { const a=new Date(s.from); if (range.bucket!=='hour') return `${a.getMonth()+1}/${a.getDate()}`; const h=a.getHours(); return `${String(h).padStart(2,'0')}:00–${String((h+1)%24).padStart(2,'0')}:00` }
  const peakDescription = peak ? `${peakComplete ? '本期高峰' : '已记录峰值'}在 ${new Date(peak.slot.from).toLocaleString('zh-CN')}，${names.in} ${fmt(peak.in)} ${unit}${peakComplete ? '' : '；覆盖不足或未知，无法确定实际高峰'}。` : '没有可用的已记录峰值。'
  const alarmDescription = alarmError ? '告警统计不可用：' + alarmError : alarm ? `按告警去重；另有 ${alarm.association?.unassociated ?? '未知'} 条未关联位置（未计入总数）` : '正在读取告警统计'
  const cutoff = new Date(query.to).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const hours = Math.max(0, (Math.min(range.to.getTime(), Date.now()) - range.from.getTime()) / 3600000)
  const perHour = inn !== null && hours >= 1 / 60 ? inn / hours : null
  const net = both && inn !== null && out !== null ? inn - out : null
  const zoneTotal = (c:Counter) => (totals ?? []).find(t => t.counter.counter_id === c.counter_id)
  const showPicker = !(link.columnOpen && link.selection)
  // The choice's overview figures travel to its card in the statistics column.
  const summary: ChoiceSummary | null = dataReady ? {
    peak: peak ? { label: slotLabel(peak.slot), value: peak.in ?? 0, complete: peakComplete } : null,
    net, perHour, unit,
    trend: { bucket: range.bucket, slots, label: names.in+(both?'与'+names.out:'')+'趋势', complete: trend.map(t => t.valid), reference, series: [{ name: names.in, color: '#16a34a', values: trend.map(t => t.in) }, ...(both?[{ name: names.out, color: '#f97316', values: trend.map(t => t.out) }]:[])] },
    change: { in: compare && validInComparison ? changeText(inn, totalsOf(prior, 'in')) : null, out: compare && both && validOutComparison ? changeText(out, totalsOf(prior, 'out')) : null },
  } : null
  const summaryKey = JSON.stringify(summary)
  const openSlotRef = useRef(openSlot); openSlotRef.current = openSlot
  useEffect(()=>{if(counters)publish({ids:counterIds,choice,choose,counters,bindings,toggleBinding,items:current?.items??null,totals,previousTotals:compare?previousTotals:null,compareLabel:compare?range.compare:null,summary,openSlot:i=>openSlotRef.current(i),range:{from:query.from,to:query.to,label:rangeText},openRecords})},[counters,counterIds,bindings,current,totals,previousTotals,compare,summaryKey,rangeText])
  useEffect(()=>()=>publish(null),[publish])
  // Key conclusions: what a person watching this screen should take away without reading a chart.
  const busiest = grid.flatMap((row, d) => row.map((c, h) => ({ d, h, v: c.value }))).filter(c => c.v !== null && c.v > 0).sort((a, b) => b.v! - a.v!)[0]
  const topRow = rows.length > 1 && inn ? rank[0] : undefined
  const topShare = topRow && inn ? (totalsOf([topRow], 'in') ?? 0) / inn * 100 : null
  const conclusions: { label: string; text: string; tone?: string }[] = [
    { label: rangeText, text: `${names.in} ${fmt(inn)}${both ? ` · ${names.out} ${fmt(out)}` : ''} ${unit}` },
    ...(compare ? [{ label: '较' + range.compare, text: validInComparison ? `${names.in} ${changeText(inn, totalsOf(prior, 'in')) ?? '—'}${both && validOutComparison ? ` · ${names.out} ${changeText(out, totalsOf(prior, 'out')) ?? '—'}` : ''}` : '覆盖不足，暂不比较' }] : []),
    ...(peak ? [{ label: peakComplete ? '高峰' : '已记录峰值', text: `${slotLabel(peak.slot)} · ${names.in} ${fmt(peak.in)}` }] : []),
    ...(net !== null ? [{ label: '净流入', text: `${signed(net)}（非在场人数）` }] : perHour !== null ? [{ label: '平均每小时', text: `${fmt(perHour)} ${unit}` }] : []),
    ...(busiest ? [{ label: '近 4 周最忙', text: `${weekdayNames[busiest.d]} ${busiest.h}:00 · 平均 ${busiest.v!.toFixed(1)}` }] : []),
    ...(topRow && topShare !== null ? [{ label: '最忙位置', text: `${topRow.zone.zone_name || topRow.zone.zone_id} · 占 ${topShare.toFixed(0)}%` }] : []),
    ...(coverageIssue ? [{ label: '数据', text: '覆盖不足或未知，已记录量可能偏低', tone: 'text-amber-700' }] : []),
  ]
  const statusDetails = <details aria-label="统计说明" className="relative ml-auto flex min-w-0 shrink-0 items-center">
    <summary className={`flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-base px-2 text-xs [&::-webkit-details-marker]:hidden [@media(pointer:coarse)]:min-h-11 ${coverageIssue ? 'bg-amber-50 text-amber-800' : 'text-ink-subtle hover:text-ink'}`} title={qualitySummary + ' ' + peakDescription}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${coverageIssue ? 'bg-warning' : 'bg-success'}`} />
      <span role="status" aria-label="数据状态" className="truncate">{coverageIssue ? '覆盖不足或未知，已记录量可能偏低' : '采集覆盖完整'}</span>
      <span className="tabular-nums">{coverageSummary}</span><Info size={13} aria-hidden="true" className="shrink-0" />
    </summary>
    <div role="region" aria-label="统计说明详情" className="ui-panel absolute right-0 top-full z-30 mt-1 max-h-[70vh] w-[28rem] max-w-[80vw] space-y-3 overflow-auto p-3 text-xs text-ink-subtle shadow-lg">
      <section aria-label="有效位置时段采集覆盖" className="space-y-1.5">
        <h2 className="flex items-center text-xs font-semibold text-ink">各位置采集覆盖<span className="ml-auto font-normal tabular-nums" title="按位置有效时长加权">{coverageSummary}</span></h2>
        {coverageRows}
      </section>
      <div className="space-y-2 border-t border-line pt-2">
        <p>查询截至 {new Date(query.to).toLocaleString('zh-CN')}；{Intl.DateTimeFormat().resolvedOptions().timeZone}。结果可能有写入延迟，计数为目标通过次数，不等于独立人数；已记录量不代表缺口内为零。</p>
        <p>{qualitySummary}所选位置综合覆盖：{coverageSummary}（按位置有效时长加权）。依据已保存的统计状态与布防历史计算；历史不完整时显示未知，宽限时间不计入实测覆盖。覆盖不是识别准确率。</p>
        {current && rows.length < selected.length && <p>部分所选位置在本期没有统计序列，合计仅包含已返回的位置。</p>}
        <p>{peakDescription}历史计数线或目标配置变化可能影响对比口径。</p>
        {compare && <p>{names.in}：{inComparison}{both&&<>；{names.out}：{outComparison}</>}。仅在两期位置匹配、覆盖完整时计算变化率。</p>}
        {net !== null && <p>净流入为{names.in}减{names.out}，不是实际在场人数：识别中断、遮挡或从未计数的出入口都会让它偏离。</p>}
        {vehicles && <p>车辆统计只计车辆类别的通行；读牌结果不影响通行计数。</p>}
        <p>所选位置告警：{alarmDescription}。</p>
      </div>
    </div>
  </details>
  return <main className="alarm-workspace flex min-h-0 min-w-0 flex-col gap-2 overflow-auto [@container(min-width:44rem)]:h-full [@container(min-width:56rem)]:overflow-hidden">
    <header aria-label="统计筛选与操作" className="flex shrink-0 flex-wrap items-center gap-2">
      <h1 className="mr-1 min-w-0 truncate text-lg font-semibold leading-7 text-ink" title={choiceName||undefined}>统计分析{choiceName&&<span className="font-normal text-ink-subtle"> · {choiceName}</span>}</h1>
      {showPicker && !!counters?.length && <label className={field}>
        <span className="sr-only">统计</span>
        <select aria-label="统计" className={fieldSelect + ' !pl-0'} value={choice?.kind==='counter'?choice.id:choice?totalValue(choice.key):''} onChange={e=>{const v=e.target.value;if(v)choose(v.startsWith('total:')?{kind:'total',key:v.slice(6)}:{kind:'counter',id:v})}}>
          {!choice&&<option value="">选择统计</option>}
          {groups.filter(g=>g.counters.length>1).map(g=><option key={g.key} value={totalValue(g.key)}>合计 · {g.counters.length} 个统计（{g.counters[0]!.labels.map(l=>labelDisplay(l.name)).join('、')}）</option>)}
          {counters.filter(c=>!c.deleting).map(c=>{const t=zoneTotal(c);return <option key={c.counter_id} value={c.counter_id}>{c.name}{t?`　${c.names.in} ${t.in.occurrences}`:''}</option>})}
        </select>
      </label>}
      {showPicker && selectedCounters.length > 0 && <details className="relative">
        <summary className={field + ' cursor-pointer list-none pr-3 [&::-webkit-details-marker]:hidden'}>统计位置 {bindings.length}<ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="ui-panel absolute left-0 top-full z-30 mt-1 max-h-72 w-72 overflow-auto p-1.5 shadow-lg">{selectedCounters.flatMap(c => c.bindings.map(b =>
          <label key={c.counter_id + ':' + b.binding_id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-base px-2 text-sm text-ink hover:bg-surface-hover [@media(pointer:coarse)]:min-h-11">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={bindings.includes(b.binding_id)} onChange={() => toggleBinding(b.binding_id)} />
            <span className="truncate" title={c.name + ' · ' + (b.zone_name || b.zone_id)}>{selectedCounters.length > 1 ? c.name + ' · ' : ''}{b.zone_name || b.zone_id}{!b.active ? '（已解绑/历史）' : ''}</span>
          </label>))}
        </div>
      </details>}
      <div role="group" aria-label="时间范围" className={segmented}>
        {presets.map(([id, name]) => <button key={id} type="button" className={segment} aria-pressed={!custom && preset === id} onClick={() => { setCustom(null); setNow(new Date()); setParam('range', id) }}>{name}</button>)}
        <button type="button" aria-label="自选时间范围" aria-pressed={!!custom} className={segment} onClick={() => setPicker({ from: toDatetimeLocalValue(range.from), to: toDatetimeLocalValue(new Date(range.to.getTime() - 1000)) })}><CalendarClock size={14} aria-hidden="true" />{custom ? formatRangeLabel(range.from, range.to) : '自选'}</button>
      </div>
      <button type="button" className={field + ' pr-3 aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'} aria-pressed={compare} title={`对比${range.compare}；仅在两期覆盖完整时计算变化率`} onClick={() => setCompare(v => !v)}>{compare ? '对比' : '不对比'}</button>
      <span className="ml-auto flex items-center gap-1">
        <button type="button" className="inline-flex !min-h-11 items-center gap-1.5 rounded-base px-2 text-xs text-ink-subtle hover:bg-surface-hover hover:text-ink" aria-label="刷新" title={`查询截至 ${new Date(query.to).toLocaleString('zh-CN')}；结果可能有写入延迟。点击刷新`} onClick={() => { setNow(new Date()); setRevision(n => n + 1) }}>
          {dataReady && <span className="tabular-nums">截至 {cutoff}</span>}<RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} /></button>
        <button type="button" className="inline-flex !min-h-11 items-center gap-1.5 rounded-base px-2 text-xs text-ink-subtle hover:bg-surface-hover hover:text-ink disabled:opacity-50" disabled={!dataReady} onClick={exportCsv}><Download size={14} aria-hidden="true" />导出 CSV</button>
      </span>
    </header>
    {configError && <p role="alert" className="rounded-base border border-danger bg-danger-50 px-3 py-1 text-xs text-danger-700">{configError}</p>}
    {error && <p role="alert" className="rounded-base border border-danger bg-danger-50 px-3 py-1 text-xs text-danger-700">统计读取失败：{error}</p>}
    {loading && !current && <p role="status" className="py-3 text-center text-sm text-ink-subtle">正在读取统计…</p>}
    {!counterIds.length && counters && !configError && <p className="py-3 text-center text-sm text-ink-subtle">{counters.length ? '请选择一个统计。' : '还没有统计。请在右侧“统计列表”新建统计，再到实时监看的布防中选用到热区。'}</p>}
    {counterIds.length > 0 && !bindings.length && <p className="py-3 text-center text-sm text-ink-subtle">请选择至少一个统计位置。</p>}
    {dataReady && <>
      {/* With the statistics column open, these figures sit on the chosen card instead. */}
      {showPicker && <section aria-label="概览" className={`grid shrink-0 gap-2 ${both ? 'grid-cols-2 [@container(min-width:44rem)]:grid-cols-4' : 'grid-cols-3'}`}>
        <Kpi label={"已记录"+names.in} value={`${fmt(inn)} ${unit}`}>
          {compare && <span title={inComparison} aria-label={inComparison} className="min-w-0 truncate text-[11px] text-ink-faint">{validInComparison ? inComparison : '对比不足'}</span>}
        </Kpi>
        {both && <Kpi label={"已记录"+names.out} value={`${fmt(out)} ${unit}`}>
          {compare && <span title={outComparison} aria-label={outComparison} className="min-w-0 truncate text-[11px] text-ink-faint">{validOutComparison ? outComparison : '对比不足'}</span>}
        </Kpi>}
        <Kpi label={peakComplete ? '高峰' : '已记录峰值'} value={peak ? <button type="button" className="hover:text-primary" title="查看高峰时段的通行记录" onClick={() => openSlot(trend.indexOf(peak))}>{new Date(peak.slot.from).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</button> : '—'}>
          <span className="truncate text-[11px] text-ink-faint" title={peakDescription}>{peak ? fmt(peak.in) + ' ' + unit : '无已记录通行'}</span>
        </Kpi>
        {net !== null ? <Kpi label="净流入" value={signed(net)}>
          <span className="truncate text-[11px] text-ink-faint" title={`${names.in}减${names.out}；不是实际在场人数`}>{names.in}减{names.out} · 非在场人数</span>
        </Kpi> : <Kpi label="平均每小时" value={perHour === null ? '—' : `${fmt(perHour)} ${unit}`}>
          <span className="truncate text-[11px] text-ink-faint">按本期已记录量</span>
        </Kpi>}
      </section>}
      {previousError && compare && <p role="alert" className="shrink-0 text-xs text-danger-700">对比期读取失败：{previousError}</p>}
      {/* One screen without scrolling: the heat map leads; conclusions and the weekly pattern sit beside it. The trend
          lives on the chosen statistic's card, and comes back here only while the statistics column is closed. */}
      <div className="grid gap-2 [@container(min-width:56rem)]:min-h-0 [@container(min-width:56rem)]:flex-1 [@container(min-width:56rem)]:grid-cols-[minmax(0,1fr)_minmax(17rem,24rem)]">
        <div className="relative flex min-h-[26rem] min-w-0 flex-col [&>section]:flex-1 [@container(min-width:56rem)]:min-h-0">
          {heatPanel}
          {/* Region observation opens over the map instead of taking a row of its own; it stays mounted so its choice and
              its real-grid heat (offered on the map as a layer) survive closing it. */}
          <div id="region-observation" hidden={!observing} className={`absolute inset-y-2 right-2 z-20 ${observing ? 'flex' : 'hidden'} w-[min(30rem,calc(100%-1rem))] flex-col rounded-panel shadow-modal [&>section]:flex-1`}>
            <button type="button" aria-label="关闭区域观测" className="absolute right-1.5 top-1.5 z-10 flex h-9 w-9 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" onClick={() => setObserving(false)}><X size={16} aria-hidden="true" /></button>
            <DwellPanel locations={dwellLocations} from={query.from} to={query.to} bucket={range.bucket} labels={dwellLabels} labelNames={Object.fromEntries((selectedCounters[0]?.labels ?? []).map(l => [l.label_id, l.name]))} onActiveChange={setObservationActive} activeZone={activeZone} onSelectZone={setActiveZone} revision={revision} onVariantChange={receiveHeat} />
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <section aria-label="关键结论" className="ui-panel shrink-0 space-y-2 p-3">
            <header className="flex items-center gap-2"><h2 className="text-sm font-semibold text-ink">关键结论</h2>{statusDetails}</header>
            <dl className="space-y-1.5">{conclusions.map(c => <div key={c.label} className="flex items-baseline justify-between gap-3 text-sm">
              <dt className="shrink-0 text-xs text-ink-subtle">{c.label}</dt><dd className={`min-w-0 text-right tabular-nums ${c.tone ?? 'font-medium text-ink'}`}>{c.text}</dd></div>)}</dl>
          </section>
          {showPicker && <div className="flex min-h-[14rem] flex-1 flex-col [&>section]:flex-1">{trendPanel}</div>}
          <div className="flex min-h-[13rem] flex-1 flex-col [&>section]:flex-1">{weekPanel}</div>
        </div>
      </div>
      {alarm && <p className="shrink-0 text-right text-xs text-ink-faint"><Link className="hover:text-primary" title={alarmDescription} to={'/alarms?' + new URLSearchParams({ status: 'all', from: query.from, to: query.to, locations: JSON.stringify(locations) })}>所选位置告警 {fmt(alarm.total)} 条 →</Link></p>}
    </>}
    {picker && <DateTimeRangePicker open from={picker.from} to={picker.to} validateRange={validateCustomRange} onConfirm={(from, to) => setCustom({ from: new Date(from), to: new Date(to) })} onClose={() => setPicker(null)} />}
    {drawer && <RecordsDrawer {...drawer} zoneName={z => z.zone_name || z.zone_id} onClose={() => setDrawer(null)} />}
  </main>
}
