import {useEffect,useState} from 'react'
import {Link} from 'react-router-dom'
import {vehicleService,type VehiclePreparation,type VehicleWatchlist,type VehicleCapability} from '@/api/vehicleService'

export function VehiclePending({compact=false,capability}:{compact?:boolean;capability?:VehicleCapability}){
  return <p role="status" className="rounded-base border border-line bg-surface-page px-3 py-2 text-xs text-ink-subtle"><strong>{capability?.effective?'车牌识别已运行':capability?.state==='available'?'车牌识别可用':capability?'车牌服务暂不可用':'正在核对车牌服务'}</strong>{!compact&&` · ${capability?.reason??'请稍候刷新运行状态'}`} · 场景准确率待验证{capability?.queue&&capability.queue.pending>0?` · 排队 ${capability.queue.pending} 条，最长等待 ${Math.ceil(capability.queue.oldest_wait_ms/1000)} 秒`:''}</p>
}
export function VehicleChannelSettings({id}:{id:string}){
  const [data,setData]=useState<VehiclePreparation<{requested:boolean}>|null>(null),[requested,setRequested]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[reload,setReload]=useState(0)
  useEffect(()=>{let live=true;setData(null);setError('');void vehicleService.channel(id).then(r=>{if(live){setData(r);setRequested(r.document.requested)}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[id,reload])
  useEffect(()=>{if(!data?.document.requested)return;let live=true;const timer=setInterval(()=>{void vehicleService.channel(id).then(updated=>{if(live)setData(old=>old?{...old,capability:updated.capability}:old)}).catch(()=>{})},5000);return()=>{live=false;clearInterval(timer)}},[data?.document.requested,id])
  async function save(){if(!data)return;setBusy(true);setError('');setMessage('');try{const r=await vehicleService.saveChannel(id,data.version,requested);setData(r);setMessage(requested?'配置已保存；模型加载和运行状态请刷新核对。':'已关闭车牌识别，原通行计数继续运行。')}catch(e){setError(e instanceof Error?e.message:'保存失败')}finally{setBusy(false)}}
  return <section aria-label="车辆识别配置" className="mt-3 space-y-3 border-t border-line pt-3"><VehiclePending capability={data?.capability}/>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={requested} disabled={!data||busy} onChange={e=>setRequested(e.target.checked)}/>启用此通道的车牌识别</label>
    <p className="text-xs text-ink-subtle">复用本通道检测与跟踪。现有车辆计数和空间告警不依赖车牌识别；原归档设置保持独立。需在流量统计绑定仅含车辆类别的计数器；使用原分辨率证据（当前支持偶数尺寸、不超过8388608像素（常见4K））。</p>
    {error&&<p role="alert" className="text-xs text-danger">{error} <button className="underline" disabled={busy} onClick={()=>setReload(v=>v+1)}>重新载入配置</button></p>}
    {message&&<p role="status" className="text-xs text-ink-subtle">{message}</p>}
    <div className="flex flex-wrap gap-2"><button className="btn-secondary text-xs" disabled={!data||busy||requested===data.document.requested} onClick={()=>void save()}>{busy?'正在保存…':'保存配置'}</button><button className="btn-secondary text-xs" disabled={!data||busy||requested===data.document.requested} onClick={()=>{setRequested(data!.document.requested);setMessage('')}}>撤销修改</button><Link className="btn-secondary text-xs" to="/recognition-history?view=vehicles">车辆通行</Link><Link className="btn-secondary text-xs" to="/config-center?category=vehicles">关注名单</Link></div>
  </section>
}
export function VehicleWatchlistSettings(){
  const [data,setData]=useState<VehiclePreparation<VehicleWatchlist>|null>(null),[plate,setPlate]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0)
  useEffect(()=>{let live=true;setError('');setData(null);void vehicleService.watchlist().then(r=>{if(live)setData(r)}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[reload])
  async function save(entries:VehicleWatchlist['entries']){if(!data)return;setBusy(true);setError('');try{setData(await vehicleService.saveWatchlist(data.version,{entries}));setPlate('');setNote('')}catch(e){setError(e instanceof Error?e.message:'保存失败')}finally{setBusy(false)}}
  return <section className="ui-panel space-y-4 p-4" aria-label="车辆关注名单"><div><h2 className="text-base font-semibold">车辆关注名单</h2><p className="mt-1 text-xs text-ink-subtle">启用车牌识别并绑定车辆计数器后，不同真实帧的整牌一致且匹配名单时告警。支持普通、新能源及挂/学/警/港/澳后缀车牌。名单修改同步后对新通行生效；已有任务继续使用发生时的名单，不追溯生成历史告警。</p></div><VehiclePending capability={data?.capability}/>
    <form className="flex flex-wrap items-end gap-2" onSubmit={e=>{e.preventDefault();if(data)void save([...data.document.entries,{plate,note}])}}>
      <label className="text-xs">车牌<input aria-label="关注车牌" className="form-input mt-1" maxLength={16} required value={plate} onChange={e=>setPlate(e.target.value)}/></label><label className="text-xs">备注<input aria-label="车牌备注" className="form-input mt-1" maxLength={120} value={note} onChange={e=>setNote(e.target.value)}/></label><button className="btn-primary" disabled={busy||!data||!plate.trim()||data.document.entries.length>=500}>{busy?'正在保存…':'加入关注名单'}</button>
    </form>
    {error&&<p role="alert" className="text-sm text-danger">{error} <button className="underline" disabled={busy} onClick={()=>setReload(v=>v+1)}>重新载入</button></p>}
    {!data&&!error&&<p role="status">正在读取名单…</p>}
    {data&&<div className="overflow-auto"><table className="w-full text-left text-sm"><thead className="border-b border-line text-xs text-ink-subtle"><tr><th className="py-2">车牌</th><th>备注</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.document.entries.map(entry=><tr key={entry.plate} className="border-b border-line"><td className="py-3 font-medium">{entry.plate}</td><td>{entry.note||'—'}</td><td className="text-xs text-warning-700">{data.capability.effective?'匹配后告警':'等待通道启用'}</td><td><button className="btn-secondary text-xs" disabled={busy} onClick={()=>void save(data.document.entries.filter(e=>e.plate!==entry.plate))}>移出名单</button></td></tr>)}</tbody></table>{!data.document.entries.length&&<p className="py-8 text-center text-sm text-ink-subtle">尚无关注车牌</p>}<p className="mt-2 text-xs text-ink-faint">{data.document.entries.length} / 500 条 · 版本 {data.version}</p></div>}
  </section>
}
