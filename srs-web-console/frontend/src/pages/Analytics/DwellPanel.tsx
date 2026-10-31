import { useEffect, useRef, useState } from 'react'
import { request } from '@/api/httpClient'
import { labelDisplay } from '@/features/labelNames'
import type { Bucket } from './analyticsSource'
import { RegionHeatPanel, type HeatVariant } from './RegionHeatPanel'
import { alarmTriggerService, type AlarmSource } from '@/api/alarmTriggerService'
import { csvCell } from './analyticsSource'

const reasons: Record<string, string> = {
  active: '进行中',
  observed_exit: '已观测到离开',
  observation_gap: '观测中断，片段已结束',
  consumer_restart: '采集服务重启，片段已结束',
  session_changed: '视频会话变化，片段已结束',
  configuration_changed: '统计配置变化，片段已结束',
  interval_limit: '观测间隔数量达到上限，片段已截断',
  duration_limit: '观测时长达到上限，片段已截断',
  capacity: '容量不足，片段已截断',
  dwell_capacity: '容量不足',
  tracking_unavailable: '跟踪不可用，片段已结束',
  pts_reset: '视频时间重置，片段已结束',
  input_gap: '输入数据缺失，片段已结束',
  ambiguous_geometry: '无法确定区域穿越，片段已结束',
  invalid_intervals: '观测时间不一致，片段已结束',
  timeout: '观测中断',
  gap: '观测间断',
  exit: '已离开',
  lost: '目标丢失',
  shutdown: '服务停止',
}
const issues: Record<string, string> = {
  dwell_capacity: '容量不足，部分停留观测未记录，数据不完整。',
  dwell_region_capacity: '统计区域数量达到上限，部分区域未记录，数据不完整。',
  dwell_interval_limit: '观测间隔数量达到上限，相关片段已截断，后续时长未计入。',
  dwell_duration_limit: '观测时长达到上限，相关片段已截断，后续时长未计入。',
  dwell_tracking_required: '当前输入缺少可用跟踪，无法形成完整的停留观测片段。',
  dwell_region_conflict: '区域配置存在冲突，相关区域的停留观测不完整。',
  dwell_invalid_intervals: '部分观测时间不一致，相关片段不可完整统计。',
  dwell_restart_unmeasured: '采集服务重启时存在尚未测得时长的片段，数据不完整。',
}
type Location = { channel_id: string; zone_id: string; name: string }
interface Dwell {
  thresholds_ms?: Record<string,number>
  label_map_versions?: (string|null)[]
  selected_label_map_version?: string|null
  observed_ms: number
  visits_started: number
  active_visits: number
  checkpoint_at: string | null
  coverage: string
  semantics: string
  dwell_status?: string
  gaps?: { from: string; to: string | null; reason?: string }[]
  last_issues?: string[]
  retention?: { mode?: string; history_complete?: boolean; oldest_available_at?: string | null }
  samples: {
    visit_id: string
    label_id?: string
    label_map_version?: string|null
    started_at: string
    ended_at?: string
    input_stream_id?: string
    observed_ms: number
    active: boolean
    partial?: boolean
    end_reason: string
    observation_gaps?: boolean
  }[]
}
export function DwellPanel({ locations, from, to, bucket, labels, labelNames, onActiveChange, activeZone, onSelectZone, revision=0, onVariantChange }: {
  locations: Location[]; from: string; to: string; bucket: Bucket; labels: string[]
  activeZone?: string|null; onSelectZone?: (key:string|null)=>void; revision?:number
  onVariantChange?: (zone:string,variant:HeatVariant|null)=>void
  labelNames?: Record<string,string>; onActiveChange?: (active: boolean) => void
}) {
  const [index, setIndex] = useState(''), [data, setData] = useState<Dwell | null>(null)
  const [view, setView] = useState<'dwell' | 'heat'>(onSelectZone?'heat':'dwell')
  const [labelVersion,setLabelVersion]=useState<string|null|undefined>(undefined)
  const [source,setSource]=useState<AlarmSource|null>(null)
  const scope=JSON.stringify([from,to,locations.map(l=>[l.channel_id,l.zone_id]),labels,revision])
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const version = useRef(0), location = locations[Number(index)]
  useEffect(()=>{
    let live=true;setSource(null)
    if(onSelectZone&&index!==''&&location)void alarmTriggerService.source(location.channel_id).then(s=>{if(live)setSource(s)}).catch(()=>{})
    return()=>{live=false}
  },[location?.channel_id,index,onSelectZone])
  const displayLabel = (id: string) => labelDisplay(labelNames && Object.hasOwn(labelNames,id) ? labelNames[id] ?? id : id)
  useEffect(() => { onActiveChange?.(index !== ''); return () => onActiveChange?.(false) }, [index,onActiveChange])
  useEffect(() => {
    version.current++; setData(null); setError(''); setBusy(false);setLabelVersion(undefined)
    if(!onSelectZone)setIndex('')
    return () => { version.current++ }
  }, [scope])
  useEffect(()=>{
    if(!onSelectZone)return
    const i=locations.findIndex(l=>l.zone_id===activeZone)
    setIndex(i>=0?String(i):locations.length===1?'0':'')
    version.current++;setData(null);setError('');setBusy(false);setLabelVersion(undefined)
  },[activeZone,JSON.stringify(locations.map(l=>l.zone_id))])
  const load = async (selectedVersion=labelVersion) => {
    if (index === '' || !location) return
    const v = ++version.current; setBusy(true); setError(''); setData(null)
    try {
      const result = await request<Dwell>('/flow/dwell', {
        method: 'POST',
        body: JSON.stringify({
          channel_id: location.channel_id, zone_id: location.zone_id, from, to, bucket,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          ...(labels.length ? { label_ids: labels } : {}), sample_limit: 10,
          ...(selectedVersion!==undefined?{label_map_version:selectedVersion}:{}),
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (v === version.current) setData(result)
    } catch (e) {
      if (v === version.current) setError(e instanceof Error ? e.message : '停留读取失败')
    } finally { if (v === version.current) setBusy(false) }
  }
  const statusMessages = new Set<string>()
  useEffect(()=>{if(onSelectZone&&index!==''&&view==='dwell')void load()},[scope,index,view])
  const exportSamples=()=>{
    if(!data)return
    const rows:(string|number)[][]=[['位置','类别编号','类别版本','开始','结束','已观测秒','结束原因','口径'],...data.samples.map(s=>[location?.name??'',s.label_id??'',s.label_map_version??'未知',s.started_at,s.ended_at??'',s.observed_ms/1000,s.active?'进行中':reasons[s.end_reason]??s.end_reason,'限量片段样本；真实观测时长下限，不代表完整停留'])]
    const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}))
    const a=document.createElement('a');a.href=url;a.download='停留片段样本.csv';a.click();URL.revokeObjectURL(url)
  }
  if (data?.dwell_status === 'capacity_suspended') statusMessages.add('停留采集因容量限制已暂停，该时段数据不完整。')
  else if (data?.dwell_status && data.dwell_status !== 'active') statusMessages.add('停留采集状态未知，无法确认该时段数据完整。')
  if (data?.gaps?.length) {
    statusMessages.add(`查询时段内有 ${data.gaps.length} 段采集缺口${data.gaps.some(g => g.to === null) ? '，其中有缺口尚未结束' : ''}，数据不完整。`)
    for (const gap of data.gaps) if (gap.reason && reasons[gap.reason]) statusMessages.add('采集缺口原因：' + reasons[gap.reason] + '。')
  }
  for (const issue of data?.last_issues ?? []) statusMessages.add(issues[issue] ?? '最近的停留采集存在异常，数据可能不完整。')
  for (const sample of data?.samples ?? []) {
    if (sample.end_reason === 'interval_limit') statusMessages.add(issues.dwell_interval_limit!)
    if (sample.end_reason === 'duration_limit') statusMessages.add(issues.dwell_duration_limit!)
    if (sample.end_reason === 'capacity') statusMessages.add(issues.dwell_capacity!)
  }
  const updateTime = data?.checkpoint_at ? Date.parse(data.checkpoint_at) : NaN
  const updateBeforeEnd = Number.isFinite(updateTime) && updateTime < Date.parse(to)
  return <section className="ui-panel min-h-0 space-y-2 overflow-auto p-3" aria-label="停留观测">
    <header className="flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold">区域观测</h2>
      <select aria-label="停留位置" className="form-input !w-auto !py-1 text-xs [@media(pointer:coarse)]:min-h-11" value={index} onChange={e => {
        version.current++; setIndex(e.target.value);onSelectZone?.(e.target.value===''?null:locations[Number(e.target.value)]?.zone_id??null);setLabelVersion(undefined); setData(null); setError(''); setBusy(false)
      }}>
        <option value="">选择位置</option>
        {locations.map((l, i) => <option key={l.channel_id + ':' + l.zone_id} value={i}>{l.name}</option>)}
      </select>
      {view === 'dwell' && <button type="button" className="btn-secondary ml-auto !px-2.5 !py-1 text-xs [@media(pointer:coarse)]:min-h-11" disabled={index === '' || busy} onClick={() => void load()}>查询停留</button>}
    </header>
    <div role="tablist" aria-label="区域观测方式" className="flex gap-4 border-b border-line text-xs">
      <button type="button" role="tab" aria-selected={view === 'dwell'} className="border-b-2 border-transparent px-1 py-2 text-ink-subtle aria-selected:border-primary aria-selected:text-primary [@media(pointer:coarse)]:min-h-11" onClick={() => setView('dwell')}>停留片段</button>
      <button type="button" role="tab" aria-selected={view === 'heat'} className="border-b-2 border-transparent px-1 py-2 text-ink-subtle aria-selected:border-primary aria-selected:text-primary [@media(pointer:coarse)]:min-h-11" onClick={() => setView('heat')}>画面热度</button>
    </div>
    <p className="text-[11px] text-ink-subtle" title="分析期间固定查询截止时间；使用顶部刷新读取最新数据。">筛选类别：{labels.length ? labels.map(displayLabel).join('、') : '全部类别'}（当前计数器类别）。<span title="历史类别变更时不能直接与通行次数核对。">统计范围与顶部筛选一致</span></p>
    {view === 'heat' ? index !== '' && location
      ? <RegionHeatPanel key={location.channel_id + ':' + location.zone_id} location={location} from={from} to={to} labels={labels} autoLoad={!!onSelectZone} revision={revision} onVariantChange={onVariantChange} />
      : <p className="text-sm text-ink-subtle">先选择统计位置，再查询该位置的画面观测热度。</p>
      : <>
    <p className="text-xs text-ink-subtle">真实观测时长下限 · 覆盖未知 · 不代表完整停留或独立人数</p>
    <details className="text-[11px] text-ink-subtle"><summary className="cursor-pointer">停留数据说明</summary>
      <p>仅为真实观测时长的下限，覆盖未知；首次在区内出现不证明进入。不超过 1.5 秒的短暂间断可保留同一片段身份，但间断时间不计入停留；更长的中断会拆分片段。重启等情况也会结束片段，不能代表完整停留时间或人数。</p>
      <p>停留观测采用限量滚动保留，早期数据可能已过期；无记录不代表无人停留。历史类别变更时不能直接与通行次数核对。</p>
    </details>
    {busy && <p role="status">正在读取停留观测…</p>}
    {error && <p role="alert">停留暂不可用：{error}</p>}
    {data && statusMessages.size > 0 && <div role="status" aria-label="停留数据状态" className="rounded-base border border-warning bg-amber-50 p-2 text-xs text-ink">
      {Array.from(statusMessages, message => <p key={message}>{message}</p>)}
    </div>}
    {data?.label_map_versions && <label className="flex items-center gap-2 text-xs">类别版本<select aria-label="停留类别版本" className="form-input min-w-0 flex-1 !py-1" value={data.selected_label_map_version??''} onChange={e=>{const v=e.target.value||null;setLabelVersion(v);void load(v)}}>{data.label_map_versions.map(v=><option key={v??'unknown'} value={v??''}>{v??'历史版本未记录'}</option>)}</select><span>各版本独立统计</span></label>}
    {data && (data.visits_started === 0 && data.observed_ms === 0
      ? <p>没有已记录的观测片段，覆盖未知，不能推断无人停留。</p>
      : <>
        <div className="grid grid-cols-3 gap-2" aria-label="停留指标">
          <div className="rounded-base bg-surface-page p-2"><p className="text-[11px] text-ink-subtle">累计观测下限</p><strong className="text-lg tabular-nums">{(data.observed_ms/1000).toLocaleString('zh-CN',{maximumFractionDigits:1})}</strong><span className="text-xs"> 目标·秒</span></div>
          <div className="rounded-base bg-surface-page p-2"><p className="text-[11px] text-ink-subtle">开始观测片段</p><strong className="text-lg tabular-nums">{data.visits_started}</strong><span className="text-xs"> 个</span></div>
          <div className="rounded-base bg-surface-page p-2"><p className="text-[11px] text-ink-subtle">进行中片段</p><strong className="text-lg tabular-nums">{data.active_visits}</strong><span className="text-xs"> 个</span></div>
        </div>
        {data.thresholds_ms&&<div className="space-y-1.5 py-1" aria-label="停留阈值分布">{Object.entries(data.thresholds_ms).map(([ms,count])=><div key={ms} className="flex items-center gap-2 text-xs"><span className="w-20">至少 {Number(ms)/1000} 秒</span><span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-page"><span className="block h-full rounded-full bg-primary" style={{width:`${data.visits_started?count/data.visits_started*100:0}%`}}/></span><span className="w-12 text-right">{count} 个</span></div>)}<p className="text-[11px] text-ink-faint">阈值为累计口径，各档包含关系，不能相加。</p></div>}
        <div className="flex items-center justify-between text-xs"><strong>观测片段样本</strong><button type="button" className="btn-secondary !px-2 !py-1" onClick={exportSamples}>导出片段样本</button></div>
        <ul className="divide-y divide-line text-xs text-ink-subtle">{data.samples.map(s => <li className="py-2 leading-5" key={s.visit_id}>
          {new Date(s.started_at).toLocaleString('zh-CN')} · {s.label_id ? (source&&s.label_map_version===source.label_map_version?labelDisplay(source.labels.find(l=>l.label_id===s.label_id)?.name??s.label_id):s.label_map_version? s.label_id : s.label_id+'（类别版本未记录）') + ' · ' : ''}
          至少 {(s.observed_ms / 1000).toFixed(1)} 秒 · {s.active ? '进行中' : reasons[s.end_reason] ?? '观测结束，原因未识别'}
          {s.partial ? ' · 非完整停留' : ''}{s.observation_gaps ? ' · 含短暂观测间断，间断时间未计入' : ''}
        </li>)}</ul>
      </>)}
    {data && <div className="text-xs text-ink-faint">
      <p>数据更新截至：{Number.isFinite(updateTime) ? new Date(updateTime).toLocaleString('zh-CN') : '未知'}；不同数据来源的更新时间可能不同。</p>
      {updateBeforeEnd && <p>数据尚未更新到查询结束时间，之后的停留观测可能尚未写入。</p>}
      {!Number.isFinite(updateTime) && <p>无法确认停留数据已更新到何时。</p>}
      {data.retention?.history_complete === false && <p>返回的历史记录不保证完整，不能据此确认没有缺失。</p>}
      {data.retention?.oldest_available_at && <p>现存最早片段开始于 {new Date(data.retention.oldest_available_at).toLocaleString('zh-CN')}，不代表该时间之后覆盖完整。</p>}
    </div>}
    </>}
  </section>
}
