import {BehaviorHistoryPanel} from './BehaviorHistoryPanel'
import type {BehaviorHistoryQuery} from '@/api/behaviorHistoryService'
import {useEffect,useRef,useState} from 'react'
import {Link} from 'react-router-dom'
import {alarmTriggerService} from '@/api/alarmTriggerService'
import {behaviorNames as names,triggerBehaviors} from '@/features/alarmTriggers'
import {alarmZoneService} from '@/api/alarmZoneService'
import {aiChannelService} from '@/api/aiChannelService'
import {behaviorStatisticsService,type BehaviorStatistics,type StatisticsQuery} from '@/api/behaviorStatisticsService'
const localTime=(date:Date)=>new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16)
const format=(value:string)=>new Date(value).toLocaleString()
const control='form-input'
export default function BehaviorStatisticsPage(){
 const [from,setFrom]=useState(()=>localTime(new Date(Date.now()-3600000)))
 const [to,setTo]=useState(()=>localTime(new Date()))
 const [channel,setChannel]=useState(''),[behavior,setBehavior]=useState('')
 const [zone,setZone]=useState(''),[label,setLabel]=useState(''),[rule,setRule]=useState('')
 const [zones,setZones]=useState<{id:string;name:string}[]>([]),[labels,setLabels]=useState<{id:string;name:string}[]>([]),[rules,setRules]=useState<{id:string;name:string}[]>([])
 const [filterError,setFilterError]=useState(false)
 const [timezone,setTimezone]=useState(()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC')
 const [group,setGroup]=useState('')
 useEffect(()=>{let active=true;setZones([]);setLabels([]);setRules([]);setFilterError(false)
  // History filters come from saved rules (parameter store); the live source only adds
  // current names, so an offline camera or a changed model never hides past data.
  if(channel)void (async()=>{
   const [list,source]=await Promise.allSettled([alarmTriggerService.list(),alarmTriggerService.source(channel)])
   const triggers=(list.status==='fulfilled'?list.value.items:[]).filter(t=>t.bindings.some(b=>b.channel_id===channel))
   const live=source.status==='fulfilled'?source.value:null
   const areas=live?await alarmZoneService.list(live.input_stream_id).then(r=>r.items,()=>[]):[]
   const zoneNames=new Map<string,string>()
   for(const t of triggers)for(const b of t.bindings)if(b.channel_id===channel&&b.zone_id)zoneNames.set(b.zone_id,b.zone_snapshot?.name??b.zone_id)
   for(const z of areas)zoneNames.set(z.zone_id,z.name)
   const labelNames=new Map<string,string>()
   for(const t of triggers)for(const l of t.labels)labelNames.set(l.label_id,l.name)
   for(const l of live?.labels??[])labelNames.set(l.label_id,l.name||l.description||l.label_id)
   if(!active)return
   setZones([...zoneNames].map(([id,name])=>({id,name})));setLabels([...labelNames].map(([id,name])=>({id,name})))
   setRules(triggers.map(t=>({id:t.trigger_id,name:`${t.name} · ${names[t.behavior]??t.behavior}`})))
   if(list.status==='rejected'&&!live)setFilterError(true)
  })()
  return()=>{active=false}
 },[channel])
 const dimensions={...(zone?{zone_id:zone}:{}),...(label?{label_id:label}:{}),...(rule?{trigger_id:rule}:{}),...(channel?{channel_id:channel}:{})}
 const groupLabel=(value:string|number|null|undefined)=>group==='trigger'?(rules.find(r=>r.id===value)?.name??'历史规则'):typeof value==='number'?['上（12点）','右上','右（3点）','右下','下（6点）','左下','左（9点）','左上'][value]:'方向未确定'
 const [bucket,setBucket]=useState<StatisticsQuery['bucket']>('hour')
 const [channels,setChannels]=useState<{id:string;name:string}[]>([])
 const [catalogError,setCatalogError]=useState(false)
 const [result,setResult]=useState<BehaviorStatistics|null>(null)
 const [error,setError]=useState(''),[busy,setBusy]=useState(false)
 const [history,setHistory]=useState<BehaviorHistoryQuery|null>(null)
 const mounted=useRef(true)
 useEffect(()=>{mounted.current=true;let active=true
  void aiChannelService.list().then(rows=>{if(active)setChannels(rows.map(c=>({id:c.id,name:c.name})))})
   .catch(()=>{if(active)setCatalogError(true)})
  return()=>{active=false;mounted.current=false}
 },[])
 const query=async()=>{
  if(busy)return
  const start=new Date(from).getTime(),end=new Date(to).getTime()
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>31*86400000){setError('请选择结束晚于开始、且不超过 31 天的时间范围');return}
  try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{setError('请选择有效的统计时区，例如 Asia/Shanghai');return}
  const unit={minute:60000,hour:3600000,day:86400000}[bucket]
  if(Math.ceil(end/unit)-Math.floor(start/unit)>1500){setError('时间分段超过 1500 个，请缩短范围或改用小时、天');return}
  setBusy(true);setError('');setResult(null);setHistory(null)
  try{
   const next=await behaviorStatisticsService.query({from:new Date(start).toISOString(),to:new Date(end).toISOString(),bucket,timezone,...dimensions,...(group?{group_by:group as StatisticsQuery['group_by']}:{}),...(behavior?{event_type:behavior}:{})})
   if(mounted.current)setResult(next)
  }catch{if(mounted.current)setError('统计查询失败，未获得数据。请检查告警服务配置和连接后重新查询。')}
  finally{if(mounted.current)setBusy(false)}
 }
 return <main className="alarm-workspace space-y-4 p-4 md:p-6">
  <header><h1 className="page-title">行为统计</h1><p className="mt-1 text-sm text-ink-subtle">查询已记录的行为，统计与告警确认互不影响。</p></header>
  <form onChange={()=>{setResult(null);setHistory(null);setError('')}} onSubmit={e=>{e.preventDefault();void query()}} className="rounded border border-line bg-surface p-4">
   <fieldset disabled={busy} className="flex flex-wrap items-end gap-3">
    <legend className="mb-3 font-medium">查询条件</legend>
    <label className="grid gap-1 text-sm">开始时间<input className={control} type="datetime-local" required value={from} onChange={e=>setFrom(e.target.value)}/></label>
    <label className="grid gap-1 text-sm">结束时间<input className={control} type="datetime-local" required value={to} onChange={e=>setTo(e.target.value)}/></label>
    <label className="grid gap-1 text-sm">AI 通道<select className={control} value={channel} onChange={e=>{setChannel(e.target.value);setZone('');setLabel('');setRule('')}}><option value="">全部通道</option>{channels.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <label className="grid gap-1 text-sm">行为<select className={control} value={behavior} onChange={e=>setBehavior(e.target.value)}><option value="">全部行为</option>{triggerBehaviors.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
    <label className="grid gap-1 text-sm">时间分段<select className={control} value={bucket} onChange={e=>setBucket(e.target.value as StatisticsQuery['bucket'])}><option value="minute">每分钟</option><option value="hour">每小时</option><option value="day">每天</option></select></label>
    {channel&&<><label className="grid gap-1 text-sm">警戒区域<select className={control} value={zone} onChange={e=>setZone(e.target.value)}><option value="">全部区域</option>{zones.map(z=><option key={z.id} value={z.id}>{z.name}</option>)}</select></label><label className="grid gap-1 text-sm">目标标签<select className={control} value={label} onChange={e=>setLabel(e.target.value)}><option value="">全部标签</option>{labels.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label><label className="grid gap-1 text-sm">触发器<select className={control} value={rule} onChange={e=>setRule(e.target.value)}><option value="">全部触发器</option>{rules.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label></>}
    <label className="grid gap-1 text-sm">统计时区<input className={control} value={timezone} onChange={e=>setTimezone(e.target.value)} required list="statistics-timezones"/><datalist id="statistics-timezones"><option value="Asia/Shanghai"/><option value="UTC"/></datalist></label>
    <label className="grid gap-1 text-sm">分组<select className={control} value={group} onChange={e=>setGroup(e.target.value)}><option value="">按行为汇总</option><option value="trigger">按触发器</option><option value="entry_direction">按进入方位</option><option value="exit_direction">按离开方位</option><option value="movement_direction">按运动方向</option></select></label>
    <button className="btn-primary self-end" type="submit">{busy?'查询中…':'查询'}</button>
   </fieldset>
   <p className="mt-3 text-xs text-ink-subtle">按当前设备浏览器时区输入时间；分段按所选时区的整点或零点划分，自动处理夏令时。统计包含开始时刻，不包含结束时刻。</p>
   {filterError&&<p role="status">区域、标签或规则目录读取失败，可查询通道汇总；重新选择通道可重试。</p>}
   {catalogError&&<p role="status" className="mt-2 text-sm">通道目录读取失败，仍可查询全部通道；刷新页面可重试目录读取。</p>}
  </form>
  {error&&<div role="alert" className="rounded border border-line p-3">{error} <Link className="underline" to="/config-center?category=alarm-service">查看服务配置</Link></div>}
  {!result&&!error&&!busy&&<p>选择查询条件后点击“查询”。</p>}
  {result&&<section className="space-y-4" aria-label="统计结果">
   <p className="text-sm">查询时间：{format(result.from)} 至 {format(result.to)}</p>
   <p role="status" className="rounded border border-line p-3">{result.coverage.state==='complete'?'输入覆盖完整。':'数据覆盖尚未确认，以下仅为已记录事件；空白时段不代表零事件。'}</p>
   <p className="text-sm text-ink-subtle">同一目标可发生多种行为，各行为次数不能相加当作人数。跟踪目标数不是去重后的真实人数；多个规则可能记录同一次活动；“规则触发次数”会分别计算，请按规则筛选或查看已跨规则去重的跟踪目标数。方向分组以画面上方为 12 点钟，每 45° 一档。</p>
   {!result.items.length?<p>此范围没有已记录的行为。</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="pb-2 text-left font-medium">区间合计</caption><thead><tr><th className="p-3">行为</th>{group&&<th>分组</th>}<th>规则触发次数</th><th>跟踪目标数</th></tr></thead><tbody>{result.items.map(row=><tr className="border-t border-line" key={`${row.event_type}:${row.group}`}><th className="p-3 font-normal">{names[row.event_type]??row.event_type}</th>{group&&<td>{groupLabel(row.group)}</td>}<td><button className="px-2 text-sm text-primary hover:underline" aria-label={`查看${names[row.event_type]??row.event_type}记录`} disabled={!!group&&group!=='rule'} onClick={()=>setHistory({...(group==='rule'&&typeof row.group==='string'?{rule_id:row.group}:{}),...dimensions,from:result.from,to:result.to,...(channel?{channel_id:channel}:{}),event_type:row.event_type})}>{row.occurrences}</button></td><td>{row.tracked_targets}</td></tr>)}</tbody></table></div>}
   {!!result.buckets?.length&&<details open><summary className="cursor-pointer py-2 text-sm font-medium text-ink">分时明细</summary><p className="text-xs text-ink-subtle">各时间段目标数不可直接相加；区间合计已跨时间段去重。仅显示有记录的时段。</p><div className="max-h-96 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-3">时间段</th><th>行为</th>{group&&<th>分组</th>}<th>规则触发次数</th><th>目标数</th></tr></thead><tbody>{result.buckets.map(row=><tr className="border-t border-line" key={`${row.from}:${row.event_type}:${row.group}`}><td className="p-3 whitespace-nowrap">{format(row.from)} — {format(row.to)}</td><td>{names[row.event_type]??row.event_type}</td>{group&&<td>{groupLabel(row.group)}</td>}<td><button className="px-2 text-sm text-primary hover:underline" aria-label={`查看此时段${names[row.event_type]??row.event_type}记录`} disabled={!!group&&group!=='rule'} onClick={()=>setHistory({...(group==='rule'&&typeof row.group==='string'?{rule_id:row.group}:{}),...dimensions,from:row.from,to:row.to,...(channel?{channel_id:channel}:{}),event_type:row.event_type})}>{row.occurrences}</button></td><td>{row.tracked_targets}</td></tr>)}</tbody></table></div></details>}
  </section>}
  {history&&<BehaviorHistoryPanel key={JSON.stringify(history)} query={history} onClose={()=>setHistory(null)}/>}
 </main>
}