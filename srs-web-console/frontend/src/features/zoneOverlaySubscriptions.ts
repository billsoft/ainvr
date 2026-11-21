import {alarmZoneService,type AlarmZone} from '@/api/alarmZoneService'
import {alarmArmingService} from '@/api/alarmArmingService'
import {armingSceneService,type ArmingScene} from '@/api/armingSceneService'
import {validScenePoints} from './armingSceneDraft'
import type {ArmingCounterBindingDocument} from './armingDocument'
export interface ZoneOverlayState {zones:(AlarmZone&{edge_ids?:string[]})[];bindings:ArmingCounterBindingDocument[];loaded:boolean;failed:boolean}
type Listener=(state:ZoneOverlayState)=>void
/** Display-only projection. The arming document remains canonical for CAS saves. */
export function projectOverlayZones(zones:ZoneOverlayState['zones'],scenes:ArmingScene[],processorId?:string){
 return zones.flatMap(zone=>{
  const rows=scenes.filter(s=>s.zone_id===zone.zone_id&&(!processorId||s.processor_id===processorId))
  if(!rows.length)return [zone]
  // An unscoped viewer cannot choose between multiple processor bindings.
  const scene=rows[0]!
  if(rows.length!==1||scene.state!=='matched'||JSON.stringify(scene.reference_points)!==JSON.stringify(zone.points)||!validScenePoints(scene.current_points,zone.points.length))return []
  return [{...zone,points:scene.current_points.map(p=>[...p] as [number,number])}]
 })
}
const entries=new Map<string,{subscribe:(listener:Listener)=>()=>void}>()
/** One in-flight read and poll per source. Last viewer leaving tears down all state. */
export function subscribeZoneOverlay(sourceId:string,listener:Listener,processorId?:string){
 const cacheKey=JSON.stringify([sourceId,processorId])
 let entry=entries.get(cacheKey)
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
     const [{arming},scenes]=await Promise.all([alarmArmingService.read(sourceId,processorId),armingSceneService.read(sourceId,processorId)])
     if(!scenes||!Array.isArray(scenes.items))throw Error('invalid scene status')
     const zones=arming?arming.zones:processorId?[]:(await alarmZoneService.list(sourceId)).items
     const projected=projectOverlayZones(zones,scenes.items,processorId)
     const visible=new Set(projected.map(z=>z.zone_id))
     if(!closed){state={zones:projected,bindings:(arming?.counter_bindings??[]).filter(b=>visible.has(b.zone_id)),loaded:true,failed:false};publish()}
    }
   }catch{if(!closed){state={...state,zones:[],bindings:[],failed:true};publish()}}
   finally{running=false;if(!closed){if(again){again=false;void refresh()}else timer=setTimeout(()=>void refresh(),5000)}}
  }
  const saved=()=>{void refresh()}
  const visibility=()=>{state={...state,zones:[],bindings:[],loaded:false};publish();if(!document.hidden)void refresh()}
  entry={subscribe(fn){listeners.add(fn);fn(state)
   if(listeners.size===1){window.addEventListener('ainvr-arming-saved',saved);document.addEventListener('visibilitychange',visibility);void refresh()}
   return()=>{listeners.delete(fn);if(!listeners.size){closed=true;clearTimeout(timer);window.removeEventListener('ainvr-arming-saved',saved);document.removeEventListener('visibilitychange',visibility);entries.delete(cacheKey)}}
  }}
  entries.set(cacheKey,entry)
 }
 return entry.subscribe(listener)
}
