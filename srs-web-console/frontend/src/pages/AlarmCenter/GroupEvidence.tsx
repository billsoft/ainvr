import {useEffect,useState} from 'react'
import type {AlarmEvent} from '@/api/alarmEventService'
import {request} from '@/api/httpClient'
import {reviewReason} from '@/features/alarmReview'
import {BehaviorEvidence} from './BehaviorEvidence'

export function GroupEvidence({alarm}:{alarm:AlarmEvent}){
 const group=alarm.analysis_evidence!.group!,source=alarm.analysis_evidence!.source
 const frames=alarm.review?.frames??[]
 const [expanded,expand]=useState<Record<string,boolean>>({})
 const [selected,select]=useState(''),[loaded,load]=useState<{key:string;src:string}|null>(null)
 const frame=frames.find(f=>f.key===selected)??frames.at(-1),key=frame?.key
 useEffect(()=>{
  let active=true
  if(key)void request<{jpeg_base64:string}>(`/alarms/events/${encodeURIComponent(alarm.alarm_id)}/review-frames/${key}`).then(v=>{
    if(active)load({key,src:'data:image/jpeg;base64,'+v.jpeg_base64})
  }).catch(()=>{if(active)load({key,src:''})})
  return()=>{active=false}
 },[key,alarm.alarm_id])
 const verdict=alarm.review?.group_verdict,scene=alarm.review?.group_scene
 return <section className="space-y-3 rounded-panel border border-line p-3">
  <h3 className="text-sm font-semibold">组合证据 · 至少 {group.minimum} 个目标 · {group.labels==='all'?'全部类别':'任一类别'}</h3>
  <p className="text-sm">{verdict==='confirmed'?'AI 已确认组合条件':verdict==='false_positive'?'AI 已判整组误报':verdict==='uncertain'?'组合证据不足，待人工核对':'逐目标审核记录'} · 已留存 {group.members.length} 个候选{group.candidate_count!=null&&group.candidate_count>group.members.length?`（共有 ${group.candidate_count} 个，不能自动判误报）`:''}</p>
  {verdict==='false_positive'&&<p className="text-xs text-ink-subtle">按原规则计入所有未排除的候选后，数量或所需类别仍不足。</p>}
  {scene&&<p className="text-xs text-ink-subtle">共同画面核对 · {scene.frame_id} · 模型分 {scene.score.toFixed(3)}</p>}
  {frame&&<><label className="block text-sm">证据时刻<select className="form-input" value={frame.key} onChange={e=>select(e.target.value)}>{frames.map(f=><option key={f.key} value={f.key}>{new Date(f.captured_at).toLocaleTimeString()} · {f.frame_id}</option>)}</select></label>
  {loaded?.key===key&&loaded?.src?<div className="relative bg-slate-950" style={{aspectRatio:`${source.width}/${source.height}`}}>
   <img className="absolute inset-0 h-full w-full object-contain" src={loaded.src} alt="审核使用的原始全景"/>
   <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${source.width} ${source.height}`}>
   {alarm.rule.snapshot?.points&&<polygon points={alarm.rule.snapshot.points.map(([x,y])=>[x*source.width,y*source.height].join(',')).join(' ')} fill="#2563eb18" stroke="#60a5fa" strokeWidth="2" vectorEffect="non-scaling-stroke"/>}
   {group.members.map((m,i)=>{const b=[m.sample,m.identity_sample,m.start,...(m.transition??[])].find(s=>s&&s.frame_id===frame.frame_id)?.bbox
    return b&&<g key={m.event_id}><rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke="#34d399" strokeWidth="2" vectorEffect="non-scaling-stroke"/><text x={b.x} y={Math.max(source.height/28,b.y)} fill="white" stroke="black" paintOrder="stroke" fontSize={source.height/28}>{i+1}</text></g>})}
   </svg></div>:<p className="text-xs">{loaded?.key===key?'原帧不可用或已过保留期':'正在读取原帧…'}</p>}</>}
  {group.members.map((m,i)=>{const r=alarm.review?.group_scores?.find(s=>s.event_id===m.event_id)
   return <details key={m.event_id} className="text-sm" onToggle={e=>{const open=e.currentTarget.open;expand(old=>({...old,[m.event_id]:open}))}}><summary className="cursor-pointer py-2">{i+1} · {m.name??m.sample.label_id} · {r?.outcome==='confirmed'?'类别确认':r?.outcome==='false_positive'?'明确排除':r?'参考结果':'待核对'}</summary>
   <p>轨迹 {m.sample.track_id} · 原帧 {m.sample.frame_id} · {new Date(m.sample.captured_at).toLocaleTimeString()}</p>
   {typeof r?.score==='number'&&<p>最低类别分 {r.score.toFixed(3)}（不是概率）</p>}
   {r?.reason&&<p>{reviewReason(r.reason)||'此成员证据不足'}</p>}
   {expanded[m.event_id]&&<BehaviorEvidence eventId={m.event_id}/>}</details>})}
 </section>
}
