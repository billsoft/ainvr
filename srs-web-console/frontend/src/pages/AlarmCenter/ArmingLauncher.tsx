import {useEffect,useState} from 'react'
import {X} from 'lucide-react'
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
import {armingSceneService,type ArmingScenes,type PresetArmingSelection} from '@/api/armingSceneService'
import {PresetArmingEntry} from './PresetArmingEntry'
import type {SceneEditingContext} from '@/features/armingSceneDraft'
interface Reference {url:string;width:number;height:number;geometryRevision:string;capturedAt:string}
interface Props {outputName?:string;processorId?:string;channel:ChannelWithStatus;video:HTMLVideoElement;onClose:()=>void;onSaved:()=>void}
export function ArmingLauncher({channel,processorId,outputName,video,onClose,onSaved}:Props){
 const portalHost=useFullscreenPortalHost()
 const [data,setData]=useState<{reference:Reference;sceneContext?:SceneEditingContext;base:ArmingDocument|null;definitions:TriggerDefinition[];counters:Counter[];sources:AlarmSource[];legacyZones:AlarmZone[];warning:string;panoramic:boolean}|null>(null)
 const [error,setError]=useState(''),[retry,setRetry]=useState(0)
 const [resetGeometry,setResetGeometry]=useState(false)
 const [selection,setSelection]=useState<{scope:string;value:PresetArmingSelection|null}>()
 const [entry,setEntry]=useState<{status:ArmingScenes;ordinary:boolean}|null>(null)
 const scope=JSON.stringify([channel.id,processorId,channel.inputGeneration,channel.createdAt])
 const choice=selection?.scope===scope?selection.value:undefined
 useEffect(()=>{
  let alive=true,url:string|undefined
  setError('');setData(null);setEntry(null);setResetGeometry(false)
  void (async()=>{
   try{
    if(video.readyState<2||video.paused||!video.videoWidth||!video.videoHeight)throw Error('视频尚未播放，请等待画面出现后重试。')
    const geometryRevision=zoneSourceGeometry(channel,video.videoWidth,video.videoHeight)
    if(!geometryRevision)throw Error('接入来源尚未确认，请刷新通道。')
    const sceneStatus=await armingSceneService.read(channel.id,processorId)
    if(typeof sceneStatus.eligible!=='boolean'||!Array.isArray(sceneStatus.items))throw Error('无法确认场景绑定状态，请重试。')
    if(sceneStatus.eligible&&sceneStatus.presetBindingAvailable&&choice===undefined){
     const bound=new Set(sceneStatus.items.map(s=>s.zone_id))
     const scoped=bound.size?(await alarmArmingService.read(channel.id,processorId)).arming:null
     const ordinary=!!scoped&&(scoped.zones.some(z=>!bound.has(z.zone_id))||scoped.assignments.some(a=>a.zone_id===null))
     if(alive)setEntry({status:sceneStatus,ordinary})
     return
    }
    let sceneContext:SceneEditingContext|undefined,blob:Blob,width:number,height:number,capturedAt:string
    if(sceneStatus.eligible&&processorId){
     const frozen=await armingSceneService.freeze(channel.id,processorId,choice??undefined)
     if(choice&&(frozen.binding_mode!=='preset'||frozen.preset_id!==choice.preset_id||frozen.preset_fingerprint!==choice.preset_fingerprint))throw Error('布防预置位已变化，请退出后重新选择；原配置未改变。')
     if(choice===null&&frozen.binding_mode!=='current')throw Error('未取得普通区域核对画面，请退出后重试。')
     if(!frozen.frame_id||!frozen.identity||!frozen.epoch||frozen.geometry_revision!==geometryRevision||
       !Number.isSafeInteger(frozen.width)||!Number.isSafeInteger(frozen.height)||frozen.width<=0||frozen.height<=0||!Array.isArray(frozen.items))throw Error('冻结参考与当前来源不一致，请重试。')
     sceneContext={processorId,frame:frozen,guardBlocked:sceneStatus.guard_blocked};blob=await armingSceneService.image(frozen.image_url)
     width=frozen.width;height=frozen.height;capturedAt=frozen.captured_at
    }else{
     if(sceneStatus.items.length)throw Error('此来源有场景绑定，请从对应 AI 输出视频下方的布防入口编辑。')
     const canvas=document.createElement('canvas');canvas.width=Math.min(1280,video.videoWidth);canvas.height=Math.round(canvas.width*video.videoHeight/video.videoWidth)
     const ctx=canvas.getContext('2d');if(!ctx)throw Error('浏览器无法截取参考画面。')
     ctx.drawImage(video,0,0,canvas.width,canvas.height)
     blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('参考画面截取失败')),'image/jpeg',.9))
     width=canvas.width;height=canvas.height;capturedAt=new Date().toLocaleString()
    }
    const [arming,definitions,channels,counters]=await Promise.all([alarmArmingService.read(channel.id,processorId),alarmDefinitionService.list(),aiChannelService.list(),flowService.list().then(r=>r.items).catch(()=>[] as Counter[])])
    if(sceneContext?.frame.binding_mode==='current'&&sceneContext.frame.items.length&&arming.arming?.geometry_revision!==geometryRevision)throw Error('画面规格已变化，请先从布防预置位核对已有绑定区域。')
    if(arming.arming&&arming.arming.source_id!==channel.id)throw Error('已保存布防来源不匹配，请重新确认来源；原配置未改变。')
    const legacyZones=arming.arming||processorId?[]:(await alarmZoneService.list(channel.id)).items.filter(z=>z.state==='active')
    if(legacyZones.some(z=>z.channel_id!==channel.id))throw Error('历史热区来源不匹配，未覆盖原区域。')
    const results=await Promise.allSettled(channels.filter(c=>!processorId||c.id===processorId).map(c=>alarmTriggerService.source(c.id)))
    if(!alive)return
    url=URL.createObjectURL(blob)
    setData({base:arming.arming,sceneContext,definitions:definitions.items,counters,legacyZones,
     sources:results.flatMap(r=>r.status==='fulfilled'&&r.value.input_stream_id===channel.id?[r.value]:[]),
     panoramic:channels.filter(c=>!processorId||c.id===processorId).some((c,i)=>{const r=results[i];return r?.status==='fulfilled'&&r.value.input_stream_id===channel.id&&c.config.snapshot?.projection_mode==='erp_equirect'}),
     warning:[results.some(r=>r.status==='rejected')?'部分处理器信息暂不可用；仅能选用已就绪的处理器，已有配置会保留。':'',
      sceneStatus.eligible&&sceneStatus.presetBindingAvailable===false?(sceneStatus.presetBindingReason||'此设备暂不支持自动回位核验，转动后请人工核对布防。'):''].filter(Boolean).join(' '),
     reference:{url,width,height,geometryRevision,capturedAt}})
   }catch(e){if(alive)setError(e instanceof Error?e.message:'读取布防失败，请重试。')}
  })()
  return()=>{alive=false;if(url)URL.revokeObjectURL(url)}
 },[channel.id,processorId,channel.inputGeneration,channel.createdAt,video,retry,choice])
 if(entry)return createPortal(<PresetArmingEntry key={scope} sourceId={channel.id} status={entry.status} hasOrdinary={entry.ordinary} onSelect={value=>setSelection({scope,value})} onClose={onClose}/>,portalHost)
 const legacyMismatch=!!data&&!data.base&&data.legacyZones.some(z=>z.geometry_revision!==data.reference.geometryRevision)
 if(data&&((data.base&&data.base.geometry_revision!==data.reference.geometryRevision)||legacyMismatch)&&!resetGeometry)return createPortal(
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><div role="dialog" aria-modal="true" aria-label="画面规格已变化" className="relative max-w-lg rounded-panel bg-surface p-5 text-sm text-ink shadow-modal">
   <button aria-label="关闭" className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-muted" onClick={onClose}><X size={18}/></button><h2 className="pr-10 text-base font-semibold">画面规格已变化</h2><p className="my-4">原热区不能直接用于当前画面。重新布防将从空白草稿开始，需重新绘制热区和选用告警规则。只有最后点击保存，才会替换原配置；取消不会修改。</p>
   <div className="flex flex-wrap gap-3"><button autoFocus className="btn-secondary" onClick={onClose}>取消</button><button className="btn-secondary" onClick={()=>setResetGeometry(true)}>按当前画面重新布防</button></div>
  </div></div>,portalHost)
 if(data)return <ArmingModal sceneContext={data.sceneContext} send={processorId?(input,key)=>alarmArmingService.save(input,key,processorId):undefined} sourceId={channel.id} sourceName={outputName??channel.name} base={data.base} reference={data.reference} definitions={data.definitions} counters={data.counters} sources={data.sources} legacyZones={legacyMismatch?[]:data.legacyZones} panoramic={data.panoramic} warning={data.warning} resetGeometry={resetGeometry&&!legacyMismatch} resetLegacyGeometry={resetGeometry&&legacyMismatch} onClose={onClose} onSaved={()=>{onSaved();onClose()}}/>
 return createPortal(<div role="dialog" aria-modal="true" aria-label="读取布防" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><div className="relative rounded-panel bg-surface p-5 pr-14 text-sm text-ink shadow-modal"><button aria-label="关闭" className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-muted" onClick={onClose}><X size={18}/></button><p role={error?'alert':'status'}>{error||'正在读取布防与参考画面…'}</p><div className="mt-4 flex gap-3">{error&&<button className="btn-secondary" onClick={()=>setRetry(n=>n+1)}>重试读取布防</button>}<button className="btn-secondary" onClick={onClose}>取消</button></div></div></div>,portalHost)
}
