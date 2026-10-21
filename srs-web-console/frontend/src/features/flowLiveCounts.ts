import {flowService,startOfToday,type LiveCount} from '@/api/flowService'
type Listener=(items:LiveCount[])=>void
const entries=new Map<string,{subscribe:(fn:Listener)=>()=>void}>()
/** One poll per source while any player shows it; today's totals only. */
export function subscribeLiveCounts(sourceId:string,listener:Listener,intervalMs=10000){
 let entry=entries.get(sourceId)
 if(!entry){
  const listeners=new Set<Listener>()
  let items:LiveCount[]=[],timer:ReturnType<typeof setTimeout>|undefined,closed=false
  const refresh=async()=>{
   if(closed)return
   try{if(!document.hidden){items=(await flowService.live(sourceId,startOfToday().toISOString())).items;if(!closed)for(const fn of listeners)fn(items)}}
   catch{/* keep the last known numbers; the line is still drawn from the arming */}
   finally{if(!closed)timer=setTimeout(()=>void refresh(),intervalMs)}
  }
  const saved=()=>{clearTimeout(timer);void refresh()}
  entry={subscribe(fn){listeners.add(fn);fn(items)
   if(listeners.size===1){window.addEventListener('ainvr-arming-saved',saved);void refresh()}
   return()=>{listeners.delete(fn);if(!listeners.size){closed=true;clearTimeout(timer);window.removeEventListener('ainvr-arming-saved',saved);entries.delete(sourceId)}}
  }}
  entries.set(sourceId,entry)
 }
 return entry.subscribe(listener)
}
