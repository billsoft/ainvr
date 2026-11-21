import {request} from './httpClient'
import type {ZonePoint} from '@/features/alarmGeometry'

export interface ArmingScene {
 zone_id:string;processor_id:string;revision:number;reference_points:ZonePoint[];
 current_points:ZonePoint[]|null;state:'pending'|'matched'|'unmatched';reference_frame_id:string;reason?:string
 binding_mode?:'preset'|'experimental_projection';preset_id?:string|null;preset_name?:string|null;preset_fingerprint?:string|null
}
export interface PresetArmingSelection {binding_mode:'preset';preset_id:string;preset_fingerprint:string}
export interface ArmingScenes {eligible:boolean;identity:string|null;epoch:string;items:ArmingScene[];presetBindingAvailable?:boolean;presetBindingReason?:string;experimentalProjectionEnabled?:boolean}
export interface ArmingSceneFrame {
 frame_id:string;image_url:string;width:number;height:number;captured_at:string;
 geometry_revision:string;identity:string;epoch:string;items:ArmingScene[]
 binding_mode?:'preset'|'experimental_projection'|'current';preset_id?:string|null;preset_name?:string|null;preset_fingerprint?:string|null
}
export interface ArmingSceneEdit {
 zone_id:string;expected_revision:number;mode:'bind'|'edit'|'unbind';frame_id:string
 binding_mode?:'preset'
}
const path=(source:string)=>`/alarms/arming/${encodeURIComponent(source)}/scenes`
export const armingSceneService={
 image:async(url:string)=>{
  const target=new URL(url,window.location.origin)
  if(target.origin!==window.location.origin||!target.pathname.startsWith('/api/'))throw Error('冻结参考图片地址不可信')
  const token=localStorage.getItem('srs-console-token')
  const response=await fetch(target.href,{headers:token?{'X-Console-Token':token}:{},cache:'no-store',signal:AbortSignal.timeout(15000)})
  if(!response.ok)throw Error('冻结参考图片读取失败，请重试')
  const blob=await response.blob()
  if(!['image/jpeg','image/png','image/webp'].includes(blob.type)||blob.size>8*1024*1024||!blob.size)throw Error('冻结参考图片格式无效')
  return blob
 },
 read:(source:string,processor?:string)=>request<ArmingScenes>(path(source)+(processor?`?processor_id=${encodeURIComponent(processor)}`:''),
  {cache:'no-store',signal:AbortSignal.timeout(8000)}),
 freeze:(source:string,processor:string,selection?:PresetArmingSelection)=>request<ArmingSceneFrame>(path(source)+'/frame',{
  method:'POST',body:JSON.stringify({processor_id:processor,...selection}),signal:AbortSignal.timeout(45000)}),
}
export function sceneStateLabel(state:ArmingScene['state'],mode?:ArmingScene['binding_mode']) {
 if(mode==='preset')return state==='matched'?'布防视角已核验':state==='pending'?'正在核验布防视角':'布防视角未确认'
 if(mode==='experimental_projection')return '试验区域已暂停'
 return state==='matched'?'场景已匹配':state==='pending'?'等待场景核验':'场景未匹配'
}
