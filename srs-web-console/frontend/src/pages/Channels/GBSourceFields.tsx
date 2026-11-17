import {useEffect,useRef,useState} from 'react'
import {request} from '@/api/httpClient'
import type {GBBinding} from './gbTypes'
import {useDiscardConfirmation} from '@/components/modals/useDiscardConfirmation'
import {GBPlatformCard} from './GBPlatformCard'
import {PasswordInput} from '@/components/ui/PasswordInput'

type Device={id:string;name:string;version:string;enabled:boolean;mediaIPs?:string[]}
type Item={id:string;document:{name?:string};available:boolean;input_id?:string;enabled?:boolean;transport?:string}
type Options={revision:number;devices:Device[];items:Item[]}
export type GBSourceDraft={revision:number;deviceId:string;channelId:string;transport:string;enabled:boolean;ready:boolean;registrationDirty:boolean;saveRegistration:()=>Promise<boolean>;discardCreated:()=>Promise<void>;autoChannel:boolean;batch:boolean;channels:{id:string;name:string}[]}
const field='mt-1 block min-h-11 w-full rounded-base border border-line bg-surface px-3 text-sm'
const button='min-h-11 rounded-base border border-line px-3 text-sm hover:border-primary'
const emptyDevice={id:'',name:'',version:'auto',enabled:true,password:'',mediaIPs:''}
const deviceErrors:Record<string,string>={
 catalog_capacity_exceeded:'设备目录总量达到接入服务上限，原目录已保留。请检查设备目录规模后重新刷新。',
 device_reported_error:'设备已注册，但报告自身故障，请检查摄像头或 NVR 状态。',
 registration_conflict:'检测到相同编号的设备注册冲突，请核对设备身份。',
 device_query_failed:'设备未能完成信息查询，请检查设备状态后重试。',
 authentication_failed:'设备注册密码不正确：请核对设备端填写的密码与此处登记的一致，或在“编辑设备注册信息”中重新设置。',
}
/** A large NVR or lower platform can list thousands of channels; render a page and let search narrow it. */
const CATALOG_PAGE=200

/** Device registration is a prerequisite; video binding is only saved by the wizard. */
export function GBSourceFields({binding,defaultName='',onDraft,onDirty,onBusy}:{binding?:GBBinding;defaultName?:string;onDraft:(draft:GBSourceDraft)=>void;onDirty:(dirty:boolean)=>void;onBusy:(busy:boolean)=>void}){
 const {requestDiscard,dialog:discardDialog}=useDiscardConfirmation()
 const [editRevision,setEditRevision]=useState(binding?.revision)
 const [batch,setBatch]=useState(false),[selectedChannels,setSelectedChannels]=useState<string[]>([])
 const [selected,setSelected]=useState(binding?.device_id??'')
 const [options,setOptions]=useState<Options>({revision:0,devices:[],items:[]})
 const [channel,setChannel]=useState(binding?.channel_id??''),[autoChannel,setAutoChannel]=useState(false)
 const [transport,setTransport]=useState('tcp-passive'),[enabled,setEnabled]=useState(true)
 const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('')
 const [refresh,setRefresh]=useState(0),[dirty,setDirty]=useState(false),[query,setQuery]=useState('')
 const [removing,setRemoving]=useState(false)
 const saveRef=useRef<()=>Promise<boolean>>(async()=>false)
 const discardRef=useRef<()=>Promise<void>>(async()=>{}),createdRef=useRef('')
 const [form,setForm]=useState<'new'|'edit'|null>(null),[device,setDevice]=useState({...emptyDevice}),[deviceDirty,setDeviceDirty]=useState(false)
 const [runtime,setRuntime]=useState<{state?:string;devices?:{id:string;registered:boolean;lastError?:string;deviceOnline?:string;deviceHealth?:string;version?:{profile:string;confirmed:boolean;peer?:string}}[];unknownDevices?:{id:string;address:string}[]}>({})
 const matched=options.items.filter(i=>(!binding||i.id===binding.channel_id)&&((i.document.name??'').includes(query)||i.id.includes(query)))
 const selectable=matched.filter(i=>!i.input_id||i.input_id===binding?.input_id)
 const unknownNumbers=(runtime.unknownDevices??[]).filter(u=>!options.devices.some(d=>d.id===u.id))
 useEffect(()=>{onDraft({revision:editRevision===undefined?options.revision:Number(editRevision),deviceId:selected,channelId:channel,transport,enabled,ready,registrationDirty:deviceDirty,saveRegistration:()=>saveRef.current(),discardCreated:()=>discardRef.current(),autoChannel,batch,channels:selectedChannels.map(id=>({id,name:options.items.find(i=>i.id===id)?.document.name||id}))})},[editRevision,options.revision,selected,channel,transport,enabled,ready,deviceDirty,autoChannel,batch,selectedChannels,options.items,onDraft])
 useEffect(()=>{onDirty(dirty||deviceDirty)},[dirty,deviceDirty,onDirty])
 // The only free video channel of the chosen device needs no decision. Marked as automatic so the
 // wizard can tell it from a choice the person made, and so a reload never undoes it.
 const onlyFree=(items:Item[])=>{const free=items.filter(i=>!i.input_id);return free.length===1?free[0]!.id:''}
 useEffect(()=>{
  if(binding||!selected||!ready||batch||channel)return
  const only=onlyFree(options.items)
  if(only){setChannel(only);setAutoChannel(true)}
 },[binding,selected,ready,batch,channel,options.items])
 // Until this camera is registered the page is simply its registration form.
 useEffect(()=>{
  if(binding||!ready||selected||form||deviceDirty)return
  setDevice({...emptyDevice});setForm('new')
 },[binding,ready,selected,form,deviceDirty])
 useEffect(()=>{
  let cancelled=false;setReady(false);setError('')
  request<Options>('/gb28181/channel-options'+(selected?'?deviceId='+selected:'')).then(data=>{
   if(cancelled)return;setOptions(data);setReady(true)
   const existing=binding&&data.items.find(i=>i.id===binding.channel_id)
   setTransport(existing?.transport??'tcp-passive');setEnabled(existing?.enabled??true)
   const only=selected&&!binding?onlyFree(data.items):''
   setChannel(binding?.channel_id??only);setAutoChannel(!!only);setSelectedChannels([]);setDirty(false)
  }).catch(e=>{if(!cancelled)setError(e.message)})
  return()=>{cancelled=true}
 },[selected,refresh,binding?.channel_id])
 // Poll observations only. Never advance the draft revision or overwrite form values.
 useEffect(()=>{let cancelled=false,first=true,timer:ReturnType<typeof setTimeout>;const poll=async()=>{
  // Always read once on open; afterwards skip polling while the page is in the background.
  try{if(first||!document.hidden){first=false;const status=await request<typeof runtime>('/gb28181/status');if(!cancelled)setRuntime(status)
   if(selected){const catalog=await request<{items:Item[]}>(`/gb28181/devices/${selected}/channels`);if(!cancelled)setOptions(old=>({...old,items:catalog.items}))}
  }}catch{/* The configuration remains editable when the runtime is unavailable. */}
  if(!cancelled)timer=setTimeout(poll,5000)
 };void poll();return()=>{cancelled=true;clearTimeout(timer)}},[selected])
 const closeDevice=()=>{if(busy)return;requestDiscard(deviceDirty,'尚未保存的设备注册修改将被放弃，已保存的设备不会改变。',()=>{setForm(null);setDeviceDirty(false)})}
 const openDevice=(kind:'new'|'edit')=>{
   requestDiscard(deviceDirty,'打开另一份注册表单将放弃尚未保存的设备修改。',()=>{
    const existing=options.devices.find(d=>d.id===selected)
    setDevice(kind==='edit'&&existing?{...emptyDevice,...existing,password:'',mediaIPs:(existing.mediaIPs??[]).join(', ')}:{...emptyDevice})
    setDeviceDirty(false);setRemoving(false);setForm(kind)
   })
 }
 /** Applies the open registration form. The wizard's "next" calls this, so there is no separate save step. */
 const saveDevice=async():Promise<boolean>=>{
  // A number that is already registered is that device (for example another channel of the same NVR).
  // It is used as it is: nothing about it is written, so other channels on it are never affected.
  const known=options.devices.some(d=>d.id===device.id)
  if(form==='new'&&known&&/^\d{20}$/.test(device.id)){
   setDevice({...emptyDevice});setForm(null);setDeviceDirty(false);setError('')
   if(selected!==device.id)setSelected(device.id)
   return true
  }
  if(!/^\d{20}$/.test(device.id)||(form==='edit'&&!device.name.trim())||((form==='new'||device.password)&&device.password.length<8)){setError('请填写 20 位国标编号及至少 8 位注册密码');return false}
  setBusy(true);onBusy(true);setError('')
  try{
   const {password,mediaIPs,...rest}=device
   // A new camera is named after the channel being created; there is no second name to type.
   const named={...rest,name:form==='new'?(defaultName.trim()||device.id):device.name.trim()}
   const result=await request<{revision:number}>('/gb28181/devices',{method:'POST',body:JSON.stringify({expectedRevision:editRevision===undefined?options.revision:Number(editRevision),device:{...named,mediaIPs:mediaIPs.split(/[,，\s]+/).filter(Boolean),...(password?{password}:{})}})})
   if(form==='new')createdRef.current=device.id
   if(binding)setEditRevision(result.revision)
   setOptions(old=>({...old,revision:result.revision,devices:[...old.devices.filter(d=>d.id!==device.id),{...named,mediaIPs:mediaIPs.split(/[,，\s]+/).filter(Boolean)}]}))
   setDevice({...emptyDevice});setForm(null);setDeviceDirty(false);setMessage('设备注册信息已保存。设备注册并提供视频目录后会自动继续；有多路画面时请选择要接入的画面。')
   if(selected!==device.id)setSelected(device.id)
   return true
  }catch(e){setError((e as Error).message);return false}finally{setBusy(false);onBusy(false)}
 }
 // A camera registered only for this wizard is removed again when the wizard is abandoned.
 const discardCreated=async()=>{
  const id=createdRef.current;if(!id)return;createdRef.current=''
  try{
   const latest=await request<Options>('/gb28181/channel-options')
   await request(`/gb28181/devices/${id}`,{method:'DELETE',body:JSON.stringify({expectedRevision:latest.revision})})
  }catch{/* Still bound to a channel, or already gone: nothing to undo. */}
 }
 useEffect(()=>{saveRef.current=saveDevice;discardRef.current=discardCreated})
 const deviceChannels=options.items.filter(i=>i.input_id).length
 const removeDevice=async()=>{
  setBusy(true);onBusy(true);setError('')
  try{
   await request(`/gb28181/devices/${selected}`,{method:'DELETE',body:JSON.stringify({expectedRevision:options.revision})})
   createdRef.current='';setForm(null);setDeviceDirty(false);setRemoving(false);setSelected('');setMessage('设备已删除。')
   setRefresh(n=>n+1)
  }catch(e){setError((e as Error).message)}finally{setBusy(false);onBusy(false)}
 }
 return <div className="space-y-4">
  <GBPlatformCard collapsed={!!selected&&!!runtime.devices?.find(d=>d.id===selected)?.registered}/>
  {!binding&&unknownNumbers.length>0&&<section aria-label="收到注册请求的未登记设备" className="rounded-base bg-warning/5 p-3 text-sm">
   <p className="font-medium text-warning-700">收到未登记编号的注册请求，通常是设备端已配置、平台这边还没登记：</p>
   <ul className="mt-2 space-y-2">{unknownNumbers.map(u=><li key={u.id} className="flex flex-wrap items-center justify-between gap-2">
    <span>{u.id} · 来自 {u.address.replace(/:\d+$/,'')}</span>
    <button type="button" className={button} disabled={!ready||busy} onClick={()=>requestDiscard(deviceDirty,'打开另一份注册表单将放弃尚未保存的设备修改。',()=>{setDevice({...emptyDevice,id:u.id});setDeviceDirty(true);setForm('new')})}>登记此编号</button></li>)}</ul></section>}
  {error&&<p role="alert" className="rounded-base bg-danger/5 p-3 text-sm text-danger">{error}</p>}
  {message&&<p role="status" className="text-sm text-primary">{message}</p>}
  <fieldset disabled={busy} className="space-y-4">
   {/* This wizard configures one camera. Other cameras are edited from the channel list. */}
   {selected&&<p className="text-sm">当前摄像头：<strong>{options.devices.find(d=>d.id===selected)?.name??selected}</strong> · {selected}</p>}
    <div className="flex flex-wrap gap-2">{selected&&!form&&<button type="button" className={button} onClick={()=>openDevice('edit')}>编辑设备注册信息</button>}{error&&<button type="button" className={button} onClick={()=>{if(binding){setError('为同时刷新名称、备注和接入参数，请关闭此向导后重新点击通道编辑。');return}requestDiscard(dirty||deviceDirty,'重新读取将放弃本页接入参数草稿。',()=>{setForm(null);setDeviceDirty(false);setRefresh(n=>n+1)})}}>重新读取配置</button>}</div>
   {form&&<section aria-label="设备注册信息" className="space-y-3 rounded-base border border-line bg-surface-page p-3" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();closeDevice()}}}>
    <div className="flex items-center justify-between"><h4 className="font-medium">{form==='new'?'登记这台摄像头':'编辑设备注册信息'}</h4>{(selected||binding)&&<button type="button" aria-label="关闭设备注册信息" className="min-h-11 min-w-11" onClick={closeDevice}>×</button>}</div>
    <p className="text-xs text-ink-subtle">设备注册信息须先保存，设备才能注册并提供视频目录。NVR 下多个视频通道共用此注册身份；修改将影响该设备的所有视频通道。</p>
    {form==='new'&&options.devices.some(d=>d.id===device.id)&&<p role="status" className="text-sm text-primary">该编号已登记为“{options.devices.find(d=>d.id===device.id)?.name}”，将直接使用它，不会修改它的注册信息。</p>}
    <div className="grid gap-3 sm:grid-cols-2">{([...(form==='edit'?[['name','设备名称']]:[]),['id','设备国标编号（20 位）'],['password',form==='edit'?'注册密码（留空保持）':'注册密码']] as [Exclude<keyof typeof emptyDevice,'enabled'>,string][]).map(([key,label])=>{
     const props={className:field,autoComplete:'new-password',value:device[key],onChange:(e:React.ChangeEvent<HTMLInputElement>)=>{setDevice({...device,[key]:e.target.value});setDeviceDirty(true)}}
     return <label key={key} className="text-sm">{label}{key==='password'?<PasswordInput {...props}/>:<input {...props} disabled={key==='id'&&form==='edit'} type="text"/>}</label>})}
</div>
    <details className="text-sm"><summary className="min-h-11 cursor-pointer text-ink-subtle">高级：协议版本、NVR 媒体地址</summary>
     <div className="space-y-3">
      <label className="block">协议版本<select className={field} value={device.version} onChange={e=>{setDevice({...device,version:e.target.value});setDeviceDirty(true)}}><option value="auto">自动（未确认时兼容 2016）</option><option value="2016">2016</option><option value="2022">2022</option></select></label>
      <p className="text-xs text-ink-subtle">自动模式依据设备版本声明选择兼容配置；未声明时按 2016 兼容接入。手动指定用于兼容排查，不代表通过完整标准认证。</p>
      <label className="block">NVR 独立媒体地址（可选）<input className={field} value={device.mediaIPs} placeholder="留空使用设备注册地址" onChange={e=>{setDevice({...device,mediaIPs:e.target.value});setDeviceDirty(true)}}/></label>
     </div></details>
    {form==='edit'&&<label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={device.enabled} onChange={e=>{setDevice({...device,enabled:e.target.checked});setDeviceDirty(true)}}/>允许此设备注册</label>}
    {form==='edit'&&<div className="rounded-base border border-line p-3 text-sm">
     {deviceChannels>0&&<p className="mb-2 text-warning-700">该设备仍有 {deviceChannels} 路视频通道在用，需先在接入管理删除这些通道；若只是暂时不用，请取消勾选“允许此设备注册”。</p>}
     {removing&&deviceChannels===0
      ?<div className="flex flex-wrap items-center gap-2"><span>删除后设备需重新登记才能注册。</span>
        <button type="button" className="min-h-11 rounded-base bg-danger px-3 text-white" onClick={()=>void removeDevice()}>确认删除设备</button>
        <button type="button" className={button} onClick={()=>setRemoving(false)}>不删除</button></div>
      :<button type="button" className={`${button} disabled:opacity-50`} disabled={deviceChannels>0} onClick={()=>setRemoving(true)}>删除此设备</button>}
    </div>}
    {(selected||binding)&&<div className="flex justify-end gap-2"><button type="button" className={button} onClick={closeDevice}>取消设备修改</button></div>}
   </section>}
   {selected&&<>
    {runtime.devices?.filter(d=>d.id===selected && d.registered && d.version).map(d=><p key={d.id} className="text-sm text-slate-600">当前兼容配置：{d.version!.profile} · {d.version!.peer ? `设备声明：${d.version!.peer}` : '设备版本未确认'}</p>)}
    {runtime.devices?.filter(d=>d.id===selected && d.lastError).map(d=><p key={d.id} role="alert" className="rounded-base bg-warning/5 p-3 text-sm text-warning-700">{d.lastError==='device_reported_error'&&d.deviceHealth==='ERROR'?'设备自检报告异常；注册连接仍在，请检查摄像头或 NVR。':deviceErrors[d.lastError!]??'设备状态异常，请查看国标服务日志。'}</p>)}
    {runtime.devices?.filter(d=>d.id===selected && d.deviceOnline==='OFFLINE').map(d=><p key={d.id} role="status" className="text-sm text-warning-700">设备查询结果报告离线；媒体状态仍以实际收到的视频为准。</p>)}
    <div className="flex items-center justify-between gap-2 text-sm"><span>设备状态：{runtime.devices?.find(d=>d.id===selected)?.registered?'已注册':runtime.state==='disabled'?'国标服务已停用':'等待注册'}</span>{!options.items.length&&<button type="button" className={button} onClick={async()=>{setError('');try{await request(`/gb28181/devices/${selected}/catalog-refresh`,{method:'POST',body:'{}'});setMessage('目录请求已发送，列表会自动更新。')}catch(e){setError((e as Error).message)}}}>刷新设备目录</button>}</div>
    {!binding&&(batch||options.items.filter(i=>!i.input_id).length>1)&&<label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={batch} onChange={e=>{setBatch(e.target.checked);setSelectedChannels([]);setChannel('');setDirty(true)}}/>批量接入 NVR 视频通道</label>}
    {batch&&<div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-ink-subtle">已选 {selectedChannels.length} 路。名称采用“基本信息中的名称 · 目录名称”；共用备注、传输和播放设置，最后统一保存。容量不足时整批不保存。</p>
     <button type="button" className={button} disabled={!selectable.length} onClick={()=>{const all=selectable.slice(0,100).map(i=>i.id);setSelectedChannels(old=>all.every(id=>old.includes(id))?old.filter(id=>!all.includes(id)):[...new Set([...old,...all])]);setDirty(true)}}>{selectable.length&&selectable.slice(0,100).every(i=>selectedChannels.includes(i.id))?'取消全选':`全选可接入的 ${Math.min(selectable.length,100)} 路`}</button></div>}
    {(options.items.length>8||query)&&<label className="block text-sm">搜索视频目录<input className={field} value={query} onChange={e=>setQuery(e.target.value)} placeholder="名称或国标编号"/></label>}
    {matched.length>CATALOG_PAGE&&<p role="status" className="text-xs text-ink-subtle">目录共 {matched.length} 项，仅显示前 {CATALOG_PAGE} 项，请输入名称或编号筛选。</p>}
    <div className="max-h-56 overflow-auto rounded-base border border-line">{matched.slice(0,CATALOG_PAGE).map(i=><label key={i.id} className={`flex min-h-14 cursor-pointer items-center gap-3 border-b border-line p-3 text-sm ${(batch?selectedChannels.includes(i.id):channel===i.id)?'bg-primary-50':''}`}><input type={batch?"checkbox":"radio"} name="gb-catalog" checked={batch?selectedChannels.includes(i.id):channel===i.id} disabled={!!i.input_id&&i.input_id!==binding?.input_id} onChange={()=>{if(batch)setSelectedChannels(old=>old.includes(i.id)?old.filter(id=>id!==i.id):[...old,i.id]);else{setChannel(i.id);setAutoChannel(false)};setDirty(true)}}/><span><strong className="block">{i.document.name||i.id}</strong><span className="text-xs text-ink-subtle">{i.id}{i.input_id&&i.input_id!==binding?.input_id?' · 已接入，请从列表编辑':''}{!i.available?' · 目录暂不可用':''}</span></span></label>)}{!options.items.length&&<p className="p-3 text-sm text-ink-subtle">尚未收到目录。保存设备注册信息并完成设备端配置后，可刷新目录。已有配置可离线编辑。</p>}</div>
    <label className="block text-sm">媒体传输方式<select className={field} value={transport} onChange={e=>{setTransport(e.target.value);setDirty(true)}}><option value="tcp-passive">TCP · 摄像头连接网关</option><option value="tcp-active">TCP · 网关连接摄像头</option><option value="udp">UDP</option></select></label>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e=>{setEnabled(e.target.checked);setDirty(true)}}/>启用此通道（关闭后录像和 AI 等待视频源）</label>
   </>}
  </fieldset>
  {discardDialog}
 </div>
}
