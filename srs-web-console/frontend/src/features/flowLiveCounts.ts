import {flowService,startOfToday,type LiveCount} from '@/api/flowService'
export interface CountStatus {stale:boolean;updatedAt:number|null}
type Listener=(items:LiveCount[],status:CountStatus)=>void
const entries=new Map<string,{subscribe:(fn:Listener)=>()=>void}>()
/** One bounded, non-overlapping live query per source, shared by all players. */
export function subscribeLiveCounts(sourceId:string,listener:Listener,intervalMs=2000){
 let entry=entries.get(sourceId)
 if(!entry){
  const listeners=new Set<Listener>()
  let items:LiveCount[]=[],status:CountStatus={stale:true,updatedAt:null},timer:ReturnType<typeof setTimeout>|undefined,closed=false,running=false
  const publish=()=>{if(!closed)for(const fn of listeners)fn(items,status)}
  const refresh=async()=>{
   if(closed||running)return
   clearTimeout(timer);running=true
   try{if(!document.hidden){items=(await flowService.live(sourceId,startOfToday().toISOString())).items;status={stale:false,updatedAt:Date.now()};publish()}}
   catch{status={...status,stale:true};publish()}
   finally{running=false;if(!closed)timer=setTimeout(()=>void refresh(),intervalMs)}
  }
  const saved=()=>void refresh()
  const visible=()=>{if(!document.hidden){status={...status,stale:true};publish();void refresh()}}
  entry={subscribe(fn){listeners.add(fn);fn(items,status)
   if(listeners.size===1){window.addEventListener('ainvr-arming-saved',saved);document.addEventListener('visibilitychange',visible);void refresh()}
   return()=>{listeners.delete(fn);if(!listeners.size){closed=true;clearTimeout(timer);window.removeEventListener('ainvr-arming-saved',saved);document.removeEventListener('visibilitychange',visible);entries.delete(sourceId)}}
  }}
  entries.set(sourceId,entry)
 }
 return entry.subscribe(listener)
}
