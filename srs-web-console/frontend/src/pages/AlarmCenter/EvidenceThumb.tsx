import {useEffect,useRef,useState} from 'react'
import {ImageOff,Image} from 'lucide-react'
import {request,requestBlob} from '@/api/httpClient'

// Thumbnails load only when scrolled into view, a few at a time: a page of 50
// activities x 4 stages must not hit the evidence store all at once.
const MAX_LOADING=4
let loading=0
const waiting:(()=>void)[]=[]
function slot(){return new Promise<()=>void>(resolve=>{
 const take=()=>{loading++;let freed=false;resolve(()=>{if(freed)return;freed=true;loading--;waiting.shift()?.()})}
 if(loading<MAX_LOADING)take();else waiting.push(take)
})}
export function EvidenceThumb({eventId,label,onOpen,compact=false}:{eventId:string;label:string;onOpen?:()=>void;compact?:boolean}){
 const [picture,setPicture]=useState<{eventId:string;url:string|null;missing:boolean}|null>(null),[visible,setVisible]=useState(typeof IntersectionObserver==='undefined')
 const url=picture?.eventId===eventId?picture.url:null,missing=picture?.eventId===eventId&&picture.missing
 const box=useRef<HTMLSpanElement>(null)
 useEffect(()=>{
  if(visible||!box.current)return
  const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setVisible(true);observer.disconnect()}},{rootMargin:'200px'})
  observer.observe(box.current);return()=>observer.disconnect()
 },[visible])
 useEffect(()=>{
  if(!visible)return
  let active=true,objectUrl:string|null=null
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])
  void slot().then(free=>{if(!active){free();return}
   return request<{state:string}>(`/alarms/behavior-events/${encodeURIComponent(eventId)}/evidence`,{signal})
    .then(v=>v.state==='available'?requestBlob(`/alarms/behavior-events/${encodeURIComponent(eventId)}/evidence/image?variant=processed`,signal):null)
    .then(blob=>{if(!active)return;if(!blob){setPicture({eventId,url:null,missing:true});return}objectUrl=URL.createObjectURL(blob);setPicture({eventId,url:objectUrl,missing:false})})
    .catch(()=>{if(active)setPicture({eventId,url:null,missing:true})})
    .finally(free)})
  return()=>{active=false;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl)}
 },[eventId,visible])
 const content=<>
  {url?<img src={url} alt="" className="h-full w-full object-contain"/>:<span className="flex h-full flex-col items-center justify-center gap-1 text-xs text-slate-300">{missing?<ImageOff size={18} aria-hidden="true"/>:<Image size={18} aria-hidden="true"/>}{!compact&&(missing?'截图不可用':visible?'读取中…':'')}</span>}
  {!compact&&<span className="absolute bottom-1 left-1 rounded bg-slate-900/80 px-1.5 py-0.5 text-xs text-white">{label}</span>}
 </>
 return <span ref={box} className="relative block aspect-[4/3] w-full overflow-hidden rounded-base bg-slate-800">
  {onOpen?<button type="button" onClick={onOpen} aria-label={`查看${label}截图与详情`} className="absolute inset-0 h-full !min-h-11 w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{content}</button>:<span role="img" aria-label={`${label}截图`} className="absolute inset-0">{content}</span>}
 </span>
}
