import { CalendarClock, ChevronDown, Download, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { alarmEventService, type AlarmStatistics } from '@/api/alarmEventService'
import { flowService, type Counter, type CounterResult } from '@/api/flowService'
import { DateTimeRangePicker } from '@/components/ui/DateTimeRangePicker'
import { periodSlots } from '@/pages/Flow/FlowChart'
import { RecordsDrawer } from '@/pages/Flow/RecordsDrawer'
import { rangeOf, validateCustomRange, type CustomRange, type Preset } from '@/pages/Flow/flowRange'
import { toDatetimeLocalValue } from '@/utils/timeRange'
import { bucketComplete, bucketValue, complete, counterUnit, measured, queryFlow, selectedRows, sumKnown, toCsv, totalsOf, weekPattern, weekWindow, type Location, type Row, type Slot } from './analyticsSource'
import { PlanPanel } from './plan/PlanPanel'
import { TrendChart } from './TrendChart'
import { WeekHourPanel } from './WeekHourPanel'
import { DwellPanel } from './DwellPanel'
import type { HeatVariant } from './RegionHeatPanel'
import { zoneKey, type MapReading, type ZoneInfo } from './plan/planModel'
import { AnalyticsSubjectSwitch } from './AnalyticsSubjectSwitch'
import AlarmAnalyticsPage from './AlarmAnalyticsPage'

const button = 'btn-secondary !min-h-7 !px-2.5 !py-1 text-xs aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary [@media(pointer:coarse)]:!min-h-11'
const tabs = [['overview','总览'],['flow','客流'],['heat','热区'],['week','规律']] as const
const presets = [['today','今天'],['yesterday','昨天'],['7d','近 7 天'],['30d','近 30 天']] as const
type Result = {items:CounterResult[]}
const coverageName = (state:string|undefined) => ({complete:'完整',partial:'部分覆盖',no_data:'无覆盖',unknown:'未知'}[state??'unknown']??'未知')
const fmt = (n:number|null) => n === null ? '—' : n.toLocaleString('zh-CN', {maximumFractionDigits:1})
function parseIds(value:string|null):string[]|null { if(value===null)return null;try{const v:unknown=JSON.parse(value);return Array.isArray(v)&&v.every(x=>typeof x==='string')?v:[]}catch{return []} }
function initialCustom(params:URLSearchParams):CustomRange|null {const a=params.get('from'),b=params.get('to');if(!a||!b)return null;const from=new Date(a),to=new Date(new Date(b).getTime()-1000);return validateCustomRange(from,to)===null?{from,to}:null}
function signature(c:Counter) { return JSON.stringify([c.labels.map(x=>[x.label_id,x.name]).sort(),c.method,c.outputs,c.names,[...new Set(c.bindings.map(b=>b.processor_id))].sort()]) }
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
export default function AnalyticsPage() {
  const [params]=useSearchParams()
  return params.get('subject')==='alarms'?<AlarmAnalyticsPage/>:<FlowAnalyticsPage/>
}
function FlowAnalyticsPage() {
  const [params,setParams]=useSearchParams()
  const tab=tabs.find(t=>t[0]===params.get('tab'))?.[0] ?? 'overview'
  const preset=(presets.find(p=>p[0]===params.get('range'))?.[0] ?? 'today') as Preset
  const initialParams=useRef(new URLSearchParams(params))
  const [custom,setCustom]=useState<CustomRange|null>(()=>initialCustom(initialParams.current)),[picker,setPicker]=useState<{from:string;to:string}|null>(null)
  const [counters,setCounters]=useState<Counter[]|null>(null),[counterIds,setCounterIds]=useState<string[]>([]),[bindings,setBindings]=useState<string[]>([])
  const [view,setView]=useState<'trend'|'rank'>('trend')
  const [slotIndex,setSlotIndex]=useState<number|null>(null),[recordBinding,setRecordBinding]=useState('')
  const [compare,setCompare]=useState(()=>initialParams.current.get('compare')!=='0'),[revision,setRevision]=useState(0),[now,setNow]=useState(()=>new Date())
  const [current,setCurrent]=useState<Result|null>(null),[previous,setPrevious]=useState<Result|null>(null),[week,setWeek]=useState<Result|null>(null)
  const [error,setError]=useState(''),[configError,setConfigError]=useState(''),[previousError,setPreviousError]=useState(''),[weekError,setWeekError]=useState(''),[loading,setLoading]=useState(false)
  const [alarm,setAlarm]=useState<AlarmStatistics|null>(null),[alarmError,setAlarmError]=useState('')
  const [drawer,setDrawer]=useState<{result:CounterResult;bindingId:string;output:'in'|'out';from:string;to:string}|null>(null)
  const [mapEditing,setMapEditing]=useState(false)
  const [observationActive,setObservationActive]=useState(false)
  const [activeZone,setActiveZone]=useState<string|null>(null)
  const [sourceHeat,setSourceHeat]=useState<{zoneKey:string;variant:HeatVariant}|null>(null)
  const receiveHeat=useCallback((zoneKey:string,variant:HeatVariant|null)=>setSourceHeat(old=>variant?old?.zoneKey===zoneKey&&old.variant===variant?old:{zoneKey,variant}:old?.zoneKey===zoneKey?null:old),[])
  const selectionRef=useRef({counterIds,bindings});selectionRef.current={counterIds,bindings}
  const initialized=useRef(false)
  const currentVersion=useRef(0)
  const range=useMemo(()=>rangeOf(custom?'custom':preset,now,custom),[custom,preset,now])
  const window4=useMemo(()=>weekWindow(now),[now])
  const selectedCounters=useMemo(()=>(counters??[]).filter(c=>counterIds.includes(c.counter_id)),[counters,counterIds])
  const unit=selectedCounters[0]?counterUnit(selectedCounters[0]):'次'
  const names=selectedCounters[0]?.names??{in:'进入',out:'离开'}
  const both=selectedCounters[0]?.outputs!=='in'
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
  const setParam=(key:string,value:string)=>setParams(old=>{const p=new URLSearchParams(old);p.set(key,value);return p},{replace:true})
  useEffect(()=>{
    let live=true;setConfigError('')
    void flowService.list({includeInactiveBindings:true}).then(r=>{
      if(!live)return
      const requested=initialized.current?selectionRef.current.counterIds:parseIds(initialParams.current.get('counters'))
      const requestedBindings=initialized.current?selectionRef.current.bindings:parseIds(initialParams.current.get('bindings'))
      const first=r.items.find(c=>requested===null||requested.includes(c.counter_id))
      const chosen=first?r.items.filter(c=>(requested===null?c.counter_id===first.counter_id:requested.includes(c.counter_id))&&signature(c)===signature(first)).slice(0,50):[]
      setCounters(r.items);setCounterIds(chosen.map(c=>c.counter_id))
      setBindings(chosen.flatMap(c=>c.bindings.filter(b=>requestedBindings===null?b.active:requestedBindings.includes(b.binding_id)).map(b=>b.binding_id)))
      initialized.current=true
    }).catch(e=>{if(live)setConfigError(e instanceof Error?e.message:'计数器读取失败')})
    return()=>{live=false}
  },[revision])
  useEffect(()=>{if(!counters)return;setParams(old=>{const next=new URLSearchParams(old);next.set('counters',JSON.stringify(counterIds));next.set('bindings',JSON.stringify(bindings));next.set('compare',compare?'1':'0');if(custom){next.set('from',custom.from.toISOString());next.set('to',new Date(custom.to.getTime()+1000).toISOString())}else{next.delete('from');next.delete('to')}return next.toString()===old.toString()?old:next},{replace:true})},[counters,counterIds,bindings,compare,custom,setParams])
  useEffect(()=>{if(mapEditing||drawer||picker||observationActive)return;const timer=setInterval(()=>{if(!document.hidden){setNow(new Date())}},60000);return()=>clearInterval(timer)},[mapEditing,drawer,picker,observationActive])
  useEffect(()=>{
    const id=++currentVersion.current
    if(!counterIds.length){setCurrent(null);setLoading(false);return}
    setCurrent(null);setLoading(true);setError('')
    void queryFlow(range.from,range.to,range.bucket,counterIds).then(r=>{if(id===currentVersion.current)setCurrent(r)})
      .catch(e=>{if(id===currentVersion.current)setError(e instanceof Error?e.message:'统计读取失败')})
      .finally(()=>{if(id===currentVersion.current)setLoading(false)})
    return()=>{currentVersion.current++}
  },[counterIds,range])
  useEffect(()=>{
    let live=true;setPrevious(null);setPreviousError('')
    if(compare&&counterIds.length) void queryFlow(range.previous.from,range.previous.to,range.bucket,counterIds).then(r=>{if(live)setPrevious(r)}).catch(e=>{if(live)setPreviousError(e instanceof Error?e.message:'对比期读取失败')})
    return()=>{live=false}
  },[compare,counterIds,range])
  useEffect(()=>{
    let live=true;setWeek(null);setWeekError('')
    if(counterIds.length) void queryFlow(window4.from,window4.to,'hour',counterIds).then(r=>{if(live)setWeek(r)}).catch(e=>{if(live)setWeekError(e instanceof Error?e.message:'规律读取失败')})
    return()=>{live=false}
  },[counterIds,window4.from.getTime(),window4.to.getTime(),revision])
  useEffect(()=>{
    let live=true;setAlarm(null);setAlarmError('')
    if(!alarmScopeValid&&locations.length) setAlarmError('位置范围超出告警查询限制，请减少位置')
    if(alarmScopeValid) void alarmEventService.statistics(query.from,query.to,locations).then(r=>{if(live)setAlarm(r)}).catch(e=>{if(live)setAlarmError(e instanceof Error?e.message:'告警统计不可用')})
    return()=>{live=false}
  },[locations,query.from,query.to,alarmScopeValid,revision])
  const selectCounter=(c:Counter)=>{if(counterIds.includes(c.counter_id)){setCounterIds(old=>old.filter(id=>id!==c.counter_id));setBindings(old=>old.filter(id=>!c.bindings.some(b=>b.binding_id===id)))}else if(counterIds.length<50){setCounterIds(old=>[...old,c.counter_id]);setBindings(old=>[...old,...c.bindings.filter(b=>b.active).map(b=>b.binding_id)])}}
  const toggleBinding=(id:string)=>setBindings(old=>old.includes(id)?old.filter(x=>x!==id):[...old,id])
  const inn=totalsOf(rows,'in'),out=totalsOf(rows,'out')
  const grid=weekPattern(weekly.length===selected.length?weekly:[],window4.from,window4.to)
  const trend=slots.map(s=>({slot:s,in:sumKnown(rows.map(r=>bucketValue(r.zone.in,s,query))),out:sumKnown(rows.map(r=>bucketValue(r.zone.out,s,query))),valid:rows.length>0&&rows.length===selected.length&&rows.every(r=>bucketComplete(r.zone.in?.coverage,s,query))}))
  const peak=trend.filter(t=>t.in!==null&&t.in>0).sort((a,b)=>(b.in??0)-(a.in??0))[0]
  const peakComplete=trend.length>0&&trend.every(t=>t.valid)
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
  const coverageRows = <ul className="min-h-0 flex-1 space-y-1.5 overflow-auto">{rows.map(r => {
      const c = r.zone.in?.coverage, ratio = measured(c), detail = whyCoverage(r)
      return <li key={r.result.counter.counter_id + ':' + r.zone.binding_id} className="flex items-center gap-2 text-xs" title={`${r.result.counter.name} · ${r.zone.zone_name || r.zone.zone_id}：${detail}`}>
        <span className="min-w-0 max-w-28 flex-1 truncate text-ink">{r.zone.zone_name || r.zone.zone_id}</span>
        <span aria-hidden="true" className={`h-1.5 min-w-4 flex-1 overflow-hidden rounded-full bg-surface-page ${ratio === null ? 'border border-dashed border-line' : ''}`}>
          {ratio !== null && <span className={`block h-full rounded-full ${ratio === 1 ? 'bg-success' : 'bg-warning'}`} style={{ width: `${ratio * 100}%` }} />}
        </span>
        <span aria-label={detail} className="w-14 shrink-0 text-right tabular-nums text-ink-subtle">{ratio === null ? c?.expected_ms === 0 ? '不适用' : '未知' : (ratio * 100).toFixed(1) + '%'}</span>
      </li>
    })}</ul>
  const coverage = <section className="ui-panel flex min-h-0 min-w-0 flex-col gap-1.5 overflow-auto p-3" aria-label="有效位置时段采集覆盖">
    <header className="flex items-center gap-2">
      <h2 className="text-sm font-semibold text-ink">数据完整度</h2>
      <span className="ml-auto text-xs tabular-nums text-ink-subtle" title={`所选位置综合覆盖：${coverageSummary}（按位置有效时长加权）`}>{coverageSummary}</span>
    </header>
    {coverageRows}
    <p className="text-[11px] text-ink-faint" title="依据已保存的计数器状态与布防历史计算；历史不完整时显示未知，宽限时间不计入实测覆盖。覆盖不是识别准确率。">采集时段覆盖，不代表识别准确率。</p>
  </section>
  const coveragePreview = <section className="ui-panel min-w-0 p-2.5" aria-label="有效位置时段采集覆盖">
    <details>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 text-xs [&::-webkit-details-marker]:hidden [@media(pointer:coarse)]:min-h-11">
        <h2 className="text-xs font-semibold text-ink">数据完整度</h2>
        <strong className="tabular-nums text-ink" title="所选位置按有效时长加权的综合覆盖">{coverageSummary}</strong>
        <span className="ml-auto flex items-center gap-1 text-ink-subtle">位置明细<ChevronDown size={12} aria-hidden="true" /></span>
      </summary>
      <div className="mt-2 max-h-40 overflow-auto">{coverageRows}</div>
    </details>
    <p className="mt-1 text-[11px] text-ink-faint" title={qualitySummary}>采集时段覆盖，不代表识别准确率。</p>
  </section>
  const records=(r:Row,output:'in'|'out',s?:Slot)=>setDrawer({result:{...r.result,zones:r.result.zones.filter(z=>bindings.includes(z.binding_id))},bindingId:r.zone.binding_id,output,from:s?new Date(Math.max(Date.parse(s.from),Date.parse(query.from))).toISOString():query.from,to:s?new Date(Math.min(Date.parse(s.to),Date.parse(query.to))).toISOString():query.to})
  const table=<section className="ui-panel overflow-auto p-3" aria-label="统计位置"><h2 className="font-semibold">计数器与位置</h2><p className="text-xs text-ink-subtle">点击已记录数查看通行记录；不同位置可能重复计数。</p>
    <table className="w-full text-sm"><thead><tr><th className="text-left">位置</th><th>{names.in}</th>{both&&<th>{names.out}</th>}<th>覆盖</th></tr></thead><tbody>{rows.map(r=><tr key={r.zone.binding_id} className="border-t border-line"><td>{r.zone.zone_name || r.zone.zone_id}</td>{(['in','out'] as const).filter(dir=>dir==='in'||both).map(dir=><td key={dir} className="text-center"><button className={button} disabled={!r.zone[dir]} onClick={()=>records(r,dir)}>{fmt(totalsOf([r],dir))}</button></td>)}<td>{whyCoverage(r)}</td></tr>)}</tbody></table></section>
  const heatPanel=<PlanPanel zones={zones} counters={selectedCounters.map(c=>({id:c.counter_id,name:c.name,names:c.names,outputs:c.outputs,unit:counterUnit(c)}))} readings={mapReadings} period={{...query,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}} loading={false} error="" countsFailed={false} onEditingChange={setMapEditing} selectedZone={activeZone} onSelectZone={setActiveZone} sourceHeat={sourceHeat}/>
  const weekPanel=weekError?<section className="ui-panel p-3" role="alert">规律读取失败：{weekError}</section>:!week?<section className="ui-panel p-3" role="status">正在读取规律…</section>:<WeekHourPanel grid={grid} compact={tab==='overview'} onExpand={()=>setParam('tab','week')}/>
  const rank=[...rows].sort((a,b)=>(totalsOf([b],'in')??-1)-(totalsOf([a],'in')??-1))
  const rankMax=Math.max(1,...rank.map(r=>totalsOf([r],'in')??0))
  useEffect(()=>{setSlotIndex(null);setRecordBinding('')},[query.from,query.to,selected])
  const selectedRecordRow=rows.find(r=>r.result.counter.counter_id+':'+r.zone.binding_id===recordBinding)
  const trendPanel = <section className={`ui-panel flex min-w-0 flex-col gap-1 overflow-auto p-3 ${tab === 'overview' ? 'min-h-[14rem] lg:min-h-0' : 'min-h-[16rem] lg:min-h-0'}`} aria-label="客流趋势">
    <header className="flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold text-ink">客流趋势</h2>
      {tab === 'overview' ? <button type="button" className={button + ' ml-auto'} onClick={() => setParam('tab', 'flow')}>查看客流</button> : <div className="ml-auto flex gap-1" role="group" aria-label="视图">
        <button type="button" className={button} aria-pressed={view === 'trend'} onClick={() => setView('trend')}>趋势</button>
        <button type="button" className={button} aria-pressed={view === 'rank'} onClick={() => setView('rank')}>排名</button>
      </div>}
    </header>
    {tab === 'overview' || view === 'trend' ? <>
      <TrendChart key={query.from + '|' + query.to} label={names.in+(both?"与"+names.out:"")+"趋势"} bucket={range.bucket} slots={slots} onSelect={setSlotIndex} complete={trend.map(t => t.valid)}
        series={[{ name: names.in, color: '#16a34a', values: trend.map(t => t.in) }, ...(both?[{ name: names.out, color: '#f97316', values: trend.map(t => t.out) }]:[])]} />
      {slotIndex !== null && slots[slotIndex] && <div className="flex flex-wrap items-center gap-1 text-xs">
        <label>查看该时段记录 <select aria-label="趋势记录位置" className="form-input !w-auto !py-1" value={recordBinding} onChange={e => setRecordBinding(e.target.value)}>
          <option value="">选择位置</option>{rows.map(r => <option key={r.result.counter.counter_id + ':' + r.zone.binding_id} value={r.result.counter.counter_id + ':' + r.zone.binding_id}>{r.result.counter.name} · {r.zone.zone_name || r.zone.zone_id}</option>)}
        </select></label>
        {selectedRecordRow && (['in', 'out'] as const).filter(dir => !!selectedRecordRow.zone[dir]).map(dir => <button type="button" key={dir} className={button} onClick={() => records(selectedRecordRow, dir, slots[slotIndex])}>{selectedRecordRow.result.counter.names[dir]}记录</button>)}
      </div>}
    </> : <ol className="min-h-0 flex-1 space-y-1.5 overflow-auto" aria-label="统计位置排名">{rank.map((r, i) => {
      const n = totalsOf([r], 'in')
      return <li key={r.result.counter.counter_id + ':' + r.zone.binding_id} className="flex items-center gap-2 text-xs">
        <span className="w-4 shrink-0 text-ink-subtle">{i + 1}</span>
        <span className="w-28 shrink-0 truncate text-ink" title={r.result.counter.name + ' · ' + (r.zone.zone_name || r.zone.zone_id)}>{r.zone.zone_name || r.zone.zone_id}</span>
        <span aria-hidden="true" className="h-2.5 min-w-2 flex-1 rounded-full bg-surface-page"><span className="block h-2.5 rounded-full bg-success" style={{ width: `${(n ?? 0) / rankMax * 100}%` }} /></span>
        <button type="button" className="min-w-14 py-1 text-right tabular-nums text-ink hover:text-primary [@media(pointer:coarse)]:min-h-11" title={whyCoverage(r)} onClick={() => records(r, 'in')}>{fmt(n)} {unit}</button>
      </li>
    })}</ol>}
  </section>
  const previousQuery = { from: range.previous.from.toISOString(), to: range.previous.to.toISOString() }
  const validInComparison = rows.length === selected.length && complete(rows, 'in', query) && complete(prior, 'in', previousQuery) && prior.length === rows.length
  const validOutComparison = rows.length === selected.length && complete(rows, 'out', query) && complete(prior, 'out', previousQuery) && prior.length === rows.length
  const inComparison = comparison(inn, totalsOf(prior, 'in'), validInComparison, range.compare)
  const outComparison = comparison(out, totalsOf(prior, 'out'), validOutComparison, range.compare)
  const peakDescription = peak ? `${peakComplete ? '本期高峰' : '已记录峰值'}在 ${new Date(peak.slot.from).toLocaleString('zh-CN')}，${names.in} ${fmt(peak.in)} ${unit}${peakComplete ? '' : '；覆盖不足或未知，无法确定实际高峰'}。` : '没有可用的已记录峰值。'
  const alarmDescription = alarmError ? '告警统计不可用：' + alarmError : alarm ? `按告警去重；另有 ${alarm.association?.unassociated ?? '未知'} 条未关联位置（未计入总数）` : '正在读取告警统计'
  const cutoff = new Date(query.to).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return <main className="alarm-workspace flex min-h-0 min-w-0 flex-col gap-2 overflow-auto lg:h-full">
    <header aria-label="统计筛选与操作" className="flex shrink-0 flex-wrap items-center gap-2">
      <h1 className="text-lg font-semibold leading-7 text-ink">统计分析</h1>
      <AnalyticsSubjectSwitch locations={locations} disabled={counters===null&&!configError}/>
      <details className="relative">
        <summary className={button + ' cursor-pointer list-none [&::-webkit-details-marker]:hidden'}>计数器 {counterIds.length}/{counters?.length ?? 0}<ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="ui-panel absolute left-0 top-full z-30 mt-1 max-h-72 w-72 overflow-auto p-1.5 shadow-lg">
          <p className="px-2 py-1 text-[11px] text-ink-subtle">仅合并目标、方法和方向口径一致的计数器；最多 50 个。</p>
          {counters?.map(c => {
            const compatible = !selectedCounters.length || signature(c) === signature(selectedCounters[0]!)
            return <label key={c.counter_id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-base px-2 text-sm text-ink hover:bg-surface-hover [@media(pointer:coarse)]:min-h-11">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={counterIds.includes(c.counter_id)} disabled={!compatible || (!counterIds.includes(c.counter_id) && counterIds.length >= 50)} onChange={() => selectCounter(c)} />
              <span className="truncate" title={c.name}>{c.name}{!compatible && '（口径不同）'}</span>
            </label>
          })}
        </div>
      </details>
      <details className="relative">
        <summary className={button + ' cursor-pointer list-none [&::-webkit-details-marker]:hidden'}>统计位置 {bindings.length}<ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="ui-panel absolute left-0 top-full z-30 mt-1 max-h-72 w-72 overflow-auto p-1.5 shadow-lg">{selectedCounters.flatMap(c => c.bindings.map(b =>
          <label key={c.counter_id + ':' + b.binding_id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-base px-2 text-sm text-ink hover:bg-surface-hover [@media(pointer:coarse)]:min-h-11">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={bindings.includes(b.binding_id)} onChange={() => toggleBinding(b.binding_id)} />
            <span className="truncate" title={c.name + ' · ' + (b.zone_name || b.zone_id)}>{c.name} · {b.zone_name || b.zone_id}{!b.active ? '（已解绑/历史）' : ''}</span>
          </label>))}
        </div>
      </details>
      <div role="group" aria-label="时间范围" className="flex gap-1">
        {presets.map(([id, name]) => <button key={id} type="button" className={button} aria-pressed={!custom && preset === id} onClick={() => { setCustom(null); setNow(new Date()); setParam('range', id) }}>{name}</button>)}
        <button type="button" aria-label="自选时间范围" aria-pressed={!!custom} className={button} onClick={() => setPicker({ from: toDatetimeLocalValue(range.from), to: toDatetimeLocalValue(new Date(range.to.getTime() - 1000)) })}><CalendarClock size={14} aria-hidden="true" />自选</button>
      </div>
      <button type="button" className={button} aria-pressed={compare} title={`对比${range.compare}；仅在两期覆盖完整时计算变化率`} onClick={() => setCompare(v => !v)}>对比：{compare ? range.compare : '关闭'}</button>
      <span className="ml-auto flex items-center gap-2 text-xs text-ink-subtle">
        {dataReady && <span className="hidden xl:inline" title={`查询截至 ${new Date(query.to).toLocaleString('zh-CN')}；结果可能有写入延迟`}>截至 {cutoff}</span>}
        <button type="button" className={button + ' !px-2'} aria-label="刷新" title="刷新统计" onClick={() => { setNow(new Date()); setRevision(n => n + 1) }}><RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} /></button>
        <button type="button" className={button} disabled={!dataReady} onClick={exportCsv}><Download size={14} aria-hidden="true" />导出 CSV</button>
      </span>
    </header>
    {configError && <p role="alert" className="rounded-base border border-danger bg-danger-50 px-3 py-1 text-xs text-danger-700">{configError}</p>}
    {error && <p role="alert" className="rounded-base border border-danger bg-danger-50 px-3 py-1 text-xs text-danger-700">统计读取失败：{error}</p>}
    {loading && <p role="status" className="py-3 text-center text-sm text-ink-subtle">正在读取统计…</p>}
    {!counterIds.length && counters && !configError && <p className="py-3 text-center text-sm text-ink-subtle">请选择计数器；如尚未配置，请先在流量统计中创建。</p>}
    {counterIds.length > 0 && !bindings.length && <p className="py-3 text-center text-sm text-ink-subtle">请选择至少一个统计位置。</p>}
    <nav role="tablist" aria-label="统计视图" className="flex shrink-0 items-stretch gap-1 border-b border-line">
      {tabs.map(([id, name]) => <button key={id} id={`analytics-tab-${id}`} type="button" role="tab" aria-controls="analytics-panel" aria-selected={tab === id}
        className={`-mb-px shrink-0 border-b-2 px-4 py-1.5 text-sm [@media(pointer:coarse)]:min-h-11 ${tab === id ? 'border-primary font-medium text-primary' : 'border-transparent text-ink-subtle hover:text-ink'}`}
        onClick={() => setParam('tab', id)}>{name}</button>)}
      {dataReady && <p role="status" aria-label="数据状态" title={qualitySummary + ' ' + peakDescription}
        className={`ml-auto flex min-w-0 items-center pl-3 text-xs ${coverageIssue ? 'text-amber-700' : 'text-ink-subtle'}`}>
        <span aria-hidden="true" className={`mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${coverageIssue ? 'bg-warning' : 'bg-success'}`} />
        <span className="truncate">{coverageIssue ? '覆盖不足或未知，已记录量可能偏低' : '采集覆盖完整'}</span>
      </p>}
    </nav>
    {dataReady && <>
      {(tab === 'overview' || tab === 'flow') && <section aria-label="概览" className="grid shrink-0 grid-cols-2 gap-2 lg:grid-cols-4">
        <Kpi label={"已记录"+names.in} value={`${fmt(inn)} ${unit}`}>
          {compare && <span title={inComparison} aria-label={inComparison} className="min-w-0 truncate text-[11px] text-ink-faint">{validInComparison ? inComparison : '对比不足'}</span>}
        </Kpi>
        <Kpi label={both?"已记录"+names.out:"统计方向"} value={both?`${fmt(out)} ${unit}`:"单向计数"}>
          {compare && both && <span title={outComparison} aria-label={outComparison} className="min-w-0 truncate text-[11px] text-ink-faint">{validOutComparison ? outComparison : '对比不足'}</span>}
        </Kpi>
        <Kpi label={peakComplete ? '高峰' : '已记录峰值'} value={peak ? new Date(peak.slot.from).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}>
          <span className="truncate text-[11px] text-ink-faint" title={peakDescription}>{peak ? fmt(peak.in) + ' ' + unit : '无已记录通行'}</span>
        </Kpi>
        <Kpi label="所选热区告警" value={alarm ? <Link className="hover:text-primary" to={'/alarms?' + new URLSearchParams({ status: 'all', from: query.from, to: query.to, locations: JSON.stringify(locations) })}>{fmt(alarm.total)}<span className="ml-1 text-xs font-normal text-ink-faint">条</span></Link> : '—'}>
          <span className={`truncate text-[11px] ${alarmError ? 'text-danger-700' : 'text-ink-faint'}`} title={alarmDescription} aria-label={alarmDescription}>{alarmError ? '暂不可用' : alarm ? alarm.association?.unassociated ? `另有 ${alarm.association.unassociated} 条未定位` : alarm.association?.unassociated === 0 ? '范围内去重告警' : '位置关联未知' : '正在读取'}</span>
        </Kpi>
      </section>}
      {previousError && compare && <p role="alert" className="text-xs text-danger-700">对比期读取失败：{previousError}</p>}
      <div id="analytics-panel" role="tabpanel" aria-labelledby={`analytics-tab-${tab}`} className={`min-w-0 flex-1 ${tab === 'overview' ? 'lg:min-h-[27rem]' : 'min-h-0'}`}>
        {tab === 'overview' && <div className="grid gap-2 lg:h-full lg:grid-cols-[minmax(16rem,3fr)_minmax(0,7fr)] lg:grid-rows-[minmax(0,1fr)]">
          <div className="grid min-h-0 min-w-0 gap-2 lg:overflow-y-auto lg:grid-rows-[minmax(10rem,1fr)_minmax(12rem,0.85fr)_auto]">{trendPanel}{weekPanel}{coveragePreview}</div>
          {heatPanel}
        </div>}
        {tab === 'flow' && <div className="grid gap-2 lg:h-full lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {trendPanel}<div className="grid min-h-0 min-w-0 gap-2 lg:grid-rows-[minmax(0,1fr)_minmax(0,1fr)]">{table}{coverage}</div>
        </div>}
        {tab === 'heat' && <div className="grid gap-2 lg:h-full lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)]">
          {heatPanel}<DwellPanel locations={dwellLocations} from={query.from} to={query.to} bucket={range.bucket} labels={dwellLabels} labelNames={Object.fromEntries((selectedCounters[0]?.labels ?? []).map(l => [l.label_id, l.name]))} onActiveChange={setObservationActive} activeZone={activeZone} onSelectZone={setActiveZone} revision={revision} onVariantChange={receiveHeat} />
        </div>}
        {tab === 'week' && <div className="grid gap-2 lg:h-full lg:grid-rows-[minmax(0,1fr)]">{weekPanel}</div>}
      </div>
      <details aria-label="统计说明" className="relative shrink-0 text-[11px] text-ink-faint">
        <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden"><ChevronDown size={12} aria-hidden="true" /><span>统计说明</span><span className="ml-auto" title={new Date(query.to).toLocaleString('zh-CN')}>截至 {cutoff} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span></summary>
        <div role="region" aria-label="统计说明详情" className="ui-panel absolute bottom-full left-0 right-0 z-30 mb-1 max-h-[60vh] space-y-2 overflow-auto p-3 text-xs text-ink-subtle shadow-lg">
          <p>查询截至 {new Date(query.to).toLocaleString('zh-CN')}；{Intl.DateTimeFormat().resolvedOptions().timeZone}。结果可能有写入延迟，计数为目标通过次数，不等于独立人数；已记录量不代表缺口内为零。</p>
          <p>{qualitySummary}所选位置综合覆盖：{coverageSummary}（按位置有效时长加权）。依据已保存的计数器状态与布防历史计算；历史不完整时显示未知，宽限时间不计入实测覆盖。覆盖不是识别准确率。</p>
          {current && rows.length < selected.length && <p>部分所选位置在本期没有统计序列，合计仅包含已返回的位置。</p>}
          <p>{peakDescription}历史计数线或目标配置变化可能影响对比口径。</p>
          {compare && <p>{names.in}：{inComparison}{both&&<>；{names.out}：{outComparison}</>}。仅在两期位置匹配、覆盖完整时计算变化率。</p>}
          <p>所选热区告警：{alarmDescription}。</p>
        </div>
      </details>
    </>}
    {picker && <DateTimeRangePicker open from={picker.from} to={picker.to} validateRange={validateCustomRange} onConfirm={(from, to) => setCustom({ from: new Date(from), to: new Date(to) })} onClose={() => setPicker(null)} />}
    {drawer && <RecordsDrawer {...drawer} zoneName={z => z.zone_name || z.zone_id} onClose={() => setDrawer(null)} />}
  </main>
}
