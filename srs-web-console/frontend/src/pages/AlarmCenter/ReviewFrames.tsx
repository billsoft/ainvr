import {Link} from 'react-router-dom'
import {keyframePlaybackHref} from '@/features/alarmNavigation'
import {ApproachBand} from './ApproachBand'
import {useEffect,useState} from 'react'
import type {AlarmEvent} from '@/api/alarmEventService'
import {request} from '@/api/httpClient'
import {reviewTrajectorySegments} from '@/features/reviewTrajectory'

const roleNames:Record<string,string>={start:'开始',before:'进入前',after:'进入后',trigger:'触发时刻',entry_before:'进入前',entry_after:'进入后',exit_before:'离开前',exit_after:'离开后',first:'首次检出',entered:'进入后',exited:'离开后'}
type ImageMode='original'|'marked'|'model'
const modeNames={original:'原图',marked:'区域与目标',model:'模型输入预览'}
function imageRatio(size:{width?:number;height?:number}|undefined){
 return size&&Number.isFinite(size.width)&&Number.isFinite(size.height)&&size.width!>0&&size.height!>0?`${size.width}/${size.height}`:undefined
}

export function ReviewFrames({alarm}:{alarm:AlarmEvent}){
 const [mode,setMode]=useState<ImageMode>('marked')
 const [selected,setSelected]=useState<string|null>(null)
 const [failed,setFailed]=useState<Record<string,boolean>>({})
 const [images,setImages]=useState<Record<string,string>>({})
 useEffect(()=>{
  let active=true;setImages({});setFailed({})
  for(const f of [...(alarm.review?.frames??[]),...(alarm.review?.prepared_frames??[])]){
   void request<{jpeg_base64:string}>(`/alarms/events/${encodeURIComponent(alarm.alarm_id)}/review-frames/${f.key}`)
    .then(v=>{if(active)setImages(old=>({...old,[f.key]:`data:image/jpeg;base64,${v.jpeg_base64}`}))})
    .catch(()=>{if(active)setFailed(old=>({...old,[f.key]:true}))})
  }
  return()=>{active=false}
 },[alarm.alarm_id,alarm.review?.frames,alarm.review?.prepared_frames])
 const source=alarm.analysis_evidence?.source,context=alarm.analysis_evidence?.review_context
 const frames=alarm.review?.frames??[]
 const activeKey=frames.some(f=>f.key===selected)?selected:frames.at(-1)?.key
 const frame=frames.find(f=>f.key===activeKey)
 if(!frame)return null
 const index=frames.indexOf(frame)
 // Legacy evidence without a source kind uses the original full-frame contract.
 // A crop (or an unknown future kind) cannot inherit panorama coordinates.
 const fullFrame=frame.source_kind==null||frame.source_kind==='full_frame'
 const retainedTarget=frame.source_kind==='retained_target'
 const displayMode=mode==='marked'&&!fullFrame?'original':mode
 const prepared=alarm.review?.prepared_frames?.slice().reverse().find(p=>p.frame_id===frame.frame_id)
 const key=displayMode==='model'?prepared?.key:frame.key
 const size=displayMode==='model'?prepared:fullFrame?source:frame
 const submitted=alarm.review?.submitted_prompts?.find(p=>p.frame_id===frame.frame_id)
 const limited=alarm.review?.evidence_mode==='verified_behavior_available_visuals'
 const href=keyframePlaybackHref(alarm,frame.captured_at)
 return <section aria-label="审核关键帧" className="space-y-2">
  <h3 className="text-sm font-medium">审核关键帧 · 区域与目标位置</h3>
  {limited&&<p role="note" className="rounded-base border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">部分全景关键帧未留存{alarm.review?.missing_frame_ids?.length?`（${alarm.review.missing_frame_ids.length} 帧）`:''}。行为由规则引擎的完整观测证据核验，现有图片只核对目标类别；此模式只能用于确认，不能自动判为误报。</p>}
  <div className="flex flex-wrap gap-2" role="group" aria-label="证据图像类型">
   {(['original','marked',...(alarm.review?.prepared_frames?.length?['model' as const]:[])] as const).map(value=><button key={value} type="button" className="btn-secondary min-h-11" disabled={value==='marked'&&!fullFrame} aria-pressed={displayMode===value} onClick={()=>setMode(value)}>{modeNames[value]}</button>)}
  </div>
  {retainedTarget&&<p className="text-xs text-ink-subtle">目标原始特写 · 对应本次触发帧。全景热区和轨迹不叠加在特写上，避免混用坐标。</p>}
  <figure className="overflow-hidden rounded-base border border-line">
   <div className="relative mx-auto bg-slate-950" style={{aspectRatio:imageRatio(size),maxHeight:'48dvh'}}>
    {key&&images[key]?<img src={images[key]} alt={`关键帧 ${index+1}`} className="h-full max-h-[48dvh] w-full object-contain"/>:<p className="p-4 text-sm text-ink-subtle">{displayMode==='model'&&!prepared?'尚未生成模型输入':key&&failed[key]?'关键帧暂不可用或已过保留期':'正在读取关键帧…'}</p>}
    {displayMode==='marked'&&fullFrame&&source&&images[frame.key]&&<svg viewBox={`0 0 ${source.width} ${source.height}`} className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
     {context?.region&&context.approach_px!=null&&<ApproachBand points={context.region.points} width={source.width} height={source.height} percent={context.approach_px/source.width*100}/>}
     {context?.region&&<polygon points={context.region.points.map(p=>`${p[0]*source.width},${p[1]*source.height}`).join(' ')} fill="#2563eb22" stroke="#60a5fa" strokeWidth="2" vectorEffect="non-scaling-stroke"/>}
     {context?.schema_version==='2.0'?(context.trace??[]).filter(s=>BigInt(s.source_pts_ns)<=BigInt(frame.source_pts_ns)).map(s=><circle key={s.frame_id} cx={s.bbox.x+s.bbox.w/2} cy={s.bbox.y+s.bbox.h*(context.anchor==='center'?.5:1)} r={source.width/400} fill="#fbbf24"/>):reviewTrajectorySegments(context?.trace??[],frame.source_pts_ns,context?.anchor).map((points,i)=><polyline key={i} points={points} fill="none" stroke="#fbbf24" strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}
     <circle aria-label="当前判定点" cx={frame.bbox.x+frame.bbox.w/2} cy={frame.bbox.y+frame.bbox.h*(context?.anchor==='center'?.5:1)} r={source.width/160} fill="#fbbf24" stroke="#0f172a" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
     <rect x={frame.bbox.x} y={frame.bbox.y} width={frame.bbox.w} height={frame.bbox.h} fill="none" stroke="#34d399" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
    </svg>}
   </div>
   <figcaption className="p-2 text-xs text-ink-subtle">{frame.roles?.map(role=>roleNames[role]??role).join(' / ')||index+1} · {new Date(frame.captured_at).toLocaleString()}{href&&<Link className="mt-1 flex min-h-11 items-center text-primary" to={href} target="_blank" rel="noopener noreferrer" aria-label={`查看关键帧 ${index+1} 此刻录像`}>查看此刻录像</Link>}</figcaption>
  </figure>
  <div className="flex gap-2 overflow-x-auto pb-1" aria-label="关键时刻">
   {frames.map((f,i)=><button key={f.key} type="button" aria-pressed={activeKey===f.key} onClick={()=>setSelected(f.key)} className={`min-h-11 w-28 shrink-0 rounded-base border p-2 text-left text-xs ${activeKey===f.key?'border-primary bg-primary-50':'border-line'}`}>
    {images[f.key]&&<img src={images[f.key]} alt="" className="mb-1 h-14 w-full rounded object-contain bg-slate-950"/>}
    <span className="block font-medium">{f.roles?.map(role=>roleNames[role]??role).join(' / ')||`关键帧 ${i+1}`}</span><span className="text-ink-subtle">{new Date(f.captured_at).toLocaleTimeString()}</span>
   </button>)}
  </div>
  {fullFrame&&<p className="text-xs text-ink-subtle">蓝框是警戒区，绿框是本次目标；黄色大点是当前判定点（{context?.anchor==='center'?'框中心':'底边中点'}），小点是关键帧位置，虚线是接近范围。框的重叠本身不等于侵入，连续过程以规则证据和录像为准。</p>}
  <p className="text-xs text-ink-subtle">此标记图供人工核对。当前 AI 接收目标特写，核对目标类别；越界与持续时间由规则引擎判断，不让单张图片代替完整过程。</p>
  {submitted?<details className="rounded-base border border-line p-2 text-xs"><summary className="min-h-11 cursor-pointer py-2">当次提交给 AI 的说明</summary><p className="mt-2 whitespace-pre-wrap break-words">{submitted.description}</p></details>:<p className="text-xs text-ink-subtle">此记录尚无留存的当次 AI 说明；不会用当前配置替代历史输入。</p>}
 </section>
}
