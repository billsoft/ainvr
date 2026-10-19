import { VideoPlayer } from '@/components/player/VideoPlayer'
import { parseStreamPath } from '@/utils/channelMatching'
import { useEffect, useRef, useState } from 'react'
import type { AiAnalyticsRule } from '@/types/aiChannel'
import { ruleError } from '@/features/analyticsRules'
export function AnalyticsRuleEditor({rules,onChange,sourceUrl}:{rules:AiAnalyticsRule[];onChange:(v:AiAnalyticsRule[])=>void;sourceUrl?:string}) {
  const [preview,setPreview]=useState(false)
  const [video,setVideo]=useState<HTMLVideoElement|null>(null)
  const [captureError,setCaptureError]=useState('')
  const source=parseStreamPath(sourceUrl)
  useEffect(()=>{setPreview(false);setVideo(null);setImage(undefined);setReadyImage(undefined);setCaptureError('')},[sourceUrl])
  const [selected,setSelected]=useState(0)
  const [image,setImage]=useState<string>()
  const [readyImage,setReadyImage]=useState<string>()
  const [imageError,setImageError]=useState('')
  const imageReady=!!image && readyImage===image
  const [ratio,setRatio]=useState(16/9)
  const dragging=useRef<number|null>(null)
  const suppressClick=useRef(false)
  useEffect(()=>{dragging.current=null;suppressClick.current=false},[selected,sourceUrl])
  useEffect(()=>()=>{if(image) URL.revokeObjectURL(image)},[image])
  const rule=rules[selected]
  const change=(patch:Partial<AiAnalyticsRule>)=>onChange(rules.map((r,i)=>i===selected?{...r,...patch}:r))
  const movePoint=(index:number,x:number,y:number)=>{
    if(!rule || !imageReady)return
    change({points:rule.points.map((p,i)=>
      i===index?[Math.max(0,Math.min(1,x)),Math.max(0,Math.min(1,y))]:p)})
  }
  return <section aria-label="区域规则" className="space-y-3">
    <h3 className="text-sm font-medium">区域规则</h3>
    <p className="text-xs text-ink-faint">以目标框底边中点判断越线、区域进出和停留。坐标对应完整原始画面，不使用裁剪或全景展开画面。</p>
    <div className="flex flex-wrap gap-2">
      {rules.map((r,i)=><button type="button" key={i} aria-pressed={i===selected} onClick={()=>setSelected(i)} className="rounded border p-2 text-sm">{r.id || '未命名规则'}</button>)}
      <button type="button" disabled={rules.length>=64} onClick={()=>{
        let n=rules.length+1;while(rules.some(r=>r.id==='规则'+n)) n++
        onChange([...rules,{id:'规则'+n,type:'line',points:[],dwell_seconds:5}]);setSelected(rules.length)
      }}>添加规则</button>
    </div>
    {rule && <>
      <label className="block text-sm">规则名称<input aria-label="规则名称" value={rule.id} maxLength={128} onChange={e=>change({id:e.target.value})} className="ml-2 rounded border p-1"/></label>
      <label className="block text-sm">规则类型<select aria-label="规则类型" disabled={!imageReady} value={rule.type} onChange={e=>change({type:e.target.value as AiAnalyticsRule['type'],points:[]})} className="ml-2 rounded border p-1">
        <option value="line">越线计数</option><option value="region">区域进入与离开</option><option value="dwell">区域停留</option>
      </select></label>
      <label className="block text-sm">目标标签 ID（留空表示全部）<input aria-label="规则目标标签" value={rule.label_id??''} maxLength={128} onChange={e=>change({label_id:e.target.value})} className="ml-2 rounded border p-1"/></label>
      {rule.type==='dwell'&&<label className="block text-sm">停留秒数<input aria-label="停留秒数" type="number" min={1} max={86400} value={rule.dwell_seconds??5} onChange={e=>change({dwell_seconds:Number(e.target.value)})}/></label>}
      {source && <div className="space-y-2">
        <button type="button" onClick={()=>setPreview(v=>!v)}>{preview?'关闭源流预览':'打开源流取景'}</button>
        {preview && <>
          <VideoPlayer title="规则取景 · 原始画面" protocols={['webrtc']} primary="webrtc"
            stream={{host:window.location.hostname,...source}} muted allowPanorama={false}
            onVideoElement={setVideo} className="aspect-video w-full"/>
          <button type="button" onClick={()=>{
            setCaptureError('')
            if(!video || video.readyState<2 || !video.videoWidth || !video.videoHeight) {
              setCaptureError('画面尚未就绪，请等待视频出现后重试');return
            }
            try {
              const canvas=document.createElement('canvas')
              canvas.width=Math.min(1280,video.videoWidth)
              canvas.height=Math.round(canvas.width*video.videoHeight/video.videoWidth)
              const context=canvas.getContext('2d')
              if(!context) throw new Error('canvas unavailable')
              context.drawImage(video,0,0,canvas.width,canvas.height)
              setReadyImage(undefined)
              setImageError('')
              setImage(canvas.toDataURL('image/jpeg',0.9))
              setRatio(video.videoWidth/video.videoHeight)
              setPreview(false)
            } catch {
              setCaptureError('浏览器无法截取此视频，请使用完整原始画面参考图')
            }
          }}>使用当前画面绘制规则</button>
        </>}
        {captureError&&<p role="alert" className="text-xs text-danger">{captureError}</p>}
      </div>}
      <label className="block text-xs">加载原始画面参考图（仅在浏览器显示，不上传）
        <input type="file" accept="image/*" onChange={e=>{const f=e.target.files?.[0];if(f){setReadyImage(undefined);setImageError('');setImage(URL.createObjectURL(f))}}}/>
      </label>
      {!image&&<p className="text-xs text-ink-faint">请先加载同一摄像机的完整原始画面，加载成功后才能绘制或调整规则。</p>}
      {imageError&&<p role="alert" className="text-xs text-danger">{imageError}</p>}
      <div className="relative w-full overflow-hidden rounded bg-slate-900" style={{aspectRatio:ratio}}>
        {image&&<img src={image} alt="规则参考画面" className="absolute h-full w-full" onLoad={e=>{
          const {naturalWidth:w,naturalHeight:h}=e.currentTarget
          if(w>0&&h>0){setRatio(w/h);setReadyImage(image);setImageError('')}
        }} onError={()=>{setReadyImage(undefined);dragging.current=null;setImageError('参考图加载失败，请重新选择完整原始画面')}}/>}
        <svg role="group" aria-label="规则绘图区" aria-disabled={!imageReady} viewBox="0 0 1000 1000" preserveAspectRatio="none" className="absolute h-full w-full cursor-crosshair" style={{touchAction:'none'}}
          onPointerMove={e=>{
            if(!imageReady || dragging.current===null)return
            const b=e.currentTarget.getBoundingClientRect()
            if(!b.width||!b.height)return
            suppressClick.current=true
            movePoint(dragging.current,(e.clientX-b.left)/b.width,(e.clientY-b.top)/b.height)
          }}
          onPointerUp={()=>{dragging.current=null}}
          onPointerCancel={()=>{dragging.current=null;suppressClick.current=false}}
          onLostPointerCapture={()=>{dragging.current=null}}
          onClick={e=>{
          if(!imageReady)return
          if(suppressClick.current){suppressClick.current=false;return}
          const b=e.currentTarget.getBoundingClientRect()
          if(!b.width||!b.height||rule.points.length>=(rule.type==='line'?2:32))return
          change({points:[...rule.points,[Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))]]})
        }}>
          {rule.type==='line'?<polyline points={rule.points.map(p=>p.map(v=>v*1000).join(',')).join(' ')} fill="none" stroke="#22d3ee" strokeWidth="3" vectorEffect="non-scaling-stroke"/>:<polygon points={rule.points.map(p=>p.map(v=>v*1000).join(',')).join(' ')} fill="#22d3ee33" stroke="#22d3ee" strokeWidth="3" vectorEffect="non-scaling-stroke"/>}
          {rule.points.map((p,i)=><circle key={i} cx={p[0]*1000} cy={p[1]*1000} r={12} fill="#facc15"
            role="button" tabIndex={imageReady?0:-1} aria-disabled={!imageReady} aria-label={`顶点 ${i+1}，横向 ${(p[0]*100).toFixed(1)}%，纵向 ${(p[1]*100).toFixed(1)}%`}
            onClick={e=>{e.stopPropagation();suppressClick.current=false}}
            onPointerDown={e=>{
              if(!imageReady)return
              e.preventDefault();e.stopPropagation();dragging.current=i;suppressClick.current=false
              e.currentTarget.ownerSVGElement?.setPointerCapture?.(e.pointerId)
              e.currentTarget.focus()
            }}
            onKeyDown={e=>{
              const delta= e.shiftKey?0.01:0.001
              const shifts:Record<string,[number,number]>={ArrowLeft:[-delta,0],ArrowRight:[delta,0],ArrowUp:[0,-delta],ArrowDown:[0,delta]}
              const shift=shifts[e.key]
              if(!shift)return
              e.preventDefault();e.stopPropagation();movePoint(i,p[0]+shift[0],p[1]+shift[1])
            }}/>) }
        </svg>
      </div>
      <p className="text-xs">点击添加{rule.type==='line'?'两个端点':'区域顶点'}，拖动顶点调整位置。选中顶点后方向键微调，Shift 加快。区域自动闭合；越线默认统计两个方向。</p>
      <p className="text-xs text-ink-faint">判断位置使用检测框底边中点，不是头顶或整个检测框。请把线或区域边界放在目标完整可见、遮挡较少的位置，避开画面边缘；修改位置后应重新核对实际通行结果。</p>
      <div className="flex gap-3"><button type="button" disabled={!imageReady} onClick={()=>change({points:rule.points.slice(0,-1)})}>撤销上一点</button><button type="button" disabled={!imageReady} onClick={()=>change({points:[]})}>重新绘制</button><button type="button" onClick={()=>{onChange(rules.filter((_,i)=>i!==selected));setSelected(0)}}>删除规则</button></div>
      {ruleError(rule)&&<p role="alert" className="text-xs text-danger">{ruleError(rule)}</p>}
    </>}
  </section>
}
