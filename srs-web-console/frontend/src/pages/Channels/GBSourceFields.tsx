import {useEffect,useState} from 'react'
import {request} from '@/api/httpClient'
import type {GBBinding} from './gbTypes'

type Device={id:string;name:string;version:string;enabled:boolean;mediaIPs?:string[]}
type Item={id:string;document:{name?:string};available:boolean;input_id?:string;enabled?:boolean;transport?:string}
type Options={revision:number;devices:Device[];items:Item[]}
export type GBSourceDraft={revision:number;deviceId:string;channelId:string;transport:string;enabled:boolean;ready:boolean;registrationDirty:boolean;batch:boolean;channels:{id:string;name:string}[]}
const field='mt-1 block min-h-11 w-full rounded-base border border-line bg-surface px-3 text-sm'
const button='min-h-11 rounded-base border border-line px-3 text-sm hover:border-primary'
const emptyDevice={id:'',name:'',version:'auto',enabled:true,password:'',mediaIPs:''}

/** Device registration is a prerequisite; video binding is only saved by the wizard. */
export function GBSourceFields({binding,onDraft,onDirty,onBusy}:{binding?:GBBinding;onDraft:(draft:GBSourceDraft)=>void;onDirty:(dirty:boolean)=>void;onBusy:(busy:boolean)=>void}){
 const [editRevision,setEditRevision]=useState(binding?.revision)
 const [batch,setBatch]=useState(false),[selectedChannels,setSelectedChannels]=useState<string[]>([])
 const [selected,setSelected]=useState(binding?.device_id??'')
 const [options,setOptions]=useState<Options>({revision:0,devices:[],items:[]})
 const [channel,setChannel]=useState(binding?.channel_id??'')
 const [transport,setTransport]=useState('tcp-passive'),[enabled,setEnabled]=useState(true)
 const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('')
 const [refresh,setRefresh]=useState(0),[dirty,setDirty]=useState(false),[query,setQuery]=useState('')
 const [form,setForm]=useState<'new'|'edit'|null>(null),[device,setDevice]=useState({...emptyDevice}),[deviceDirty,setDeviceDirty]=useState(false)
 const [runtime,setRuntime]=useState<{state?:string;devices?:{id:string;registered:boolean;version?:{profile:string;confirmed:boolean;peer?:string}}[]}>({})
 useEffect(()=>{onDraft({revision:editRevision===undefined?options.revision:Number(editRevision),deviceId:selected,channelId:channel,transport,enabled,ready,registrationDirty:deviceDirty,batch,channels:selectedChannels.map(id=>({id,name:options.items.find(i=>i.id===id)?.document.name||id}))})},[editRevision,options.revision,selected,channel,transport,enabled,ready,deviceDirty,batch,selectedChannels,options.items,onDraft])
 useEffect(()=>{onDirty(dirty||deviceDirty)},[dirty,deviceDirty,onDirty])
 useEffect(()=>{
  let cancelled=false;setReady(false);setError('')
  request<Options>('/gb28181/channel-options'+(selected?'?deviceId='+selected:'')).then(data=>{
   if(cancelled)return;setOptions(data);setReady(true)
   const existing=binding&&data.items.find(i=>i.id===binding.channel_id)
   setTransport(existing?.transport??'tcp-passive');setEnabled(existing?.enabled??true);setChannel(binding?.channel_id??'');setSelectedChannels([]);setDirty(false)
  }).catch(e=>{if(!cancelled)setError(e.message)})
  return()=>{cancelled=true}
 },[selected,refresh,binding?.channel_id])
 // Poll observations only. Never advance the draft revision or overwrite form values.
 useEffect(()=>{let cancelled=false,timer:ReturnType<typeof setTimeout>;const poll=async()=>{
  try{if(!document.hidden){const status=await request<typeof runtime>('/gb28181/status');if(!cancelled)setRuntime(status)
   if(selected){const catalog=await request<{items:Item[]}>(`/gb28181/devices/${selected}/channels`);if(!cancelled)setOptions(old=>({...old,items:catalog.items}))}
  }}catch{/* The configuration remains editable when the runtime is unavailable. */}
  if(!cancelled)timer=setTimeout(poll,5000)
 };void poll();return()=>{cancelled=true;clearTimeout(timer)}},[selected])
 const closeDevice=()=>{if(busy)return;if(deviceDirty&&!window.confirm('放弃尚未保存的设备注册修改？'))return;setForm(null);setDeviceDirty(false)}
 const openDevice=(kind:'new'|'edit')=>{
  if(deviceDirty&&!window.confirm('放弃尚未保存的设备注册修改？'))return
  const existing=options.devices.find(d=>d.id===selected)
  setDevice(kind==='edit'&&existing?{...emptyDevice,...existing,password:'',mediaIPs:(existing.mediaIPs??[]).join(', ')}:{...emptyDevice})
  setDeviceDirty(false);setForm(kind)
 }
 const saveDevice=async()=>{
  if(!device.name.trim()||!/^\d{20}$/.test(device.id)||((form==='new'||device.password)&&device.password.length<8)){setError('请填写设备名称、20 位国标编号及至少 8 位注册密码');return}
  setBusy(true);onBusy(true);setError('')
  try{
   const {password,mediaIPs,...rest}=device
   const result=await request<{revision:number}>('/gb28181/devices',{method:'POST',body:JSON.stringify({expectedRevision:editRevision===undefined?options.revision:Number(editRevision),device:{...rest,mediaIPs:mediaIPs.split(/[,，\s]+/).filter(Boolean),...(password?{password}:{})}})})
   if(binding)setEditRevision(result.revision)
   setOptions(old=>({...old,revision:result.revision,devices:[...old.devices.filter(d=>d.id!==device.id),{...rest,mediaIPs:mediaIPs.split(/[,，\s]+/).filter(Boolean)}]}))
   setDevice({...emptyDevice});setForm(null);setDeviceDirty(false);setMessage('设备注册信息已保存。请在设备端配置平台信息，等待注册和目录；视频通道尚未保存。')
   if(selected!==device.id)setSelected(device.id)
  }catch(e){setError((e as Error).message)}finally{setBusy(false);onBusy(false)}
 }
 const chooseDevice=(id:string)=>{if((dirty||deviceDirty)&&!window.confirm('更换设备将放弃本页尚未保存的接入参数，继续？'))return;setForm(null);setDeviceDirty(false);setSelected(id);setQuery('')}
 return <div className="space-y-4">
  <p className="text-sm text-ink-subtle">此处配置当前摄像头／NVR。平台 SIP、信令和媒体端口在 <a className="text-primary" href="/config-center?category=gb28181" target="_blank" rel="noopener noreferrer">系统配置 · 国标接入</a> 统一设置。</p>
  {error&&<p role="alert" className="rounded-base bg-danger/5 p-3 text-sm text-danger">{error}</p>}
  {message&&<p role="status" className="text-sm text-primary">{message}</p>}
  {ready&&!options.devices.length&&<p className="rounded-base bg-primary-50 p-3 text-sm">尚未登记国标设备。请先登记摄像头／NVR，再在设备端填写平台信息；注册成功后即可选择视频目录。</p>}
  <fieldset disabled={busy} className="space-y-4">
   <label className="block text-sm font-medium">国标设备<select aria-label="国标设备" className={field} disabled={!!binding||!ready} value={selected} onChange={e=>chooseDevice(e.target.value)}><option value="">请选择设备</option>{options.devices.map(d=><option key={d.id} value={d.id}>{d.name} · {d.id}</option>)}</select></label>
   <div className="flex flex-wrap gap-2">{!binding&&<button type="button" className={button} disabled={!ready} onClick={()=>openDevice('new')}>登记新设备</button>}{selected&&<button type="button" className={button} onClick={()=>openDevice('edit')}>编辑设备注册信息</button>}<button type="button" className={button} onClick={()=>{if(binding){setError('为同时刷新名称、备注和接入参数，请关闭此向导后重新点击通道编辑。');return}if((dirty||deviceDirty)&&!window.confirm('重新读取将放弃本页接入参数草稿，继续？'))return;setForm(null);setDeviceDirty(false);setRefresh(n=>n+1)}}>重新读取配置</button></div>
   {form&&<section aria-label="设备注册信息" className="space-y-3 rounded-base border border-line bg-surface-page p-3" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();closeDevice()}}}>
    <div className="flex items-center justify-between"><h4 className="font-medium">{form==='new'?'登记新设备':'编辑设备注册信息'}</h4><button type="button" aria-label="关闭设备注册信息" className="min-h-11 min-w-11" onClick={closeDevice}>×</button></div>
    <p className="text-xs text-ink-subtle">设备注册信息须先保存，设备才能注册并提供视频目录。NVR 下多个视频通道共用此注册身份；修改将影响该设备的所有视频通道。</p>
    <div className="grid gap-3 sm:grid-cols-2">{([['name','设备名称'],['id','设备国标编号（20 位）'],['password',form==='edit'?'注册密码（留空保持）':'注册密码']] as const).map(([key,label])=><label key={key} className="text-sm">{label}<input className={field} disabled={key==='id'&&form==='edit'} type={key==='password'?'password':'text'} autoComplete="new-password" value={device[key]} onChange={e=>{setDevice({...device,[key]:e.target.value});setDeviceDirty(true)}}/></label>)}
    <label className="text-sm">协议版本<select className={field} value={device.version} onChange={e=>{setDevice({...device,version:e.target.value});setDeviceDirty(true)}}><option value="auto">自动（未确认时兼容 2016）</option><option value="2016">2016</option><option value="2022">2022</option></select></label></div>
    <label className="block text-sm">NVR 独立媒体地址（可选）<input className={field} value={device.mediaIPs} placeholder="留空使用设备注册地址" onChange={e=>{setDevice({...device,mediaIPs:e.target.value});setDeviceDirty(true)}}/></label>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={device.enabled} onChange={e=>{setDevice({...device,enabled:e.target.checked});setDeviceDirty(true)}}/>允许此设备注册</label>
    <div className="flex justify-end gap-2"><button type="button" className={button} onClick={closeDevice}>取消设备修改</button><button type="button" className="min-h-11 rounded-base bg-primary px-4 text-sm text-white" onClick={()=>void saveDevice()}>保存注册信息</button></div>
   </section>}
   {selected&&<>
    <p className="text-xs text-slate-500">自动模式依据设备版本声明选择兼容配置；未声明时按 2016 兼容接入。手动指定用于兼容排查，不代表通过完整标准认证。</p>
    {runtime.devices?.filter(d=>d.id===selected && d.registered && d.version).map(d=><p key={d.id} className="text-sm text-slate-600">当前兼容配置：{d.version!.profile} · {d.version!.peer ? `设备声明：${d.version!.peer}` : '设备版本未确认'}</p>)}
    <div className="flex items-center justify-between gap-2 text-sm"><span>设备状态：{runtime.devices?.find(d=>d.id===selected)?.registered?'已注册':runtime.state==='disabled'?'国标服务已停用':'等待注册'}</span><button type="button" className={button} onClick={async()=>{setError('');try{await request(`/gb28181/devices/${selected}/catalog-refresh`,{method:'POST',body:'{}'});setMessage('目录请求已发送，列表会自动更新。')}catch(e){setError((e as Error).message)}}}>刷新设备目录</button></div>
    {!binding&&<label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={batch} onChange={e=>{setBatch(e.target.checked);setSelectedChannels([]);setChannel('');setDirty(true)}}/>批量接入 NVR 视频通道</label>}
    {batch&&<p className="text-xs text-ink-subtle">已选 {selectedChannels.length} 路。名称采用“基本信息中的名称 · 目录名称”；共用备注、传输和播放设置，最后统一保存。容量不足时整批不保存。</p>}
    <label className="block text-sm">搜索视频目录<input className={field} value={query} onChange={e=>setQuery(e.target.value)} placeholder="名称或国标编号"/></label>
    <div className="max-h-56 overflow-auto rounded-base border border-line">{options.items.filter(i=>(!binding||i.id===binding.channel_id)&&((i.document.name??'').includes(query)||i.id.includes(query))).map(i=><label key={i.id} className={`flex min-h-14 cursor-pointer items-center gap-3 border-b border-line p-3 text-sm ${(batch?selectedChannels.includes(i.id):channel===i.id)?'bg-primary-50':''}`}><input type={batch?"checkbox":"radio"} name="gb-catalog" checked={batch?selectedChannels.includes(i.id):channel===i.id} disabled={!!i.input_id&&i.input_id!==binding?.input_id} onChange={()=>{if(batch)setSelectedChannels(old=>old.includes(i.id)?old.filter(id=>id!==i.id):[...old,i.id]);else setChannel(i.id);setDirty(true)}}/><span><strong className="block">{i.document.name||i.id}</strong><span className="text-xs text-ink-subtle">{i.id}{i.input_id&&i.input_id!==binding?.input_id?' · 已接入，请从列表编辑':''}{!i.available?' · 目录暂不可用':''}</span></span></label>)}{!options.items.length&&<p className="p-3 text-sm text-ink-subtle">尚未收到目录。保存设备注册信息并完成设备端配置后，可刷新目录。已有配置可离线编辑。</p>}</div>
    <label className="block text-sm">媒体传输方式<select className={field} value={transport} onChange={e=>{setTransport(e.target.value);setDirty(true)}}><option value="tcp-passive">TCP · 摄像头连接网关</option><option value="tcp-active">TCP · 网关连接摄像头</option><option value="udp">UDP</option></select></label>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e=>{setEnabled(e.target.checked);setDirty(true)}}/>启用此视频通道（停用后录像和 AI 等待视频源）</label>
   </>}
  </fieldset>
 </div>
}
