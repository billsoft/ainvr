import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { request } from '@/api/httpClient'
import { csvCell } from './analyticsSource'
import { HeatScene } from './HeatScene'

export interface HeatVariant {
  input_stream_id: string
  geometry_revision: string
  stream_session_id?: string
  label_map_version?: string | null
  anchor?: string
  view_epoch: string | null
  zone_version: number
  source_width: number
  source_height: number
  columns: number
  rows: number
  values_ms: number[]
  observed_ms: number
  from: string
  to: string
}
interface HeatResult {
  variants: HeatVariant[]
  effective_from: string | null
  effective_to: string | null
  checkpoint_at: string | null
  semantics: string
  coverage: string
  status: string
  session_scope?: string
  gaps?: { from: string; to: string | null }[]
  issues?: string[]
  retention?: { history_complete: boolean; oldest_available_at?: string | null }
}
type Location = { channel_id: string; zone_id: string; name: string }
const stamp = (v: string) => new Date(v).toLocaleString('zh-CN')
const seconds = (ms: number) => (ms / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
function checkedResult(value: HeatResult): HeatResult {
  if (!value || !Array.isArray(value.variants) || value.variants.length > 64 ||
      value.semantics !== 'lower_bound_observed_target_time' || value.coverage !== 'unknown') {
    throw new Error('画面热度响应不完整，请刷新或缩短时段重试')
  }
  const noMinutes = value.effective_from === null && value.effective_to === null
  if (noMinutes ? value.variants.length > 0 :
      typeof value.effective_from !== 'string' || typeof value.effective_to !== 'string' ||
      !Number.isFinite(Date.parse(value.effective_from)) || !Number.isFinite(Date.parse(value.effective_to)) ||
      Date.parse(value.effective_to) <= Date.parse(value.effective_from)) {
    throw new Error('完整分钟范围无效，没有显示可能错误的分布')
  }
  for (const v of value.variants) {
    if (v.columns !== 16 || v.rows !== 9 || !Array.isArray(v.values_ms) || v.values_ms.length !== v.columns * v.rows ||
        v.values_ms.some(n => !Number.isSafeInteger(n) || n < 0) ||
        !Number.isSafeInteger(v.observed_ms) || v.observed_ms < 0 ||
        v.values_ms.reduce((n, x) => n + x, 0) !== v.observed_ms ||
        !Number.isInteger(v.source_width) || !Number.isInteger(v.source_height) ||
        v.source_width < 1 || v.source_width > 32768 || v.source_height < 1 || v.source_height > 32768 ||
        !Number.isFinite(Date.parse(v.from)) || !Number.isFinite(Date.parse(v.to))) {
      throw new Error('画面热度网格无效，没有显示可能错误的分布')
    }
  }
  return value
}

export function heatCsv(name: string, result: HeatResult, variant: HeatVariant): string {
  const { effective_from, effective_to } = result
  if (!effective_from || !effective_to) throw new Error('没有可导出的完整分钟')
  const rows: (string | number)[][] = [['热区','来源','区域版本','几何标识','模型类别版本','视频会话口径','观测锚点','画面宽','画面高','完整分钟起','完整分钟止','行','列','网格分配目标秒','覆盖','口径']]
  variant.values_ms.forEach((n, i) => rows.push([name, variant.input_stream_id, variant.zone_version,
    variant.geometry_revision, variant.label_map_version ?? '未记录',
    result.session_scope === 'compatible_source_geometry' ? '同一来源坐标和类别版本的各会话累计' : variant.stream_session_id ?? '未记录', variant.anchor ?? '',
    variant.source_width, variant.source_height, effective_from, effective_to,
    Math.floor(i / variant.columns) + 1, i % variant.columns + 1, n / 1000, '未知',
    '相邻真实观测时段分配给前一锚点网格；非精确驻留计时；零表示未记录时长，不证明无人；画面坐标，非地面坐标']))
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n')
}

/** Source-coordinate summaries from the original observation consumer, never synthetic passage heat. */
export function RegionHeatPanel({ location, from, to, labels, autoLoad=false, revision=0, onVariantChange }: {
  location: Location; from: string; to: string; labels: string[]; autoLoad?: boolean; revision?: number
  onVariantChange?: (zone:string,variant:HeatVariant|null)=>void
}) {
  const [result, setResult] = useState<HeatResult | null>(null)
  const [variantIndex, setVariantIndex] = useState(0), [cell, setCell] = useState<number | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [opacity,setOpacity]=useState(65),[threshold,setThreshold]=useState(0)
  const [timeWindow,setTimeWindow]=useState('all')
  const duration=Date.parse(to)-Date.parse(from),step=duration>2*86400000?86400000:3600000
  const windows=Array.from({length:Math.ceil(duration/step)},(_,i)=>({from:new Date(Date.parse(from)+i*step).toISOString(),to:new Date(Math.min(Date.parse(to),Date.parse(from)+(i+1)*step)).toISOString()}))
  const selectedWindow=timeWindow==='all'?null:windows[Number(timeWindow)]
  useEffect(()=>setTimeWindow('all'),[from,to])
  const version = useRef(0), controller = useRef<AbortController | null>(null)
  const labelKey = JSON.stringify(labels)
  useEffect(() => {
    version.current++; controller.current?.abort()
    setResult(null); setError(''); setBusy(false); setVariantIndex(0); setCell(null)
    return () => { version.current++; controller.current?.abort() }
  }, [location.channel_id, location.zone_id, from, to, labelKey, revision])
  const load = async () => {
    const generation = ++version.current
    controller.current?.abort(); const next = new AbortController(); controller.current = next
    setBusy(true); setError(''); setResult(null); setCell(null); setVariantIndex(0)
    try {
      const value = checkedResult(await request<HeatResult>('/flow/heat', {
        method: 'POST', body: JSON.stringify({ channel_id: location.channel_id, zone_id: location.zone_id, from:selectedWindow?.from??from, to:selectedWindow?.to??to,
          ...(labels.length ? { label_ids: labels } : {}) }),
        signal: AbortSignal.any([next.signal, AbortSignal.timeout(30000)]),
      }))
      if (version.current === generation) setResult(value)
    } catch (e) {
      if (version.current === generation) setError((e as { status?: number }).status === 422
        ? '网格数量或画面版本超过上限，请缩短时段重试' : e instanceof Error ? e.message : '读取失败')
    } finally { if (version.current === generation) setBusy(false) }
  }
  useEffect(()=>{if(autoLoad)void load()},[location.channel_id,location.zone_id,from,to,labelKey,revision,autoLoad,timeWindow])
  const variant = result?.variants[variantIndex]
  useEffect(()=>{onVariantChange?.(location.zone_id,variant??null);return()=>onVariantChange?.(location.zone_id,null)},[variant,location.zone_id,onVariantChange])
  const actualMax = Math.max(0, ...(variant?.values_ms ?? [])), max = Math.max(1, actualMax)
  const bounds = result?.effective_from && result.effective_to ? { from: result.effective_from, to: result.effective_to } : null
  const queryNarrowed = bounds && (Date.parse(bounds.from) !== Date.parse(from) || Date.parse(bounds.to) !== Date.parse(to))
  const collectionIssues = result?.issues?.filter(issue => !['partial_edges_discarded','open_minute_lag','heat_label_map_unknown'].includes(issue)) ?? []
  const exportGrid = () => {
    if (!result || !variant) return
    const url = URL.createObjectURL(new Blob([heatCsv(location.name, result, variant)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = '画面观测热度.csv'; a.click(); URL.revokeObjectURL(url)
  }
  const sourceIsUuid = variant && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(variant.input_stream_id)
  return <div className="space-y-2" role="region" aria-label="画面观测热度">
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="热度时段" className="form-input !w-auto max-w-[13rem] !py-1 text-xs" value={timeWindow} onChange={e=>setTimeWindow(e.target.value)}><option value="all">整个查询时段</option>{windows.map((w,i)=><option key={w.from} value={i}>{new Date(w.from).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} — {new Date(w.to).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</option>)}</select>
      <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" disabled={busy} onClick={() => void load()}>查询画面热度</button>
      {variant && <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" onClick={exportGrid}>导出网格 CSV</button>}
      {sourceIsUuid && bounds && <Link className="ml-auto text-xs text-primary hover:underline" to={`/playback/${encodeURIComponent(variant.input_stream_id)}?${new URLSearchParams({ from: String(Date.parse(bounds.from)), to: String(Date.parse(bounds.to)) })}`}>查看该时段录像</Link>}
    </div>
    {busy && <p role="status">正在读取画面观测热度…</p>}
    {error && <p role="alert" className="rounded-base bg-amber-50 p-2 text-xs">画面热度暂不可用：{error}</p>}
    {result && <>
      {result.checkpoint_at&&Date.parse(to)-Date.parse(result.checkpoint_at)>120000&&<p role="status" className="rounded-base border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">数据只更新到 {stamp(result.checkpoint_at)}，尚未覆盖查询结束时间。<Link to="/ai-channels" className="ml-1 underline">检查通道状态</Link></p>}
      {result.status === 'capacity_suspended' && <p role="status" className="rounded-base bg-amber-50 p-2 text-xs">画面热度采集因容量限制已暂停，数据不完整。</p>}
      {!!result.gaps?.length && <p role="status" className="text-xs text-amber-700">查询时段有 {result.gaps.length} 段采集缺口，未记录时长不能推断为零。</p>}
      {collectionIssues.length > 0 && <p role="status" className="text-xs text-amber-700">最近的热度采集存在异常或截断，当前结果可能不完整。</p>}
      {!bounds ? <p className="text-sm">所选时段没有完整分钟，请扩大查询时段；没有把边缘时间摊进网格。</p>
        : !variant ? <p>没有已记录的完整分钟网格；覆盖未知，不能推断无人或恢复更早的热度。</p> : <>
        <div className="flex flex-wrap items-center gap-2 rounded-base bg-surface-page px-2.5 py-2">
          <span className="text-xs text-ink-subtle">已观测至少</span><strong className="text-lg tabular-nums">{seconds(variant.observed_ms)}</strong><span className="text-xs text-ink-subtle">目标·秒</span>
          {result.variants.length > 1 && <select className="form-input ml-auto min-h-7 !w-auto max-w-[65%] !py-1 text-xs" aria-label="热度画面版本" value={variantIndex} onChange={e => { setVariantIndex(Number(e.target.value)); setCell(null) }}>
            {result.variants.map((v, i) => <option key={i} value={i}>第 {i + 1} 组 · 区域版本 {v.zone_version} · {stamp(v.from)} — {stamp(v.to)}</option>)}
          </select>}
        </div>
        <HeatScene key={JSON.stringify([variant.input_stream_id,variant.geometry_revision,variant.view_epoch,variant.from,variant.to])} variant={variant}>
          <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${variant.source_width} ${variant.source_height}`} role="img" aria-label="原画面坐标的观测时长网格，可用下方选择器读取">
            {variant.values_ms.map((n, i) => <rect key={i} x={(i % variant.columns) * variant.source_width / variant.columns} y={Math.floor(i / variant.columns) * variant.source_height / variant.rows}
              width={variant.source_width / variant.columns} height={variant.source_height / variant.rows}
              fill={n > 0 && n/max>=threshold/100 ? `hsla(${Math.round(220 * (1 - n / max))},90%,50%,${opacity/100})` : 'transparent'}
              stroke={cell === i ? '#0f172a' : 'transparent'} strokeWidth={cell === i ? 4 : 0}
              onClick={() => setCell(i)} aria-hidden="true" />)}
          </svg>
        </HeatScene>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-subtle">
          <span className="flex items-center gap-1">低<span className="h-1.5 w-16 rounded-full" style={{background:'linear-gradient(90deg,#38bdf8,#22c55e,#facc15,#ef4444)'}}/>高</span>
          <label className="flex items-center gap-1">透明度<input aria-label="热度透明度" type="range" min={10} max={100} value={opacity} onChange={e=>setOpacity(Number(e.target.value))} className="w-16 accent-primary" /></label>
          <label className="flex items-center gap-1">隐藏冷区<input aria-label="画面隐藏冷区" type="range" min={0} max={95} step={5} value={threshold} onChange={e=>setThreshold(Number(e.target.value))} className="w-16 accent-primary" /></label>
          <span title="只影响显示，导出保留全部原始值">{threshold}%</span>
        </div>
        <label className="flex min-w-0 items-center gap-2 text-xs">网格读数<select aria-label="热度网格读数" className="form-input min-h-7 min-w-0 flex-1 !py-1 text-xs" value={cell ?? ''} onChange={e => setCell(e.target.value === '' ? null : Number(e.target.value))}>
          <option value="">点击图中网格或选择位置</option>{variant.values_ms.map((n, i) => <option key={i} value={i}>第 {Math.floor(i / variant.columns) + 1} 行，第 {i % variant.columns + 1} 列 · {seconds(n)} 目标·秒</option>)}
        </select></label>
        {cell !== null && <p role="status" className="text-xs">第 {Math.floor(cell / variant.columns) + 1} 行，第 {cell % variant.columns + 1} 列：累计分配 {seconds(variant.values_ms[cell] ?? 0)} 目标·秒；覆盖未知。</p>}
      </>}
    </>}
    <div className="flex flex-wrap items-center justify-between gap-1 border-t border-line pt-2 text-[11px] text-ink-faint">
      <span>观测下限 · 覆盖未知 · 非地面投影</span>
      {result && <span>数据更新：{result.checkpoint_at ? stamp(result.checkpoint_at) : '未知'}</span>}
    </div>
    <details className="text-[11px] leading-5 text-ink-subtle"><summary className="cursor-pointer">画面热度说明</summary>
      <p>相邻真实观测间的时长分配给前一个锚点所在网格，不是精确的逐格驻留计时。单位为目标·秒，多目标同时停留会相加；总量为观测下限，不是人数或完整停留。画面坐标未投影到平面图，网格大小不代表实际面积。</p>
      <p>只查询完整分钟摘要；边缘不足一分钟和仍在采集的分钟不计入。不回填历史热度，不按通行次数扩散颜色。采用限量滚动保留，历史不保证完整；没有摘要不代表没有活动。</p>
      {bounds && <p>统计摘要范围：{stamp(bounds.from)} — {stamp(bounds.to)}。{queryNarrowed && '与顶部范围不同：已排除边缘不足一分钟的时间。'}{selectedWindow&&'当前只显示所选分时窗口。'}</p>}
      {result?.issues?.includes('heat_label_map_unknown') && <p>部分历史摘要没有模型类别版本，单独显示，未与已知版本混合。</p>}
      {result?.issues?.includes('open_minute_lag') && <p>仍在采集的分钟尚未发布，当前只显示已封存的分钟摘要。</p>}
      {result && result.variants.length > 1 && <p>来源、区域或画面设置不同的记录分组显示，没有合并到同一坐标图。</p>}
      {result?.session_scope === 'compatible_source_geometry' && <p>同一来源、坐标设置与模型类别版本下的多次视频会话累计时长，不进行跨会话人员去重。</p>}
      {variant && <><p>区域版本 {variant.zone_version} · 原画面 {variant.source_width}×{variant.source_height}</p><p>来源：{variant.input_stream_id}；几何标识：{variant.geometry_revision}；模型类别版本：{variant.label_map_version ?? '未记录'}。</p>
        <p>本组相对强度：透明区域为未记录时长，蓝→红表示累计分配时长增加；最高格累计分配 {seconds(actualMax)} 目标·秒。不同版本和日期的颜色不可直接比较。</p></>}
    </details>
  </div>
}
