import {useEffect,useState} from 'react'
import {request,requestBlob} from '@/api/httpClient'
interface EvidenceState {state:'available'|'unavailable'|'pending';reason?:string;evidence?:{kind:string;variants:('processed'|'original')[];image_width:number;image_height:number;pinned?:boolean;retention?:string;saved_at?:string;expires_at?:string}}
const button='btn-secondary'
export function BehaviorEvidence({eventId}:{eventId:string}){
 const [loaded,setLoaded]=useState<{eventId:string;value:EvidenceState}|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0)
 const [variant,setVariant]=useState<'processed'|'original'>('processed'),[picture,setPicture]=useState<{eventId:string;variant:string;url:string}|null>(null),[imageError,setImageError]=useState(false)
 const value=loaded?.eventId===eventId?loaded.value:null,url=picture?.eventId===eventId&&picture.variant===variant?picture.url:null
 useEffect(()=>{
  let active=true,timer:ReturnType<typeof setTimeout>|undefined;setLoaded(null);setError(false)
  const load=()=>{void request<EvidenceState>(`/alarms/behavior-events/${encodeURIComponent(eventId)}/evidence`,{signal:AbortSignal.timeout(20000)}).then(v=>{if(active){setLoaded({eventId,value:v});if(v.state==='pending'&&v.reason!=='capture_disabled')timer=setTimeout(load,3000)}}).catch(()=>{if(active)setError(true)})}
  load();return()=>{active=false;clearTimeout(timer)}
 },[eventId,retry])
 useEffect(()=>{
  let active=true,objectUrl:string|null=null;setPicture(null);setImageError(false)
  if(value?.state==='available'&&value.evidence?.variants.includes(variant))void requestBlob(`/alarms/behavior-events/${encodeURIComponent(eventId)}/evidence/image?variant=${variant}`,AbortSignal.timeout(20000)).then(blob=>{
   if(!active)return;if(!blob){setImageError(true);return}objectUrl=URL.createObjectURL(blob);setPicture({eventId,variant,url:objectUrl})
  }).catch(()=>{if(active)setImageError(true)})
  return()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl)}
 },[eventId,value,variant,retry])
 const unavailable=value?.reason==='retention'?'独立保存的截图已到保留期限；告警和行为记录仍保留。':value?.reason==='capacity'?'截图已因容量上限清理；告警和行为记录仍保留。':value?.reason==='capture_timeout'?'未能在取证期限内取得原帧截图；不会替换为当前画面。':value?.reason==='stored_file_missing'?'独立保存的截图文件缺失或异常，请检查告警存储。':value?.reason==='queue_capacity'?'取证队列已满，此记录未保存独立截图。':value?.reason==='frame_identity_unavailable'?'此历史记录没有完整原帧身份，无法确认对应截图。':value?.reason==='ambiguous_frame'?'找到多条冲突归档，暂不提供未经确认的截图。':'原帧截图未保存、已清理或归档暂不可用。'
 return <section className="space-y-3 text-sm" aria-label="原帧目标截图">
  <h3 className="font-medium">原帧目标截图</h3>
  {error?<p role="alert">证据读取失败。<button className={button} onClick={()=>setRetry(n=>n+1)}>重试证据</button></p>:!value?<p role="status">正在核对原帧…</p>:value.state==='pending'?<p role="status">{value.reason==='capture_disabled'?'独立保存已暂停，此记录仍在等待保存。':'原帧截图正在独立保存，页面会自动更新…'}</p>:value.state==='unavailable'?<p role="status">{unavailable}<button className={button} onClick={()=>setRetry(n=>n+1)}>重新核对证据</button></p>:<>
   {value.evidence?.variants.includes('original')&&<label>截图版本 <select className={`${button} bg-surface`} value={variant} onChange={e=>setVariant(e.target.value as typeof variant)}><option value="processed">处理后</option><option value="original">原始裁剪</option></select></label>}
   {imageError?<p role="alert">截图未能读取，可能已被清理。<button className={button} onClick={()=>setRetry(n=>n+1)}>重试证据</button></p>:url?<div className="flex min-h-64 items-center justify-center rounded-card bg-slate-950 p-4"><img className="mx-auto max-h-[48dvh] min-h-48 max-w-full object-contain" src={url} alt="该行为原帧中的目标裁剪截图" onError={()=>setImageError(true)}/></div>:<p role="status">正在读取截图…</p>}
   <p className="text-xs text-ink-subtle">这是对应原帧的目标裁剪，不是完整画面。{value.evidence?.pinned&&value.evidence.retention==='alarm'?<>已由告警服务独立保存，不随识别历史清理。保留至 {value.evidence.expires_at?new Date(value.evidence.expires_at).toLocaleString():'按保存策略'}，容量不足时可能提前清理。</>:<>截图随识别历史保留，可能被清理；此记录尚未独立保存。</>}</p>
  </>}
 </section>
}
