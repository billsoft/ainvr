import {alarmZoneService,type AlarmZone} from '@/api/alarmZoneService'
import {alarmArmingService} from '@/api/alarmArmingService'
import type {ArmingCounterBindingDocument} from './armingDocument'
export interface ZoneOverlayState {zones:(AlarmZone&{edge_ids?:string[]})[];bindings:ArmingCounterBindingDocument[];loaded:boolean;failed:boolean}
type Listener=(state:ZoneOverlayState)=>void
const entries=new Map<string,{subscribe:(listener:Listener)=>()=>void}>()
/** One in-flight read and poll per source. Last viewer leaving tears down all state. */
export function subscribeZoneOverlay(sourceId:string,listener:Listener){
 let entry=entries.get(sourceId)
 if(!entry){
  const listeners=new Set<Listener>()
  let state:ZoneOverlayState={zones:[],bindings:[],loaded:false,failed:false},timer:ReturnType<typeof setTimeout>|undefined,closed=false,running=false,again=false
  const publish=()=>{for(const fn of listeners)fn(state)}
  const refresh=async()=>{
   if(closed)return
   if(running){again=true;return}
   clearTimeout(timer);running=true
   try{
    if(!document.hidden){
     const {arming}=await alarmArmingService.read(sourceId)
     const zones=arming?arming.zones:(await alarmZoneService.list(sourceId)).items
     if(!closed){state={zones,bindings:arming?.counter_bindings??[],loaded:true,failed:false};publish()}
    }
   }catch{if(!closed){state={...state,failed:true};publish()}}
   finally{running=false;if(!closed){if(again){again=false;void refresh()}else timer=setTimeout(()=>void refresh(),15000)}}
  }
  const saved=()=>{void refresh()}
  entry={subscribe(fn){listeners.add(fn);fn(state)
   if(listeners.size===1){window.addEventListener('ainvr-arming-saved',saved);void refresh()}
   return()=>{listeners.delete(fn);if(!listeners.size){closed=true;clearTimeout(timer);window.removeEventListener('ainvr-arming-saved',saved);entries.delete(sourceId)}}
  }}
  entries.set(sourceId,entry)
 }
 return entry.subscribe(listener)
}
