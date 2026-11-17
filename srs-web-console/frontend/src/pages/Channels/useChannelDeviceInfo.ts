import {useEffect,useState} from 'react'
import {request} from '@/api/httpClient'
import {onvifService} from '@/api/onvifService'
import type {ChannelWithStatus} from '@/types/channel'
import type {GBBinding} from './gbTypes'

export type DeviceLine={text:string;tone:'ok'|'warn'|'danger'|'muted'}
const faults:Record<string,string>={
 authentication_failed:'注册密码不正确',
 registration_conflict:'同一编号从另一地址注册',
 device_reported_error:'设备报告自身故障',
 device_query_failed:'设备信息查询失败',
 catalog_capacity_exceeded:'设备目录超出上限',
}
type GBDevice={id:string;name:string;enabled:boolean}
type GBRuntime={state?:string;devices?:{id:string;registered:boolean;lastError?:string}[]}

/** One line under a channel's name saying which camera feeds it and, when it is not streaming, why. */
export function gbDeviceLine(device:GBDevice|undefined,deviceId:string,runtime:GBRuntime):DeviceLine{
 const name=device?.name||deviceId,r=runtime.devices?.find(d=>d.id===deviceId)
 if(device&&!device.enabled)return {text:`设备 ${name} · 已停用`,tone:'muted'}
 if(runtime.state==='disabled')return {text:`设备 ${name} · 国标服务已停用`,tone:'muted'}
 if(r?.registered)return r.lastError?{text:`设备 ${name} · 在线 · ${faults[r.lastError]??'状态异常'}`,tone:'warn'}:{text:`设备 ${name} · 在线`,tone:'ok'}
 if(r?.lastError&&faults[r.lastError])return {text:`设备 ${name} · ${faults[r.lastError]}`,tone:'danger'}
 return {text:`设备 ${name} · 等待注册`,tone:'warn'}
}

/** Device context for the access table. A GB device's state changes, so it is read on open and
 *  refreshed while the page is visible; an ONVIF device's name does not, so it is read once. */
export function useChannelDeviceInfo(channels:ChannelWithStatus[],bindings:GBBinding[],refresh:number){
 const [gbInfo,setGbInfo]=useState<Record<string,DeviceLine>>({})
 const [onvifInfo,setOnvifInfo]=useState<Record<string,DeviceLine>>({})
 const hasGB=bindings.length>0
 const onvifChannels=channels.filter(c=>c.onvif)
 const gbKey=JSON.stringify(bindings.map(b=>[b.input_id,b.device_id]))
 const onvifKey=JSON.stringify(onvifChannels.map(c=>[c.id,c.onvif!.deviceId]))
 useEffect(()=>{
  if(!hasGB){setGbInfo({});return}
  let cancelled=false,first=true,timer:ReturnType<typeof setTimeout>
  const poll=async()=>{
   if(first||!document.hidden){first=false
    try{
     const [devices,runtime]=await Promise.all([request<{items:GBDevice[]}>('/gb28181/devices'),request<GBRuntime>('/gb28181/status')])
     const next:Record<string,DeviceLine>={}
     for(const b of bindings)next[b.input_id]=gbDeviceLine(devices.items.find(d=>d.id===b.device_id),b.device_id,runtime)
     if(!cancelled)setGbInfo(next)
    }catch{/* The table works without device context. */}
   }
   if(!cancelled)timer=setTimeout(poll,5000)
  }
  void poll()
  return()=>{cancelled=true;clearTimeout(timer)}
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[gbKey,hasGB,refresh])
 useEffect(()=>{
  if(!onvifChannels.length){setOnvifInfo({});return}
  let cancelled=false
  onvifService.devices().then(({items})=>{
   const next:Record<string,DeviceLine>={}
   for(const c of onvifChannels){const d=items.find(x=>x.id===c.onvif!.deviceId)
    next[c.id]=d?.lastError?{text:`设备 ${d.name} · 最近连接失败`,tone:'warn'}:{text:`设备 ${d?.name??c.onvif!.deviceId}`,tone:'muted'}}
   if(!cancelled)setOnvifInfo(next)
  }).catch(()=>{/* The table works without device context. */})
  return()=>{cancelled=true}
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[onvifKey,refresh])
 return {...onvifInfo,...gbInfo}
}
