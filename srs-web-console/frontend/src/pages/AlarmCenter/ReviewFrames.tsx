import {useEffect,useState} from 'react'
import type {AlarmEvent} from '@/api/alarmEventService'
import {request} from '@/api/httpClient'
import {reviewTrajectorySegments} from '@/features/reviewTrajectory'
export function ReviewFrames({alarm}:{alarm:AlarmEvent}){
 const [failed,setFailed]=useState<Record<string,boolean>>({})
 const [images,setImages]=useState<Record<string,string>>({})
 useEffect(()=>{let active=true;setImages({});setFailed({});for(const f of alarm.review?.frames??[]){void request<{jpeg_base64:string}>(`/alarms/events/${encodeURIComponent(alarm.alarm_id)}/review-frames/${f.key}`).then(v=>{if(active){const url=`data:image/jpeg;base64,${v.jpeg_base64}`;setImages(old=>({...old,[f.key]:url}))}}).catch(()=>{if(active)setFailed(old=>({...old,[f.key]:true}))})}return()=>{active=false}},[alarm.alarm_id,alarm.review?.frames])
 const source=alarm.analysis_evidence?.source,context=alarm.analysis_evidence?.review_context
 if(!alarm.review?.frames?.length)return null
 return <section aria-label="审核关键帧" className="space-y-2"><h3 className="text-sm font-medium">审核关键帧 · 热区与真实轨迹</h3><div className="grid gap-2 sm:grid-cols-2">{alarm.review.frames.map((f,i)=><figure key={f.key} className="overflow-hidden rounded-base border border-line"><div className="relative">{images[f.key]?<img src={images[f.key]} alt={`关键帧 ${i+1}`} className="w-full"/>:<p className="p-4 text-sm text-ink-subtle">{failed[f.key]?'关键帧暂不可用或已过保留期':'正在读取关键帧…'}</p>}{source&&images[f.key]&&<svg viewBox={`0 0 ${source.width} ${source.height}`} className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none">
 {context?.region&&<polygon points={context.region.points.map(p=>`${p[0]*source.width},${p[1]*source.height}`).join(' ')} fill="#2563eb22" stroke="#60a5fa" strokeWidth="2" vectorEffect="non-scaling-stroke"/>}
 {reviewTrajectorySegments(context?.trace??[],f.source_pts_ns,context?.anchor).map((points,index)=><polyline key={index} points={points} fill="none" stroke="#fbbf24" strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}
 <rect x={f.bbox.x} y={f.bbox.y} width={f.bbox.w} height={f.bbox.h} fill="none" stroke="#34d399" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg>}</div><figcaption className="p-2 text-xs text-ink-subtle">{i+1} · {new Date(f.captured_at).toLocaleString()}</figcaption></figure>)}</div><p className="text-xs text-ink-subtle">蓝色为当时热区，黄色为真实观测轨迹，绿色为当前目标框。图片用于视觉复核，行为由轨迹几何核验。</p></section>
}
