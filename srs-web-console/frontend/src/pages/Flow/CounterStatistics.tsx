import {Eraser} from 'lucide-react'
import {useState} from 'react'
import type {Counter,CounterResult} from '@/api/flowService'
import {FlowChart} from './FlowChart'

type Output='in'|'out'
type Zone=CounterResult['zones'][number]
interface Props {
 counter:Counter
 result:CounterResult
 previous?:{in:number;out?:number}
 comparison:string
 bucket:'hour'|'day'
 slots:{from:string;to:string}[]
 zoneName:(zone:Zone)=>string
 onClear?:(bindingId?:string)=>void
 onRecords:(output:Output,bindingId?:string)=>void
}
const colors={in:'#16a34a',out:'#f97316'}
const pageSize=8
const signed=(value:number)=>value>0?`+${value}`:String(value)
function comparisonText(now:number,before:number|undefined,period:string){
 if(before===undefined)return ''
 if(!before)return `${period}为 0`
 const percent=Math.round((now-before)/before*100)
 return percent===0?`与${period}持平`:`比${period} ${percent>0?'↑':'↓'} ${Math.abs(percent)}%`
}
const passageReason=(reason:string)=>({passage_input_gap:'输入帧序列中断',passage_observation_gap:'真实观测中断超时',passage_identity_ended:'跟踪身份结束',passage_gap_rejected:'恢复后的轨迹无法可靠衔接',passage_gap_timeout:'遮挡超过计数允许时长',passage_gap_time_invalid:'恢复观测时间不连续',passage_gap_displacement:'恢复目标的位置变化过大',passage_gap_size_change:'恢复目标的大小变化过大',passage_gap_label_changed:'跟踪目标类别发生变化',ambiguous_boundary_crossing:'越界位置有歧义',ambiguous_concave_crossing:'凹区域内轨迹连续性不明确',interior_not_observed:'未观测到稳定的区域内部位置',entry_not_observed:'缺少有效进入证据'}[reason]??'通行证据不完整')

/** Filters affect the location list only. Each binding retains its own facts and trend. */
export function CounterStatistics({counter:c,result:r,previous,comparison,bucket,slots,zoneName,onRecords,onClear}:Props){
 const [selectedId,setSelectedId]=useState<string|null>(null)
 const [search,setSearch]=useState(''),[source,setSource]=useState(''),[page,setPage]=useState(0)
 const outputs:Output[]=c.outputs==='both'?['in','out']:['in']
 const net=c.outputs==='both'&&c.occupancy
 const selected=r.zones.find(z=>z.binding_id===selectedId)
 const sources=[...new Map(r.zones.map(z=>[z.source_id,zoneName({...z,zone_name:''}).replace(/ · $/,'')])).entries()]
 const filtered=r.zones.filter(z=>(!source||source===z.source_id)&&zoneName(z).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
 const pages=Math.max(1,Math.ceil(filtered.length/pageSize)),currentPage=Math.min(page,pages-1)
 const visible=filtered.slice(currentPage*pageSize,(currentPage+1)*pageSize)
 const title=selected?`${zoneName(selected)}趋势`:'全部热区趋势'
 const coverage=[r.in.coverage,r.out?.coverage].includes('partial')?'partial':r.in.coverage
 return <div className="space-y-2">
  <section aria-label="整体合计" className="space-y-2">
   <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-ink">整体合计</h3><span className="text-xs text-ink-subtle">本期 {r.zones.length} 个统计位置{r.zones.some(z=>!z.active)?' · 含已移除位置的历史记录':''}</span></div>
   <div className={`grid gap-3 ${net?'grid-cols-3':c.outputs==='both'?'grid-cols-2':'grid-cols-1'}`}>
    {outputs.map(o=><button key={o} type="button" aria-label={`${c.names[o]}合计 ${r[o]?.occurrences??'暂无数据'}，查看通行记录`} onClick={()=>onRecords(o)} className="min-h-11 rounded-panel border border-line p-3 text-left transition-colors hover:border-primary hover:bg-primary-50">
     <span className="flex items-center gap-1.5 text-xs text-ink-subtle"><span className="h-2 w-2 rounded-full" style={{background:colors[o]}}/>{c.names[o]}合计</span>
     <strong className="mt-0.5 block text-2xl tabular-nums text-ink">{r[o]?.occurrences??'—'}</strong>
     {previous?.[o]!==undefined&&<span className="block text-xs text-ink-faint">{comparisonText(r[o]!.occurrences,previous?.[o],comparison)}</span>}
    </button>)}
    {net&&<div className="rounded-panel border border-line bg-surface-page p-3"><span className="text-xs text-ink-subtle">本期净流入</span><strong className="mt-0.5 block text-2xl tabular-nums text-ink">{r.out?signed(r.in.occurrences-r.out.occurrences):'—'}</strong><span className="mt-1 block text-xs text-ink-faint">{c.names.in}减{c.names.out}，非实际在场人数</span></div>}
   </div>
   {coverage!=='complete'&&<p className="text-xs text-amber-800">{coverage==='no_data'?'本期没有收到画面分析数据，零记录不代表零通行。':'本期部分时段缺少画面分析数据，统计可能不完整。'}</p>}
  </section>
  <section aria-label="各热区分项" className="space-y-2">
   <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-ink">各热区分项 <span className="ml-1 font-normal text-ink-subtle">{r.zones.length}</span></h3><p className="text-xs text-ink-faint">点击位置看趋势，点击数量看记录</p></div>
   {r.zones.length>1&&<div className="flex flex-wrap gap-2">
    <input type="search" aria-label="搜索统计位置" placeholder="搜索摄像头或热区" className="form-input !min-h-11 min-w-0 flex-1" value={search} onChange={e=>{setSearch(e.target.value);setPage(0)}}/>
    <select aria-label="筛选摄像头" className="form-input !min-h-11 !w-auto max-w-full" value={source} onChange={e=>{setSource(e.target.value);setPage(0)}}><option value="">全部摄像头</option>{sources.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>
   </div>}
   {(search||source)&&<p className="text-xs text-ink-subtle">匹配 {filtered.length} 个位置；筛选仅影响列表，上方合计包含全部位置。</p>}
   <div className="overflow-x-auto rounded-card border border-line">
    <table className="w-full min-w-[440px] text-sm"><caption className="sr-only">各热区独立通行数量</caption>
     <thead className="bg-surface-page text-xs text-ink-subtle"><tr><th scope="col" className="px-3 py-2 text-left font-medium">摄像头 / 热区</th>{outputs.map(o=><th key={o} scope="col" className="px-3 py-2 text-right font-medium">{c.names[o]}</th>)}{net&&<th scope="col" className="px-3 py-2 text-right font-medium">净流入</th>}{onClear&&<th scope="col" className="w-20 px-2 text-right font-medium">操作</th>}</tr></thead>
     <tbody>{visible.map(z=>{
      const diagnostic=[z.in?.diagnostic,z.out?.diagnostic].filter(d=>!!d).sort((a,b)=>b.at.localeCompare(a.at))[0]
      const incomplete=outputs.some(o=>z[o]&&z[o]!.coverage.state!=='complete')
      return <tr key={z.binding_id} className={`border-t border-line ${selected?.binding_id===z.binding_id?'bg-primary-50':'hover:bg-surface-hover'}`} onClick={()=>setSelectedId(z.binding_id)}>
       <th scope="row" className="px-3 py-1 text-left font-normal">
        <button type="button" aria-label={`查看 ${zoneName(z)} 的趋势`} aria-pressed={selected?.binding_id===z.binding_id} className="min-h-11 w-full py-2 text-left text-ink" onClick={()=>setSelectedId(z.binding_id)}><span className="break-words font-medium">{zoneName(z)}</span><span className="ml-2 inline-block text-xs text-ink-subtle">{!z.active?'已移除 · 保留本期记录':!z.counting?'已暂停':'统计中'}{selected?.binding_id===z.binding_id?' · 正在查看':''}</span></button>
        {incomplete&&<p className="mr-3 inline-block text-xs text-amber-800">本期数据不完整</p>}
        {diagnostic&&<details className="inline-block text-xs text-amber-800" onClick={e=>e.stopPropagation()}><summary className="cursor-pointer py-1">通行诊断</summary><p className="max-w-md py-1 leading-5">{passageReason(diagnostic.reason)}（{new Date(diagnostic.at).toLocaleString('zh-CN')}）。不是已确认的漏计人数。</p></details>}
       </th>
       {outputs.map(o=><td key={o} className="px-3 text-right"><button type="button" disabled={!z[o]} aria-label={`查看 ${zoneName(z)} 的${c.names[o]}记录`} className="min-h-11 min-w-11 px-1 font-semibold tabular-nums text-primary hover:underline disabled:text-ink-faint" onClick={e=>{e.stopPropagation();onRecords(o,z.binding_id)}}>{z[o]?.occurrences??'—'}</button></td>)}
       {net&&<td className="px-3 text-right tabular-nums text-ink">{z.in&&z.out?signed(z.in.occurrences-z.out.occurrences):'—'}</td>}
       {onClear&&<td className="px-2 text-right"><button type="button" aria-label={`清理 ${zoneName(z)} 的本期数据`} className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-base px-2 text-ink-subtle hover:bg-danger-50 hover:text-danger" onClick={e=>{e.stopPropagation();onClear(z.binding_id)}}><Eraser size={14} aria-hidden="true"/>清理</button></td>}
      </tr>
     })}</tbody>
     {r.zones.length>1&&<tfoot className="border-t border-line bg-surface-page font-semibold"><tr><th scope="row" className="px-3 py-2 text-left">全部合计</th>{outputs.map(o=><td key={o} className="px-3 py-2 text-right tabular-nums">{r[o]?.occurrences??'—'}</td>)}{net&&<td className="px-3 py-2 text-right tabular-nums">{r.out?signed(r.in.occurrences-r.out.occurrences):'—'}</td>}{onClear&&<td/>}</tr></tfoot>}
    </table>
   </div>
   {!filtered.length&&<p role="status" className="text-sm text-ink-subtle">没有匹配的统计位置，请调整筛选。</p>}
   {pages>1&&<div className="flex items-center justify-end gap-3 text-xs text-ink-subtle"><span>第 {currentPage+1} / {pages} 页</span><button type="button" className="btn-secondary min-h-11" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</button><button type="button" className="btn-secondary min-h-11" disabled={currentPage===pages-1} onClick={()=>setPage(currentPage+1)}>下一页</button></div>}
  </section>
  <section aria-label="通行趋势" className="space-y-2 border-t border-line pt-3">
   <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="break-words text-sm font-semibold text-ink">{title}</h3>{selected&&<button type="button" className="btn-secondary min-h-11" onClick={()=>setSelectedId(null)}>返回全部</button>}</div>
   {selected&&<p className="text-xs text-ink-subtle">本期：{outputs.map(o=>`${c.names[o]} ${selected[o]?.occurrences??'—'}`).join(' · ')}{!selected.active?' · 已移除位置的历史记录':''}</p>}
   <FlowChart key={`${selected?.binding_id??'all'}:${bucket}`} label={`${c.name} · ${title}`} bucket={bucket} slots={slots} series={outputs.map(o=>({name:c.names[o],color:colors[o],buckets:(selected?selected[o]:r[o])?.buckets??[]}))}/>
  </section>
  {r.zones.length>1&&<p className="text-xs leading-5 text-ink-faint">整体合计为各位置通行次数之和。同一目标依次通过多个统计位置，会分别计入。</p>}
 </div>
}
