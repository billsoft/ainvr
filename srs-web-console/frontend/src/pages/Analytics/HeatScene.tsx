import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createHttpRecordingService } from '@/api/recordingService'
import type { HeatVariant } from './RegionHeatPanel'

const recordings=createHttpRecordingService()
/** Reuses stored source video. No camera connection, server decode or new collection.
 * Recording metadata cannot prove historic lens geometry: reference is opt-in,
 * visibly qualified, and never changes grid values or the floor-plan transform. */
export function HeatScene({variant,children}:{variant:HeatVariant;children:ReactNode}) {
  const [url,setUrl]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [ready,setReady]=useState(false),[show,setShow]=useState(true),[at,setAt]=useState<number|null>(null)
  const video=useRef<HTMLVideoElement|null>(null),generation=useRef(0),controller=useRef<AbortController|null>(null)
  useEffect(()=>()=>{generation.current++;controller.current?.abort()},[])
  useEffect(()=>{if(!url||ready)return;const timer=setTimeout(()=>{setError('参考帧读取超时，保留原始坐标网格。');setUrl(null)},15000);return()=>clearTimeout(timer)},[url,ready])
  const load=async()=>{
    const id=++generation.current;controller.current?.abort();const next=new AbortController();controller.current=next
    setBusy(true);setError('');setReady(false);setUrl(null)
    try{
      // Bound metadata lookup to the first five minutes of this coordinate group.
      const start=Date.parse(variant.from),end=Math.min(Date.parse(variant.to),start+300000)
      const segments=await recordings.listSegments(variant.input_stream_id,start,end,next.signal)
      const segment=segments.filter(s=>s.channelId===variant.input_stream_id&&s.startTs>=start&&s.startTs<end&&s.width===variant.source_width&&s.height===variant.source_height).sort((a,b)=>a.startTs-b.startTs)[0]
      if(!segment)throw Error('该时段没有同源同尺寸录像，保留原始坐标网格。')
      await recordings.preparePlayback(segment.id)
      if(generation.current===id){setAt(segment.startTs);setUrl(recordings.playUrl(segment.id));setShow(true)}
    }catch(e){if(generation.current===id)setError(e instanceof Error?e.message:'参考画面读取失败')}
    finally{if(generation.current===id)setBusy(false)}
  }
  return <div className="space-y-1.5">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" className="btn-secondary !px-2.5 !py-1" disabled={busy} onClick={()=>void load()}>{busy?'正在查找录像…':'载入录像参考画面'}</button>
      {ready&&<label className="flex items-center gap-1"><input type="checkbox" checked={show} onChange={e=>setShow(e.target.checked)}/>显示参考画面</label>}
      <span className="text-ink-subtle">{ready&&show?'同源录像参照 · 未校验历史镜头姿态':'原画面坐标 · 独立数据图层'}</span>
    </div>
    {error&&<p role="status" className="text-xs text-amber-700">{error}</p>}
    <div className="relative mx-auto w-full overflow-hidden rounded-base border border-line bg-slate-100" style={{aspectRatio:`${variant.source_width}/${variant.source_height}`,maxHeight:'clamp(8rem,18vh,16rem)'}}>
      {url&&<video ref={video} src={url} muted playsInline preload="auto" className={`absolute inset-0 h-full w-full object-contain ${ready&&show?'':'invisible'}`}
        onLoadedData={e=>{const v=e.currentTarget;v.pause();if(v.videoWidth!==variant.source_width||v.videoHeight!==variant.source_height){setError('录像实际尺寸与统计坐标不一致，未叠加参考画面。');setUrl(null)}else setReady(true)}}
        onError={()=>{setError('浏览器无法读取该段录像，保留原始坐标网格。');setUrl(null)}}/>}
      {children}
    </div>
    {ready&&show&&at!==null&&<p className="text-[11px] text-ink-faint">参考帧：{new Date(at).toLocaleString('zh-CN')}。请核对场景；转动镜头或历史画面设置变化时关闭参照。不是地面投影。</p>}
  </div>
}
