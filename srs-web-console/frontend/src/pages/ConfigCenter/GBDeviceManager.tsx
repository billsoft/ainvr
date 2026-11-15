import {useCallback,useEffect,useState} from 'react'
import {request} from '@/api/httpClient'

type Device={id:string;name:string;version:string;enabled:boolean;mediaIPs?:string[];channels?:number}
type DeviceRuntime={id:string;registered:boolean;lastSeen?:string;address?:string;lastError?:string;version?:{profile:string}}
type Runtime={state?:string;devices?:DeviceRuntime[];unknownDevices?:{id:string;address:string;lastAttempt:string}[]}
type Draft={id:string;name:string;password:string;version:string}

const button='min-h-11 rounded-base border border-line px-3 text-sm hover:border-primary disabled:opacity-50'
const field='mt-1 block min-h-11 w-full rounded-base border border-line bg-surface px-3 text-sm'
const faults:Record<string,string>={
 authentication_failed:'注册密码不正确，请核对设备端填写的密码',
 registration_conflict:'同一编号从另一地址注册，请核对设备身份',
 device_reported_error:'设备已注册，但报告自身故障',
 device_query_failed:'设备未能完成信息查询',
 catalog_capacity_exceeded:'设备目录超出接入服务上限',
}
const host=(address?:string)=>address?address.replace(/:\d+$/,''):''
const when=(value?:string)=>{
 if(!value)return '—'
 const d=new Date(value)
 return Number.isNaN(d.getTime())||d.getFullYear()<2000?'—':d.toLocaleString('zh-CN',{hour12:false})
}

/** Every registered GB camera or NVR at a glance: whether it is online, where it
 *  registers from, how many channels it feeds; plus attempts from unregistered
 *  device numbers, which on site are almost always a mistyped number. */
export function GBDeviceManager(){
 const [devices,setDevices]=useState<Device[]>([]),[revision,setRevision]=useState(0),[loaded,setLoaded]=useState(false)
 const [runtime,setRuntime]=useState<Runtime>({})
 const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
 const [draft,setDraft]=useState<Draft|null>(null),[removing,setRemoving]=useState('')
 const load=useCallback(async()=>{
  const data=await request<{items:Device[];revision:number}>('/gb28181/devices')
  setDevices(data.items);setRevision(data.revision);setLoaded(true)
 },[])
 useEffect(()=>{load().catch(e=>setError((e as Error).message))},[load])
 useEffect(()=>{let stopped=false,first=true,timer:ReturnType<typeof setTimeout>;const poll=async()=>{
  // Always read once on open; afterwards skip polling while the page is in the background.
  try{if(first||!document.hidden){first=false;const s=await request<Runtime>('/gb28181/status');if(!stopped)setRuntime(s)}}catch{/* status is advisory */}
  if(!stopped)timer=setTimeout(poll,5000)
 };void poll();return()=>{stopped=true;clearTimeout(timer)}},[])
 const run=async(work:()=>Promise<unknown>,done:string)=>{
  setBusy(true);setError('');setMessage('')
  try{await work();setMessage(done);setDraft(null);setRemoving('')}catch(e){setError((e as Error).message)}
  finally{await load().catch(()=>{});setBusy(false)}
 }
 const save=(device:Omit<Device,'channels'>&{password?:string})=>request('/gb28181/devices',{method:'POST',body:JSON.stringify({expectedRevision:revision,device})})
 const toggle=(d:Device)=>run(()=>save({id:d.id,name:d.name,version:d.version,enabled:!d.enabled,mediaIPs:d.mediaIPs??[]}),d.enabled?`已停用“${d.name}”，该设备的视频通道将等待视频源。`:`已启用“${d.name}”，等待设备重新注册。`)
 const remove=(d:Device)=>run(()=>request(`/gb28181/devices/${d.id}`,{method:'DELETE',body:JSON.stringify({expectedRevision:revision})}),`已删除“${d.name}”。`)
 const register=()=>{
  if(!draft)return
  if(!draft.name.trim()||!/^\d{20}$/.test(draft.id)||draft.password.length<8){setError('请填写设备名称、20 位国标编号及至少 8 位注册密码');return}
  void run(()=>save({id:draft.id,name:draft.name.trim(),version:draft.version,enabled:true,mediaIPs:[],password:draft.password}),'设备已登记。请在设备端填写平台信息和同一密码，注册成功后到接入管理添加视频通道。')
 }
 const state=(d:Device)=>{
  const r=runtime.devices?.find(v=>v.id===d.id)
  if(!d.enabled)return {text:'已停用',tone:'text-ink-subtle'}
  if(runtime.state==='disabled')return {text:'国标服务已停用',tone:'text-ink-subtle'}
  if(r?.registered)return {text:r.lastError?`在线 · ${faults[r.lastError]??'状态异常'}`:'在线',tone:r.lastError?'text-warning-700':'text-success'}
  if(r?.lastError&&faults[r.lastError])return {text:faults[r.lastError]!,tone:'text-danger'}
  return {text:'等待注册',tone:'text-warning-700'}
 }
 const unknown=(runtime.unknownDevices??[]).filter(u=>!devices.some(d=>d.id===u.id))
 return <section className="ui-panel mt-4 p-5" aria-label="国标设备">
  <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">国标设备</h2>
   <button type="button" className={button} disabled={busy} onClick={()=>{setError('');setDraft({id:'',name:'',password:'',version:'auto'})}}>登记新设备</button></div>
  <p className="mt-2 text-sm text-ink-subtle">一台摄像头或 NVR 登记一次；NVR 的多个视频通道共用同一注册身份。登记后到接入管理选择视频通道。</p>
  {error&&<p role="alert" className="mt-3 rounded-base bg-danger/5 p-3 text-sm text-danger">{error}</p>}
  {message&&<p role="status" className="mt-3 text-sm text-primary">{message}</p>}
  {unknown.length>0&&<div className="mt-3 rounded-base bg-warning/5 p-3 text-sm" role="status">
   <p className="font-medium text-warning-700">收到未登记编号的注册请求，通常是设备端编号填错或尚未登记：</p>
   <ul className="mt-2 space-y-2">{unknown.map(u=><li key={u.id} className="flex flex-wrap items-center justify-between gap-2">
    <span>{u.id} · 来自 {host(u.address)} · {when(u.lastAttempt)}</span>
    <button type="button" className={button} disabled={busy} onClick={()=>{setError('');setDraft({id:u.id,name:'',password:'',version:'auto'})}}>登记此编号</button></li>)}</ul></div>}
  {draft&&<section aria-label="登记国标设备" className="mt-3 space-y-3 rounded-base border border-line bg-surface-page p-3">
   <div className="grid gap-3 sm:grid-cols-2">
    <label className="text-sm">设备名称<input className={field} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
    <label className="text-sm">设备国标编号（20 位）<input className={field} inputMode="numeric" value={draft.id} onChange={e=>setDraft({...draft,id:e.target.value.trim()})}/></label>
    <label className="text-sm">注册密码<input className={field} type="password" autoComplete="new-password" value={draft.password} onChange={e=>setDraft({...draft,password:e.target.value})}/></label>
    <label className="text-sm">协议版本<select className={field} value={draft.version} onChange={e=>setDraft({...draft,version:e.target.value})}><option value="auto">自动（未确认时兼容 2016）</option><option value="2016">2016</option><option value="2022">2022</option></select></label>
   </div>
   <div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={()=>setDraft(null)}>取消</button>
    <button type="button" className="min-h-11 rounded-base bg-primary px-4 text-sm text-white disabled:opacity-50" disabled={busy} onClick={register}>保存设备</button></div>
  </section>}
  {loaded&&!devices.length&&<p className="mt-3 text-sm text-ink-subtle">尚未登记国标设备。</p>}
  <ul className="mt-3 divide-y divide-line">{devices.map(d=>{
   const r=runtime.devices?.find(v=>v.id===d.id),s=state(d)
   return <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
    <div className="min-w-0"><p className="font-medium">{d.name} <span className="text-ink-subtle">· {d.id}</span></p>
     <p className={s.tone}>{s.text}</p>
     <p className="text-xs text-ink-subtle">地址 {host(r?.address)||'—'} · 最近心跳 {r?.registered?when(r.lastSeen):'—'} · 协议 {r?.registered&&r.version?.profile?r.version.profile:d.version==='auto'?'自动':d.version} · 已接入 {d.channels??0} 路</p></div>
    <div className="flex flex-wrap gap-2">
     <button type="button" className={button} disabled={busy} onClick={()=>void toggle(d)}>{d.enabled?'停用':'启用'}</button>
     {removing===d.id?<><button type="button" className="min-h-11 rounded-base bg-danger px-3 text-sm text-white disabled:opacity-50" disabled={busy} onClick={()=>void remove(d)}>确认删除</button><button type="button" className={button} disabled={busy} onClick={()=>setRemoving('')}>不删除</button></>
      :<button type="button" className={button} disabled={busy} onClick={()=>{setError('');setRemoving(d.id)}}>删除</button>}
    </div></li>})}</ul>
  {devices.some(d=>removing===d.id&&(d.channels??0)>0)&&<p className="text-sm text-warning-700">该设备仍有视频通道在用，需先在通道列表删除这些通道；若只是暂时不用，请选择停用。</p>}
 </section>
}
