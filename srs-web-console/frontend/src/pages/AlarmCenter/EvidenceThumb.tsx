import {useEffect,useRef,useState} from 'react'
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
 const [url,setUrl]=useState<string|null>(null),[missing,setMissing]=useState(false),[visible,setVisible]=useState(typeof IntersectionObserver==='undefined')
 const box=useRef<HTMLButtonElement>(null)
 useEffect(()=>{
  if(visible||!box.current)return
  const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setVisible(true);observer.disconnect()}},{rootMargin:'200px'})
  observer.observe(box.current);return()=>observer.disconnect()
 },[visible])
 useEffect(()=>{
  if(!visible)return
  let active=true,objectUrl:string|null=null,release:(()=>void)|null=null;setUrl(null);setMissing(false)
  void slot().then(free=>{release=free;if(!active){free();return}
   return request<{state:string}>(`/alarms/behavior-events/${encodeURIComponent(eventId)}/evidence`,{signal:AbortSignal.timeout(20000)})
    .then(v=>v.state==='available'?requestBlob(`/alarms/behavior-events/${encodeURIComponent(eventId)}/evidence/image?variant=processed`,AbortSignal.timeout(20000)):null)
    .then(blob=>{if(!active)return;if(!blob){setMissing(true);return}objectUrl=URL.createObjectURL(blob);setUrl(objectUrl)})
    .catch(()=>{if(active)setMissing(true)})
    .finally(free)})
  return()=>{active=false;release?.();if(objectUrl)URL.revokeObjectURL(objectUrl)}
 },[eventId,visible])
 return <button ref={box} type="button" onClick={onOpen} aria-label={`放大查看${label}截图`} className="relative aspect-[4/3] w-full overflow-hidden rounded-card bg-slate-800">
  {url?<img src={url} alt="" className="h-full w-full object-cover"/>:!compact&&<span className="flex h-full items-center justify-center text-xs text-slate-300">{missing?'截图不可用':visible?'读取中…':''}</span>}
  {!compact&&<span className="absolute bottom-1.5 left-1.5 rounded bg-slate-900/80 px-2 py-0.5 text-xs text-white">{label}</span>}
 </button>
}
