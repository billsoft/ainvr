import {useEffect,useState} from 'react'
import {request} from '@/api/httpClient'
import {toast} from '@/store/toast'

type Settings={enabled:boolean;serverId:string;realm:string;sipPort:number;advertiseIp:string}
const unreachable=(ip:string)=>!ip||ip.startsWith('127.')||ip==='0.0.0.0'
const copyButton='min-h-11 rounded-base border border-line px-3 text-sm hover:border-primary'

/** What the person standing at the camera must type into its platform page.
 *  Gateway-wide values are changed in system configuration; this card only shows them. */
export function GBPlatformCard({collapsed=false}:{collapsed?:boolean}){
 const [settings,setSettings]=useState<Settings|null>(null),[failed,setFailed]=useState(false)
 useEffect(()=>{let cancelled=false;request<{settings:Settings}>('/gb28181/settings').then(d=>{if(!cancelled)setSettings(d.settings)}).catch(()=>{if(!cancelled)setFailed(true)});return()=>{cancelled=true}},[])
 const copy=(label:string,value:string)=>{
  const write=navigator.clipboard?.writeText(value)
  if(write)write.then(()=>toast.success(`已复制${label}`),()=>toast.error('复制失败，请手动选择文字复制'))
  else toast.error('当前浏览器不允许复制，请手动选择文字复制')
 }
 if(failed)return <p role="alert" className="rounded-base bg-danger/5 p-3 text-sm text-danger">无法读取国标平台参数，请到 <a className="text-primary underline" href="/config-center?category=gb28181" target="_blank" rel="noopener noreferrer">系统配置 · 国标接入</a> 核对。</p>
 if(!settings)return null
 if(!settings.enabled)return <div role="alert" aria-label="国标网关未启用" className="rounded-base border border-warning/40 bg-warning/5 p-3 text-sm text-warning-700">
  国标网关尚未启用，摄像头无法注册。请先到 <a className="text-primary underline" href="/config-center?category=gb28181" target="_blank" rel="noopener noreferrer">系统配置 · 国标接入</a> 启用并填写摄像头可访问的地址，再回到这里登记设备。</div>
 const rows:[string,string][]=[['平台编号',settings.serverId],['域',settings.realm],['平台地址',settings.advertiseIp],['信令端口',String(settings.sipPort)]]
 return <>
  {unreachable(settings.advertiseIp)&&<div role="alert" aria-label="摄像头无法访问平台地址" className="rounded-base border border-warning/40 bg-warning/5 p-3 text-sm text-warning-700">
   当前平台地址为 {settings.advertiseIp||'空'}，摄像头无法访问。请到 <a className="text-primary underline" href="/config-center?category=gb28181" target="_blank" rel="noopener noreferrer">系统配置 · 国标接入</a> 改为本机局域网地址。</div>}
  <details open={!collapsed} className="rounded-base border border-line bg-surface-page p-3">
   <summary className="min-h-9 cursor-pointer text-sm font-medium">摄像头端填写的平台参数</summary>
  <section aria-label="摄像头端填写的平台参数">
   <p className="mt-1 text-xs text-ink-subtle">在摄像头的“平台接入 / 国标”页面填写以下内容；设备编号和注册密码在下方登记后一并填入。全局参数在系统配置中统一修改。</p>
   <dl className="mt-2 divide-y divide-line">{rows.map(([label,value])=><div key={label} className="flex min-h-11 items-center justify-between gap-2 py-1 text-sm">
    <dt className="text-ink-subtle">{label}</dt><dd className="flex items-center gap-2"><span className="font-mono">{value}</span>
     <button type="button" className={copyButton} aria-label={`复制${label}`} onClick={()=>copy(label,value)}>复制</button></dd></div>)}</dl>
  </section>
  </details>
 </>
}
