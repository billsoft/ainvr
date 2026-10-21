import {Plus,Pencil,Pause,Play,Archive,RefreshCw,Footprints,TrendingUp,MapPin,ChartColumn,ArrowLeft} from 'lucide-react'
import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {Link} from 'react-router-dom'
import {aiChannelService} from '@/api/aiChannelService'
import {alarmTriggerService} from '@/api/alarmTriggerService'
import {createCounterSaveSession,flowService,methodNames,startOfToday,type Counter,type CounterResult} from '@/api/flowService'
import {labelName} from '@/features/alarmTriggers'
import {labelDisplay} from '@/features/labelNames'
import {CounterDialog} from './CounterDialog'
import {FlowChart,periodSlots} from './FlowChart'
import {RecordsDrawer} from './RecordsDrawer'
import {counterStates,formatRangeLabel} from './counterText'

type Preset='today'|'yesterday'|'7d'|'30d'
const presets:{id:Preset;name:string}[]=[{id:'today',name:'今天'},{id:'yesterday',name:'昨天'},{id:'7d',name:'近 7 天'},{id:'30d',name:'近 30 天'}]
const choice='btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
const colors={in:'#16a34a',out:'#f97316'}
function rangeOf(preset:Preset,now=new Date()){
 const today=startOfToday(now),day=86400000
 if(preset==='today')return {from:today,to:now,bucket:'hour' as const,previous:{from:new Date(today.getTime()-day),to:new Date(now.getTime()-day)},compare:'昨天同时段'}
 if(preset==='yesterday')return {from:new Date(today.getTime()-day),to:today,bucket:'hour' as const,previous:{from:new Date(today.getTime()-2*day),to:new Date(today.getTime()-day)},compare:'前一天'}
 const days=preset==='7d'?7:30,from=new Date(today.getTime()-(days-1)*day)
 return {from,to:now,bucket:'day' as const,previous:{from:new Date(from.getTime()-days*day),to:new Date(now.getTime()-days*day)},compare:`前 ${days} 天`}
}
function change(now:number,before:number|undefined,period:string){
 if(before===undefined)return ''
 if(!before)return `${period}为 0`
 const p=Math.round((now-before)/before*100)
 return p===0?`与${period}持平`:`比${period} ${p>0?'↑':'↓'} ${Math.abs(p)}%`
}
export default function FlowPage(){
 const [tab,setTab]=useState<'overview'|'library'>('overview')
 const [counters,setCounters]=useState<Counter[]|null>(null),[loadError,setLoadError]=useState('')
 const [names,setNames]=useState<Record<string,string>>({}),[labels,setLabels]=useState<{label_id:string;name:string}[]>([])
 const [preset,setPreset]=useState<Preset>('today'),[results,setResults]=useState<CounterResult[]|null>(null),[previous,setPrevious]=useState<Record<string,{in:number;out?:number}>>({})
 const [queryError,setQueryError]=useState(''),[loading,setLoading]=useState(false),[updated,setUpdated]=useState<Date|null>(null)
 const [editing,setEditing]=useState<Counter|'new'|null>(null),[archiving,setArchiving]=useState<Counter|null>(null),[showArchived,setShowArchived]=useState(false)
 const [records,setRecords]=useState<{result:CounterResult;output:'in'|'out';bindingId?:string}|null>(null),[notice,setNotice]=useState('')
 const [revision,setRevision]=useState(0),[focus,setFocus]=useState<string|null>(null)
 const latest=useRef(0)
 const window_=useRef(rangeOf('today'))
 useEffect(()=>{
  let alive=true;setLoadError('')
  void flowService.list().then(r=>{if(alive)setCounters(r.items)}).catch(()=>{if(alive){setCounters([]);setLoadError('计数器读取失败')}})
  return()=>{alive=false}
 },[revision])
 useEffect(()=>{
  let alive=true
  void (async()=>{try{
   const channels=await aiChannelService.list(),sources=await Promise.allSettled(channels.map(c=>alarmTriggerService.source(c.id)))
   if(!alive)return
   const map:Record<string,string>={}
   for(const s of sources)if(s.status==='fulfilled'){map[s.value.channel_id]=s.value.channel_name;map[s.value.input_stream_id]=s.value.input_name}
   setNames(map)
   setLabels([...new Map(sources.flatMap(s=>s.status==='fulfilled'?s.value.labels.map(l=>({label_id:l.label_id,name:labelName(l)})):[]).map(l=>[l.label_id,l])).values()])
  }catch{/* names fall back to generic text */}})()
  return()=>{alive=false}
 },[])
 const query=useCallback(async(silent=false)=>{
  // Only the newest request may show its numbers: a slower earlier one is dropped.
  const id=++latest.current,range=rangeOf(preset);window_.current=range
  if(!silent){setLoading(true);setResults(null);setPrevious({})}
  setQueryError('')
  const ids=focus?{counter_ids:[focus]}:{}
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'
  try{
   const current=flowService.query({...ids,from:range.from.toISOString(),to:new Date(range.to.getTime()+1000).toISOString(),bucket:range.bucket,timezone})
   // The comparison loads on its own; it never holds back the current numbers.
   void flowService.query({...ids,from:range.previous.from.toISOString(),to:new Date(range.previous.to.getTime()+1000).toISOString(),bucket:null,timezone}).then(before=>{
    // No comparison when the counter was not counting anywhere in the previous period: that is not zero traffic.
    if(id===latest.current)setPrevious(Object.fromEntries(before.items.filter(i=>i.zones.length&&i.in.coverage!=='no_data').map(i=>[i.counter.counter_id,{in:i.in.occurrences,...(i.out?{out:i.out.occurrences}:{})}])))
   }).catch(()=>undefined)
   const now=await current
   if(id!==latest.current)return
   setResults(now.items);setUpdated(new Date())
  }catch(e){if(id!==latest.current)return;setResults(null);setPrevious({});setQueryError(e instanceof Error?e.message:'统计读取失败')}
  finally{if(id===latest.current)setLoading(false)}
 },[preset,focus])
 useEffect(()=>{void query()},[query,revision])
 // Live periods refresh themselves; past periods stay still.
 useEffect(()=>{if(preset==='yesterday')return;const t=setInterval(()=>{if(!document.hidden)void query(true)},30000);return()=>clearInterval(t)},[preset,query])
 const zoneName=(z:{source_id:string;zone_name:string|null})=>`${names[z.source_id]??'画面'} · ${z.zone_name??'已移除的热区'}`
 const active=(counters??[]).filter(c=>c.state!=='archived')
 // An archived counter is shown on its own when its statistics are opened from the counter list.
 const shown=focus?(counters??[]).filter(c=>c.counter_id===focus):active
 const byId=useMemo(()=>new Map((results??[]).map(r=>[r.counter.counter_id,r])),[results])
 const range=window_.current
 const slots=useMemo(()=>periodSlots(range.from,range.to,range.bucket),[range,results])
 const saved=(message:string)=>{setEditing(null);setArchiving(null);setNotice(message);setRevision(n=>n+1)}
 const setState=async(c:Counter,state:Counter['state'])=>{
  try{await createCounterSaveSession(c.version).save({counter_id:c.counter_id,name:c.name,labels:c.labels,method:c.method,outputs:c.outputs,names:c.names,occupancy:c.occupancy,max_gap_ms:c.max_gap_ms,state});
   saved(state==='paused'?`已暂停“${c.name}”`:state==='enabled'?`已启用“${c.name}”`:`已归档“${c.name}”`)}
  catch(e){setNotice(e instanceof Error?`操作未完成：${e.message}`:'操作未完成，请重试')}
 }
 return <main className="alarm-workspace space-y-4 p-4 md:p-6">
  <header className="flex flex-wrap items-center gap-3">
   <div className="min-w-0 flex-1"><h1 className="page-title">流量统计</h1><p className="mt-1 text-sm text-ink-subtle">统计经过计数线的目标数量。计数器在这里定义，在实时监看的布防中选用到热区。</p></div>
   <button type="button" className="btn-primary" onClick={()=>setEditing('new')}><Plus size={16} aria-hidden="true"/>新建计数器</button>
  </header>
  <div role="tablist" aria-label="流量统计" className="ui-panel inline-flex gap-1 p-1">
   {([['overview','流量概览'],['library','计数器']] as const).map(([id,name])=><button key={id} role="tab" type="button" aria-selected={tab===id} onClick={()=>{setTab(id);if(id==='library')setFocus(null)}}
    className={`rounded-base px-4 py-2 text-sm font-medium ${tab===id?'bg-primary-100 text-primary-600':'text-ink hover:bg-surface-hover'}`}>{name}{id==='library'&&counters?<span className="ml-1.5 text-xs text-ink-faint">{active.length}</span>:null}</button>)}
  </div>
  {notice&&<p role="status" className="rounded-base border border-line bg-surface p-3 text-sm">{notice}</p>}
  {!counters&&<p role="status" className="py-8 text-center text-sm text-ink-subtle">正在读取计数器…</p>}
  {loadError&&<p role="alert" className="text-sm text-danger">{loadError} <button type="button" className="btn-secondary ml-2" onClick={()=>setRevision(n=>n+1)}>重新读取</button></p>}
  {counters&&!active.length&&!focus&&!loadError&&<section className="ui-panel grid gap-4 p-6 md:grid-cols-3">
   <div className="md:col-span-3"><h2 className="text-base font-semibold text-ink">开始统计流量</h2><p className="mt-1 text-sm text-ink-subtle">两步即可：先定义计数器，再把它选用到画面中的热区上。</p></div>
   <div className="rounded-panel border border-line p-4"><p className="text-sm font-semibold text-ink">1. 新建计数器</p><p className="mt-1 text-sm text-ink-subtle">选择数什么目标、按什么方式计数。</p><button type="button" className="btn-primary mt-3" onClick={()=>setEditing('new')}><Plus size={16} aria-hidden="true"/>新建计数器</button></div>
   <div className="rounded-panel border border-line p-4"><p className="text-sm font-semibold text-ink">2. 选用到热区</p><p className="mt-1 text-sm text-ink-subtle">在实时监看点“布防”，选中热区后点“选用计数器”，在画面上设置计数线。</p><Link to="/monitor" className="btn-secondary mt-3"><MapPin size={16} aria-hidden="true"/>前往实时监看</Link></div>
   <div className="rounded-panel border border-line p-4"><p className="text-sm font-semibold text-ink">3. 查看结果</p><p className="mt-1 text-sm text-ink-subtle">这里自动显示今天的进出数量和分时趋势，实时画面上也会显示计数线和今日数字。</p></div>
  </section>}
  {tab==='overview'&&focus&&shown[0]&&<p role="status" className="flex flex-wrap items-center gap-3 rounded-base border border-line bg-surface p-3 text-sm">正在查看已归档计数器“{shown[0].name}”的统计，它已停止计数。<button type="button" className="btn-secondary" onClick={()=>setFocus(null)}><ArrowLeft size={16} aria-hidden="true"/>返回全部计数器</button></p>}
  {tab==='overview'&&!!shown.length&&<>
   <div className="flex flex-wrap items-center gap-2">
    <div role="group" aria-label="时间范围" className="flex flex-wrap gap-2">{presets.map(p=><button key={p.id} type="button" aria-pressed={preset===p.id} className={choice} onClick={()=>setPreset(p.id)}>{p.name}</button>)}</div>
    <span className="ml-auto flex items-center gap-2 text-xs text-ink-subtle">{updated&&<>{formatRangeLabel(range.from,range.to)} · {preset==='yesterday'?'':'每 30 秒自动刷新 · '}更新于 {updated.toLocaleTimeString('zh-CN')}</>}
     <button type="button" className="btn-secondary px-2.5" aria-label="立即刷新" disabled={loading} onClick={()=>void query()}><RefreshCw size={16} aria-hidden="true" className={loading?'animate-spin':''}/></button></span>
   </div>
   {queryError&&<p role="alert" className="rounded-base border border-danger bg-danger-50 p-3 text-sm text-danger-700">{queryError}，未取得统计结果。<button type="button" className="btn-secondary ml-2" onClick={()=>void query()}>重试</button></p>}
   <div className="grid gap-4 xl:grid-cols-2">{shown.map(c=>{const r=byId.get(c.counter_id),both=c.outputs==='both',prev=previous[c.counter_id]
    const occupancy=both&&c.occupancy&&preset==='today'&&r?.out?Math.max(0,r.in.occurrences-r.out.occurrences):null
    const coverage=r?[r.in.coverage,r.out?.coverage].includes('partial')?'partial':r.in.coverage:null
    return <article key={c.counter_id} aria-label={c.name} className="ui-panel flex flex-col gap-4 p-4">
     <header className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 text-base font-semibold text-ink">{c.name}</h2>
      {c.state==='paused'&&<span className="rounded-full bg-surface-page px-2.5 py-0.5 text-xs text-ink-subtle">已暂停</span>}
      <span className="text-xs text-ink-subtle">{methodNames[c.method]} · {c.labels.map(l=>labelDisplay(l.name)).join('、')}</span></header>
     {!c.bindings.length&&!r?.zones.length?<div className="rounded-base border border-dashed border-line p-4 text-sm text-ink-subtle">还没有选用到热区，暂不计数。<Link to="/monitor" className="ml-1 text-primary hover:underline">去实时监看布防</Link></div>:<>
      <div className={`grid gap-3 ${occupancy!==null?'grid-cols-3':both?'grid-cols-2':'grid-cols-1'}`}>
       {(both?(['in','out'] as const):(['in'] as const)).map(o=>{const value=r?.[o]?.occurrences;return <button key={o} type="button" disabled={!r} onClick={()=>r&&setRecords({result:r,output:o})}
        className="rounded-panel border border-line p-3 text-left transition-colors hover:border-primary hover:bg-primary-50 disabled:hover:border-line disabled:hover:bg-transparent">
        <span className="flex items-center gap-1.5 text-xs text-ink-subtle"><span className="h-2 w-2 rounded-full" style={{background:colors[o]}}/>{c.names[o]}</span>
        <span className="mt-1 block text-2xl font-semibold tabular-nums text-ink">{value??'—'}</span>
        <span className="mt-0.5 block text-xs text-ink-faint">{value===undefined?'读取中':change(value,prev?.[o],range.compare)}</span>
       </button>})}
       {occupancy!==null&&<div className="rounded-panel border border-line bg-surface-page p-3"><span className="text-xs text-ink-subtle">当前在场</span><span className="mt-1 block text-2xl font-semibold tabular-nums text-ink">{occupancy}</span><span className="mt-0.5 block text-xs text-ink-faint">今日{c.names.in}减{c.names.out}</span></div>}
      </div>
      {r&&<FlowChart label={`${c.name}分时趋势`} bucket={range.bucket} slots={slots} series={(both?(['in','out'] as const):(['in'] as const)).map(o=>({name:c.names[o],color:colors[o],buckets:r[o]?.buckets??[]}))}/>}
      {r&&r.zones.length>1&&<table className="w-full text-sm"><caption className="sr-only">各热区分项</caption><thead><tr className="text-left text-xs text-ink-subtle"><th className="py-1.5 font-normal">热区</th>{(both?(['in','out'] as const):(['in'] as const)).map(o=><th key={o} className="py-1.5 text-right font-normal">{c.names[o]}</th>)}</tr></thead>
       <tbody>{r.zones.map(z=><tr key={z.binding_id} className="border-t border-line"><td className="py-2">{zoneName(z)}{!z.active&&<span className="ml-1 text-xs text-ink-faint">（已移除）</span>}</td>{(both?(['in','out'] as const):(['in'] as const)).map(o=><td key={o} className="py-2 text-right"><button type="button" className="tabular-nums text-primary hover:underline" onClick={()=>setRecords({result:r,output:o,bindingId:z.binding_id})}>{z[o]?.occurrences??0}</button></td>)}</tr>)}</tbody></table>}
      {r&&r.zones.length>1&&<p className="text-xs text-ink-faint">合计包含 {r.zones.length} 个热区；热区互相重叠时同一目标可能被重复计入。</p>}
      {coverage&&coverage!=='complete'&&<p className="text-xs text-ink-faint">{coverage==='no_data'?'这段时间没有收到画面分析数据。':'这段时间有部分时段没有收到画面分析数据，数字可能偏少。'}</p>}
     </>}
    </article>})}</div>
   <p className="text-xs text-ink-faint">数量为经过计数线的目标次数，不等于精确人数：同一目标往返分别计入，遮挡或识别中断可能少计。</p>
  </>}
  {tab==='library'&&!!counters?.length&&<>
   <label className="flex items-center justify-end gap-2 text-sm text-ink-subtle"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/>查看已归档</label>
   <div className="grid gap-4 lg:grid-cols-2">{counters.filter(c=>showArchived?c.state==='archived':c.state!=='archived').map(c=>{const r=byId.get(c.counter_id)
    return <article key={c.counter_id} aria-label={c.name} className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-4">
     <header className="flex flex-wrap items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-base bg-primary-50 text-primary"><Footprints size={16} aria-hidden="true"/></span>
      <h2 className="min-w-0 flex-1 break-words text-base font-semibold text-ink">{c.name}</h2><span className="text-sm text-ink-subtle">{counterStates[c.state]}</span></header>
     <p className="text-sm text-ink">{methodNames[c.method]} · {c.labels.map(l=>labelDisplay(l.name)).join('、')} · {c.outputs==='both'?`${c.names.in} / ${c.names.out}`:`只计“${c.names.in}”`}{c.occupancy?' · 显示在场':''}</p>
     <section aria-label="选用位置" className="rounded-base bg-surface-page p-3 text-sm">{c.bindings.length?<ul className="flex flex-wrap gap-2">{c.bindings.map(b=><li key={b.binding_id} className="rounded-full border border-line bg-surface px-3 py-1 text-xs">{zoneName(b)}</li>)}</ul>
      :<p>尚未选用到热区 · <Link to="/monitor" className="text-primary hover:underline">去实时监看布防</Link></p>}</section>
     <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
      <span className="mr-auto flex items-center gap-1.5 text-sm text-ink-subtle"><TrendingUp size={16} aria-hidden="true"/>{preset==='today'?'今日':'所选时段'} {r?`${c.names.in} ${r.in.occurrences}${r.out?` · ${c.names.out} ${r.out.occurrences}`:''}`:'—'}</span>
      {c.state==='archived'&&<button type="button" className="btn-secondary" onClick={()=>{setFocus(c.counter_id);setTab('overview')}}><ChartColumn size={16} aria-hidden="true"/>查看统计</button>}
      {c.state!=='archived'&&<><button type="button" className="btn-secondary" onClick={()=>setEditing(c)}><Pencil size={16} aria-hidden="true"/>编辑</button>
       <button type="button" className="btn-secondary" onClick={()=>void setState(c,c.state==='enabled'?'paused':'enabled')}>{c.state==='enabled'?<Pause size={16} aria-hidden="true"/>:<Play size={16} aria-hidden="true"/>}{c.state==='enabled'?'暂停':'启用'}</button>
       <button type="button" className="btn-secondary" onClick={()=>setArchiving(c)}><Archive size={16} aria-hidden="true"/>归档</button></>}
     </footer>
    </article>})}</div>
  </>}
  {editing&&<CounterDialog key={editing==='new'?'new':editing.counter_id} initial={editing==='new'?undefined:editing} labels={labels} onCancel={()=>setEditing(null)} onSaved={c=>saved(editing==='new'?`已创建“${c.name}”。到实时监看的布防中选用到热区后开始计数。`:`已保存“${c.name}”`)}/>}
  {archiving&&<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"><section role="alertdialog" aria-modal="true" aria-label="确认归档计数器" className="w-full max-w-md space-y-3 rounded-panel bg-surface p-5 text-sm shadow-modal">
   <h2 className="text-base font-semibold text-ink">归档“{archiving.name}”？</h2><p className="text-ink-subtle">将从 {archiving.bindings.length} 个热区解除并停止计数。已有统计保留，可在“查看已归档”中找到；归档后不能恢复。</p>
   <div className="flex justify-end gap-2"><button type="button" autoFocus className="btn-secondary" onClick={()=>setArchiving(null)}>保留</button><button type="button" className="btn-primary bg-danger hover:bg-danger-700" onClick={()=>void setState(archiving,'archived')}>确认归档</button></div></section></div>}
  {records&&<RecordsDrawer result={records.result} output={records.output} bindingId={records.bindingId} from={range.from.toISOString()} to={new Date(range.to.getTime()+1000).toISOString()} zoneName={zoneName} onClose={()=>setRecords(null)}/>}
 </main>
}
