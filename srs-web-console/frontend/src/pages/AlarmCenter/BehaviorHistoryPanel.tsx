import {useEffect,useRef,useState} from 'react'
import {behaviorHistoryService,type BehaviorFact,type BehaviorHistoryQuery} from '@/api/behaviorHistoryService'
import {BehaviorEvidence} from './BehaviorEvidence'
import {behaviorNames as names} from '@/features/alarmTriggers'
const button='btn-secondary'
const time=(v:string)=>new Date(v).toLocaleString()
function angle(value:unknown){
 if(typeof value!=='number'||!Number.isFinite(value))return '未确定'
 const degrees=((value%360)+360)%360,clock=Math.round(degrees/30)%12||12
 return `约 ${clock} 点钟方向（${degrees.toFixed(1)}°）`
}
function FactDetail({id,onClose}:{id:string;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null)
 const [fact,setFact]=useState<BehaviorFact|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0)
 useEffect(()=>{const node=dialog.current;const prior=document.activeElement as HTMLElement|null;node?.showModal();return()=>{node?.close();prior?.focus()}},[])
 useEffect(()=>{let active=true;setFact(null);setError(false)
  void behaviorHistoryService.get(id).then(f=>{if(active)setFact(f)}).catch(()=>{if(active)setError(true)})
  return()=>{active=false}
 },[id,retry])
 const direction=fact?.direction&&typeof fact.direction==='object'?fact.direction as Record<string,unknown>:{}
 return <dialog ref={dialog} onCancel={e=>{e.preventDefault();onClose()}} className="w-[min(40rem,calc(100vw-2rem))] max-h-[85vh] overflow-auto rounded bg-surface p-5 text-ink backdrop:bg-black/40" aria-label="行为详情">
  <div className="flex items-center justify-between"><h2 className="text-base font-semibold text-ink">行为详情</h2><button autoFocus className={button} onClick={onClose}>关闭详情</button></div>
  {error?<div role="alert">记录读取失败，可能暂时不可用或已过保留期。<button className={button} onClick={()=>setRetry(v=>v+1)}>重试详情</button></div>:!fact?<p role="status">正在读取…</p>:<>
   <dl className="my-4 grid grid-cols-[7rem_1fr] gap-3 break-words text-sm">
    <dt>行为</dt><dd>{names[fact.event_type]??fact.event_type}</dd>
    <dt>发生时间</dt><dd>{time(fact.occurred_at)}</dd>
    <dt>开始时间</dt><dd>{fact.started_at?time(fact.started_at):'未确定'}</dd>
    <dt>目标标签</dt><dd>{fact.label_id}</dd><dt>跟踪目标</dt><dd>{fact.track_id}</dd>
    <dt>区域</dt><dd>{fact.zone_id?`${fact.zone_id} · 版本 ${fact.zone_version??'未知'}`:'整个画面'}</dd>
    <dt>触发器</dt><dd>{fact.trigger_id??fact.rule_id} · 版本 {fact.rule_version}</dd>
    {(fact.event_type==='region_contact'||fact.event_type==='region_approach')&&<><dt>区域方位</dt><dd>{angle(direction.region_side_deg)} · 最近边界估计</dd></>}
    <dt>进入方位</dt><dd>{angle(direction.entry_side_deg)}</dd><dt>离开方位</dt><dd>{angle(direction.exit_side_deg)}</dd>
    <dt>运动方向</dt><dd>{angle(direction.motion_heading_deg)}</dd>
    <dt>轨迹完整性</dt><dd>{fact.quality.trajectory_complete===true?'已确认完整':fact.quality.trajectory_complete===false?'不完整':'未确定'}</dd>
   </dl>
   <p className="text-sm text-ink-subtle">方向以画面上方为 12 点钟（0°），顺时针增加，不代表地理方向。方位表示区域哪一侧，运动方向表示目标朝哪里移动；缺少连续检测时显示未确定。接触区域不代表发生物理碰撞。</p>
   <BehaviorEvidence key={fact.event_id} eventId={fact.event_id}/>
   <details className="mt-3"><summary className="cursor-pointer py-2 text-sm font-medium text-ink">追溯信息</summary><dl className="space-y-2 break-all text-xs"><dt>事件 ID</dt><dd>{fact.event_id}</dd><dt>视频会话</dt><dd>{fact.stream_session_id}</dd><dt>原帧</dt><dd>{fact.frame_id}</dd></dl></details>
  </>}
 </dialog>
}
export function BehaviorHistoryPanel({query,onClose}:{query:BehaviorHistoryQuery;onClose:()=>void}){
 const [items,setItems]=useState<BehaviorFact[]>([]),[cursor,setCursor]=useState<string|null>(null)
 const [busy,setBusy]=useState(false),[error,setError]=useState(false),[loaded,setLoaded]=useState(false)
 const [selected,setSelected]=useState<string|null>(null)
 const alive=useRef(true),inflight=useRef(false)
 const load=async(next?:string)=>{
  if(inflight.current)return
  inflight.current=true;setBusy(true);setError(false)
  try{const page=await behaviorHistoryService.list(query,next)
   if(alive.current){setItems(old=>{const combined=next?[...old,...page.items]:page.items;return [...new Map(combined.map(row=>[row.event_id,row])).values()]});setCursor(page.next_cursor);setLoaded(true)}
  }catch{if(alive.current)setError(true)}
  finally{inflight.current=false;if(alive.current)setBusy(false)}
 }
 // Parent keys this panel by the immutable drill-down query.
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false}},[])
 return <section className="space-y-3 rounded border border-line bg-surface p-4" aria-label="行为记录">
  <div className="flex items-center justify-between"><h2 className="font-semibold">行为记录 · {names[query.event_type??'']??'全部行为'}</h2><button className={button} onClick={onClose}>返回统计</button></div>
  <p className="text-sm">{time(query.from)} 至 {time(query.to)}</p>
  <p className="text-xs text-ink-subtle">按发生时间倒序显示。迟到的数据可能需要重新查询；记录数与之前的统计快照可能不同。</p>
  {error&&<div role="alert">记录读取失败，已加载内容保留。<button disabled={busy} className={button} onClick={()=>void load(loaded?cursor??undefined:undefined)}>重试读取</button></div>}
  {loaded&&!items.length&&<p>没有已记录的行为。</p>}
  {!!items.length&&<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">发生时间</th><th>行为</th><th>标签</th><th>区域</th><th>操作</th></tr></thead><tbody>{items.map(row=><tr className="border-t border-line" key={row.event_id}><td className="whitespace-nowrap p-2">{time(row.occurred_at)}</td><td>{names[row.event_type]??row.event_type}</td><td>{row.label_id}</td><td>{row.zone_id??'整个画面'}</td><td><button className={button} aria-label={`查看行为 ${row.event_id}`} onClick={()=>setSelected(row.event_id)}>详情</button></td></tr>)}</tbody></table></div>}
  {busy&&<p role="status">正在读取记录…</p>}
  {cursor&&!error&&<button disabled={busy} className={button} onClick={()=>void load(cursor)}>加载更多</button>}
  {selected&&<FactDetail key={selected} id={selected} onClose={()=>setSelected(null)}/>}
 </section>
}
