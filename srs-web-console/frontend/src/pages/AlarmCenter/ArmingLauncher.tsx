import {useEffect,useState} from 'react'
import {createPortal} from 'react-dom'
import {useFullscreenPortalHost} from '@/hooks/useFullscreenPortalHost'
import type {ChannelWithStatus} from '@/types/channel'
import {aiChannelService} from '@/api/aiChannelService'
import {alarmTriggerService,type AlarmSource} from '@/api/alarmTriggerService'
import {alarmDefinitionService} from '@/api/alarmDefinitionService'
import {alarmArmingService} from '@/api/alarmArmingService'
import {flowService,type Counter} from '@/api/flowService'
import {alarmZoneService,type AlarmZone} from '@/api/alarmZoneService'
import type {ArmingDocument} from '@/features/armingDocument'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
import {zoneSourceGeometry} from '@/features/zoneSourceGeometry'
import {ArmingModal} from './ArmingModal'
interface Reference {url:string;width:number;height:number;geometryRevision:string;capturedAt:string}
interface Props {channel:ChannelWithStatus;video:HTMLVideoElement;onClose:()=>void;onSaved:()=>void}
export function ArmingLauncher({channel,video,onClose,onSaved}:Props){
 const portalHost=useFullscreenPortalHost()
 const [data,setData]=useState<{reference:Reference;base:ArmingDocument|null;definitions:TriggerDefinition[];counters:Counter[];sources:AlarmSource[];legacyZones:AlarmZone[];warning:string;panoramic:boolean}|null>(null)
 const [error,setError]=useState(''),[retry,setRetry]=useState(0)
 const [resetGeometry,setResetGeometry]=useState(false)
 useEffect(()=>{
  let alive=true,url:string|undefined
  setError('');setData(null);setResetGeometry(false)
  void (async()=>{
   try{
    if(video.readyState<2||video.paused||!video.videoWidth||!video.videoHeight)throw Error('视频尚未播放，请等待画面出现后重试。')
    const geometryRevision=zoneSourceGeometry(channel,video.videoWidth,video.videoHeight)
    if(!geometryRevision)throw Error('接入来源尚未确认，请刷新通道。')
    const canvas=document.createElement('canvas');canvas.width=Math.min(1280,video.videoWidth);canvas.height=Math.round(canvas.width*video.videoHeight/video.videoWidth)
    const ctx=canvas.getContext('2d');if(!ctx)throw Error('浏览器无法截取参考画面。')
    ctx.drawImage(video,0,0,canvas.width,canvas.height)
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('参考画面截取失败')),'image/jpeg',.9))
    const [arming,definitions,channels,counters]=await Promise.all([alarmArmingService.read(channel.id),alarmDefinitionService.list(),aiChannelService.list(),flowService.list().then(r=>r.items).catch(()=>[] as Counter[])])
    if(arming.arming&&arming.arming.source_id!==channel.id)throw Error('已保存布防来源不匹配，请重新确认来源；原配置未改变。')
    const legacyZones=arming.arming?[]:(await alarmZoneService.list(channel.id)).items.filter(z=>z.state==='active')
    if(legacyZones.some(z=>z.channel_id!==channel.id))throw Error('历史热区来源不匹配，未覆盖原区域。')
    const results=await Promise.allSettled(channels.map(c=>alarmTriggerService.source(c.id)))
    if(!alive)return
    url=URL.createObjectURL(blob)
    setData({base:arming.arming,definitions:definitions.items,counters,legacyZones,
     sources:results.flatMap(r=>r.status==='fulfilled'&&r.value.input_stream_id===channel.id?[r.value]:[]),
     panoramic:channels.some((c,i)=>{const r=results[i];return r?.status==='fulfilled'&&r.value.input_stream_id===channel.id&&c.config.snapshot?.projection_mode==='erp_equirect'}),
     warning:results.some(r=>r.status==='rejected')?'部分处理器暂不可用，不能新增选用；已有选用会保留并在保存时再次验证。':'',
     reference:{url,width:canvas.width,height:canvas.height,geometryRevision,capturedAt:new Date().toLocaleString()}})
   }catch(e){if(alive)setError(e instanceof Error?e.message:'读取布防失败，请重试。')}
  })()
  return()=>{alive=false;if(url)URL.revokeObjectURL(url)}
 },[channel.id,channel.inputGeneration,channel.createdAt,video,retry])
 const legacyMismatch=!!data&&!data.base&&data.legacyZones.some(z=>z.geometry_revision!==data.reference.geometryRevision)
 if(data&&((data.base&&data.base.geometry_revision!==data.reference.geometryRevision)||legacyMismatch)&&!resetGeometry)return createPortal(
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><div role="dialog" aria-modal="true" aria-label="画面规格已变化" className="max-w-lg rounded-panel bg-surface p-5 text-sm text-ink shadow-modal">
   <h2 className="text-base font-semibold">画面规格已变化</h2><p className="my-4">原热区不能直接用于当前画面。重新布防将从空白草稿开始，需重新绘制热区和选用触发器。只有最后点击保存，才会替换原配置；取消不会修改。</p>
   <div className="flex flex-wrap gap-3"><button autoFocus className="btn-secondary" onClick={onClose}>取消</button><button className="btn-secondary" onClick={()=>setResetGeometry(true)}>按当前画面重新布防</button></div>
  </div></div>,portalHost)
 if(data)return <ArmingModal sourceId={channel.id} sourceName={channel.name} base={data.base} reference={data.reference} definitions={data.definitions} counters={data.counters} sources={data.sources} legacyZones={legacyMismatch?[]:data.legacyZones} panoramic={data.panoramic} warning={data.warning} resetGeometry={resetGeometry&&!legacyMismatch} resetLegacyGeometry={resetGeometry&&legacyMismatch} onClose={onClose} onSaved={()=>{onSaved();onClose()}}/>
 return createPortal(<div role="dialog" aria-modal="true" aria-label="读取布防" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><div className="rounded-panel bg-surface p-5 text-sm text-ink shadow-modal"><p role={error?'alert':'status'}>{error||'正在读取布防与参考画面…'}</p><div className="mt-4 flex gap-3">{error&&<button className="btn-secondary" onClick={()=>setRetry(n=>n+1)}>重试读取布防</button>}<button className="btn-secondary" onClick={onClose}>取消</button></div></div></div>,portalHost)
}
