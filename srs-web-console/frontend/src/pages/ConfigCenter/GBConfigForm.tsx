import {useEffect,useState} from 'react'
import {PtzGlobalSettings} from './PtzGlobalSettings'
import {request} from '@/api/httpClient'

type Settings={enabled:boolean;gatewayUrl:string;serverId:string;realm:string;listenIp:string;sipPort:number;advertiseIp:string;mediaAdvertiseIp:string;mediaPortStart:number;mediaPortEnd:number;capacity:number;heartbeatTimeoutSec:number}
export function GBConfigForm(){
 const [data,setData]=useState<{revision:number;settings:Settings;tokenSet:boolean}|null>(null)
 const [token,setToken]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
 const [status,setStatus]=useState<{state?:string;revision?:number}>({})
 const [dirty,setDirty]=useState(false)
 useEffect(()=>{const leave=(e:BeforeUnloadEvent)=>{if(dirty){e.preventDefault();e.returnValue=''}};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave)},[dirty])
 useEffect(()=>{let stopped=false;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const s=await request<typeof status>('/gb28181/status');if(!stopped)setStatus(s)}catch{if(!stopped)setStatus({state:'unavailable'})}if(!stopped)timer=setTimeout(poll,5000)};void poll();return()=>{stopped=true;clearTimeout(timer)}},[])
 useEffect(()=>{request<typeof data>('/gb28181/settings').then(setData).catch(e=>setError(e.message))},[])
 const save=async()=>{if(!data)return;setBusy(true);setError('');try{
   const result=await request<{revision:number}>('/gb28181/settings',{method:'PUT',body:JSON.stringify({settings:data.settings,expectedRevision:data.revision,...(token?{token}:{})})})
   setData({...data,revision:result.revision,tokenSet:data.tokenSet||!!token});setToken('');setDirty(false);setMessage('已保存，等待国标网关应用。监听参数变更会重建国标连接。')
 }catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const fields:[keyof Settings,string,boolean?][]=[['gatewayUrl','网关管理地址'],['serverId','平台 SIP 标识'],['realm','SIP 域'],['listenIp','信令监听地址'],['sipPort','信令端口',true],['advertiseIp','摄像头可访问的信令地址'],['mediaAdvertiseIp','摄像头可访问的媒体地址'],['mediaPortStart','媒体起始端口',true],['mediaPortEnd','媒体结束端口',true],['capacity','同时收流上限',true],['heartbeatTimeoutSec','心跳离线判定（秒）',true]]
 return <><section className="ui-panel p-5" data-unsaved={dirty} onChange={()=>setDirty(true)}><h2 className="text-lg font-semibold">国标摄像头接入</h2>
  <p className="mt-2 text-sm text-ink-subtle">配置平台连接后，在接入管理中添加摄像头或 NVR，再选择目录中的视频通道。现有 RTSP、RTMP 通道不受影响。</p>
  <p className="mt-3 text-sm" role="status">网关状态：{({running:'信令服务已就绪',disabled:'已停用',applying:'等待应用',failed:'应用失败',unavailable:'服务未连接',waiting_configuration:'等待配置'} as Record<string,string>)[status.state??'']??'正在检查'}{status.revision?` · 已接收版本 ${status.revision}`:''}</p>
  {error&&<p role="alert" className="mt-3 text-danger">{error}</p>}{message&&<p role="status" className="mt-3 text-ink-subtle">{message}</p>}
  {data&&<fieldset disabled={busy} className="mt-4 space-y-4"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={data.settings.enabled} onChange={e=>setData({...data,settings:{...data.settings,enabled:e.target.checked}})}/>启用国标网关</label>
   <div className="grid gap-4 md:grid-cols-2">{fields.map(([key,label,numeric])=><label key={key} className="text-sm">{label}<input className="mt-1 block min-h-11 w-full rounded border border-line px-3" type={numeric?'number':'text'} value={String(data.settings[key])} onChange={e=>setData({...data,settings:{...data.settings,[key]:numeric?Number(e.target.value):e.target.value}})}/></label>)}
   <label className="text-sm">网关服务密钥<input className="mt-1 block min-h-11 w-full rounded border border-line px-3" type="password" autoComplete="new-password" placeholder={data.tokenSet?'已设置，留空保持':'填写部署时生成的服务密钥'} value={token} onChange={e=>setToken(e.target.value)}/></label></div>
   <p className="text-sm text-ink-subtle">服务密钥用于连接独立网关；修改时须与网关部署凭据一致。启用前填写摄像头实际可访问的地址，不能使用 127.0.0.1。</p>
   <details className="rounded-base border border-line p-3 text-sm text-ink-subtle"><summary className="min-h-11 cursor-pointer font-medium text-ink">外置网关部署说明</summary>
    <p className="mt-2">默认网关运行在本机，无需额外转发。使用其他主机上的网关时，请先由管理员配置受信任的 HTTPS 管理连接，以及返回本机流媒体服务的安全转发；只修改管理地址不能完成外置接入。</p>
    <p className="mt-2">信令和媒体地址应填写外置网关上摄像头可达的地址。设备账号仍在新建通道向导中配置，不在此处填写。</p>
   </details>
   <p className="text-sm text-ink-subtle">仅用于 2016／2022 摄像头实时接入。真机兼容性及持续运行验证尚未完成。</p>
   <button className="min-h-11 rounded-base bg-primary px-4 text-white hover:bg-primary-600" onClick={()=>void save()}>{busy?'保存中…':'保存国标配置'}</button>
  </fieldset>}
 </section><PtzGlobalSettings/></>
}
