import { useEffect,useState,useRef } from 'react'
import { request } from '@/api/httpClient'
type Event={event_id:string;timestamp:number;rule_id:string;type:string;track_id:string;direction?:string;review_status?:string;notification_status?:string;
 review_job?:{result?:{scope?:string;code?:string;description?:string;image_id?:string}};
 evidence?:{status?:string};source_frame?:{width:number;height:number;model_name?:string};
 target?:{class_name?:string;label_id?:string;query_description?:string;confidence?:number|null}}
const names:Record<string,string>={line_crossing:'越线',region_enter:'进入区域',region_exit:'离开区域',region_dwell:'区域停留'}
const reviewNames:Record<string,string>={not_requested:'未启用',pending:'排队中',processing:'复核中',approved:'复核通过',rejected:'复核否决',failed:'复核失败',timeout:'复核超时',unavailable:'复核不可用'}
const notificationNames:Record<string,string>={not_requested:'未启用',waiting_review:'等待复核',pending:'待发送',processing:'发送中',sent:'已发送',failed:'发送失败',timeout:'发送超时',retrying:'等待重试',suppressed:'已抑制'}
const evidenceNames:Record<string,string>={awaiting_archive:'等待归档确认（尚不能作为图片证据）',archive_disabled:'未开启截图归档',no_visible_target:'目标未进入截图列表',frame_mismatch:'帧不匹配，未关联截图',available:'图片已归档',failed:'证据保存失败'}
const stateName=(names:Record<string,string>,state?:string)=>state?names[state]??'未知状态（需检查服务版本）':'未记录'
export function AnalyticsEvents({channelId,onClose}:{channelId:string;onClose:()=>void}) {
 const dialog=useRef<HTMLDivElement>(null)
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null
  dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
  return ()=>previous?.focus()
 },[])
 const [events,setEvents]=useState<Event[]>([])
 const [error,setError]=useState('')
 const [loading,setLoading]=useState(true)
 const [reload,setReload]=useState(0)
 useEffect(()=>{
  let active=true;setLoading(true);setError('')
  request<{events:Event[]}>(`/ai/channels/${encodeURIComponent(channelId)}/analytics/events?limit=100`)
   .then(data=>{if(active)setEvents(data.events)})
   .catch(()=>{if(active)setError('事件记录暂时无法读取，请重试；这不表示没有事件。')})
   .finally(()=>{if(active)setLoading(false)})
  return ()=>{active=false}
 },[channelId,reload])
 return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" ref={dialog} role="dialog" aria-modal="true" aria-label="区域事件记录"
  onKeyDown={e=>{
   if(e.key==='Escape'){e.stopPropagation();onClose()}
   if(e.key==='Tab'){
    const buttons=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary')??[])
    const first=buttons[0],last=buttons[buttons.length-1]
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
   }
  }}>
  <div className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-lg bg-surface p-5">
   <div className="flex justify-between"><h2>区域事件记录</h2><button type="button" onClick={onClose}>关闭事件记录</button></div>
   <p className="my-2 text-xs text-ink-faint">最近100条事件，时间为服务记录时间。规则判断使用原始视频帧时间；目标编号仅在本通道运行会话内有效。</p>
   <button type="button" disabled={loading} onClick={()=>setReload(v=>v+1)}>刷新记录</button>
   {loading?<p role="status">正在读取事件…</p>:error?<p role="alert" className="text-danger">{error}</p>:!events.length?<p>暂无已保存事件。请确认已开启跟踪并配置区域规则。</p>:
    <ul className="mt-3 space-y-3">{events.map(e=><li key={e.event_id} className="rounded border border-line p-3 text-sm">
     <div>{names[e.type]??e.type} · {e.rule_id} · {new Date(e.timestamp*1000).toLocaleString()}</div>
     <div className="break-all text-xs text-ink-faint">目标：{e.track_id}</div>
     <div className="text-xs">复核：{stateName(reviewNames,e.review_status)} · 通知：{stateName(notificationNames,e.notification_status)}</div>
     <details className="mt-2 text-xs">
      <summary className="cursor-pointer">查看事件依据</summary>
      {e.review_job?.result?.scope==='target_presence'&&<p className="my-2 text-ink-faint">复核范围：仅确认截图中是否存在指定目标，不确认越线方向或停留时长。描述：{e.review_job.result.description||'未记录'}</p>}
      <dl className="mt-2 space-y-1">
       <div><dt className="inline">截图证据：</dt><dd className="inline">{stateName(evidenceNames,e.evidence?.status)}</dd></div>
       <div><dt className="inline">目标：</dt><dd className="inline">{e.target?.class_name||e.target?.label_id||'未记录'}</dd></div>
       {e.target?.query_description&&<div><dt className="inline">识别描述：</dt><dd className="inline">{e.target.query_description}</dd></div>}
       <div><dt className="inline">检测分数：</dt><dd className="inline">{typeof e.target?.confidence==='number'?e.target.confidence.toFixed(3):'模型未提供或未记录'}</dd></div>
       {e.source_frame&&<div><dt className="inline">原始画面：</dt><dd className="inline">{e.source_frame.width} × {e.source_frame.height} · {e.source_frame.model_name||'模型未记录'}</dd></div>}
      </dl>
      <p className="mt-2 text-ink-faint">原始触发记录会保留。复核失败、超时或不可用不等于复核通过。</p>
     </details>
    </li>)}</ul>}
  </div>
 </div>
}
