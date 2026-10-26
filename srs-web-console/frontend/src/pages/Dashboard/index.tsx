import { StorageVolumes } from '@/components/StorageVolumes'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/store/settings'
import { useSearchParams } from 'react-router-dom'
import { Activity, FileText, Power, Settings2 } from 'lucide-react'
import { observabilityService as api, type Summary, type Snapshot, type LogSettings } from '@/api/observabilityService'

import { Curve, Sparkline, computeRecentStats, type DataPoint } from './Curve'
import { LogViewer } from './LogViewer'
import { AlarmServiceStatusCard } from './AlarmServiceStatusCard'
import { LlmServiceStatusCard } from './LlmServiceStatusCard'
import { names, bytes, percent, wholeHostCpu, time, input, button } from './format'

export default function DashboardPage(){
  const pollMs = useSettingsStore(s => s.settings?.pollIntervalMs ?? 5000)
  const [params,setParams]=useSearchParams(),tab=params.get('tab')==='logs'?'logs':'overview'
  const [summary,setSummary]=useState<Summary|null>(null),[history,setHistory]=useState<Snapshot[]>([])
  const [error,setError]=useState(''),[historyError,setHistoryError]=useState(''),[hours,setHours]=useState(1)
  const [metricService,setMetricService]=useState('host'),[settingsOpen,setSettingsOpen]=useState(false)
  const [draft,setDraft]=useState<LogSettings|null>(null),[saving,setSaving]=useState(false),[saveMessage,setSaveMessage]=useState('')
  const [shutdownOpen,setShutdownOpen]=useState(false)
  const [shutdownConfirm,setShutdownConfirm]=useState('')
  const [shuttingDown,setShuttingDown]=useState(false)
  const [shutdownError,setShutdownError]=useState('')
  /** 关机请求已被受理：开始轮询进度，序列中途失败时把原因显示出来 */
  const [shutdownAccepted,setShutdownAccepted]=useState(false)
  const SHUTDOWN_CONFIRM_TEXT = '关机'
  useEffect(()=>{
    let cancelled=false,timer:ReturnType<typeof setTimeout>
    const tick=async()=>{
      if(!document.hidden){try{const data=await api.summary();if(!cancelled){setSummary(data);setError('')}}catch(e){if(!cancelled)setError((e as Error).message)}}
      if(!cancelled)timer=setTimeout(tick,pollMs)
    }
    void tick();return()=>{cancelled=true;clearTimeout(timer)}
  },[pollMs])
  useEffect(()=>{
    let cancelled=false,timer:ReturnType<typeof setTimeout>
    const tick=async()=>{
      if(!document.hidden&&tab==='overview'){try{const data=await api.history(hours);if(!cancelled){setHistory(data.items);setHistoryError('')}}catch(e){if(!cancelled)setHistoryError((e as Error).message)}}
      if(!cancelled)timer=setTimeout(tick,30000)
    }
    setHistory([]);void tick();return()=>{cancelled=true;clearTimeout(timer)}
  },[hours,tab])
  useEffect(()=>{
    if(!shutdownAccepted) return
    let cancelled=false
    const t=setInterval(async()=>{
      try{
        const s=await api.shutdownStatus()
        if(cancelled||s.state!=='failed') return
        setShutdownError(`关机未完成：${s.error}`)
        setShuttingDown(false);setShutdownAccepted(false)
      }catch{
        // 设备正在断电时页面连不上，保持"正在关机"
      }
    },2000)
    return()=>{cancelled=true;clearInterval(t)}
  },[shutdownAccepted])
  const snap=summary?.snapshot,stale=!!snap&&(!!error||Date.now()-snap.ts>Math.max(45000,pollMs*2))
  const services=snap?.services??[],unhealthy=services.filter(s=>!s.healthy)
  const chartEnd=history.at(-1)?.ts??snap?.ts??Date.now()
  const chartRange:[number,number]=[chartEnd-hours*3600000,chartEnd]
  const net=(p:Snapshot,field:'rxBytesPerSecond'|'txBytesPerSecond')=>{
    const values=p.host.network?.map(n=>n[field]).filter((v):v is number=>v!==null)
    return values?.length?values.reduce((a,b)=>a+b,0)*8/1000000:null
  }
  const networkScale=Math.max(1,...history.flatMap(p=>[net(p,'rxBytesPerSecond')??0,net(p,'txBytesPerSecond')??0]))*1.05
  async function save(){
    if(!draft)return
    setSaving(true);setSaveMessage('')
    try{await api.settings(draft);setSummary(await api.summary());setSaveMessage('已保存并应用，采集无需重启')}
    catch(e){setSaveMessage((e as Error).message)}finally{setSaving(false)}
  }
  async function doShutdown(){
    if(shutdownConfirm !== SHUTDOWN_CONFIRM_TEXT) return
    setShuttingDown(true);setShutdownError('')
    try{
      await api.shutdown()
      // 已受理：页面会随系统断电而断开；期间轮询进度，中途失败会提示并可关闭
      setShutdownAccepted(true)
    } catch(e){
      setShutdownError((e as Error).message)
      setShuttingDown(false)
    }
  }
  function values(field:'cpu'|'memory'|'bpu'){
    return history.map(p=>{
      const s=p.services.find(v=>v.id===metricService)
      const value=field==='bpu'?(p.host.bpuPercent??null):field==='cpu'?(metricService==='host'?p.host.cpuPercent:wholeHostCpu(s?.cpuPercent,p.host.cores)):(metricService==='host'?p.host.memoryBytes:s?.memoryBytes??null)
      return {ts:p.ts,value:field==='memory'&&value!==null?value/1024**2:value}
    })
  }
  // 顶部卡片专用：主机维度的最近 N 秒序列（不受 metricService 切换影响）
  function hostSeries(field:'cpu'|'memory'|'bpu'|'diskPct'|'netRx'|'netTx'):DataPoint[]{
    return history.map(p=>{
      if(field==='cpu')return{ts:p.ts,value:p.host.cpuPercent}
      if(field==='bpu')return{ts:p.ts,value:p.host.bpuPercent??null}
      if(field==='memory')return{ts:p.ts,value:p.host.memoryBytes/1024**2}
      if(field==='diskPct')return{ts:p.ts,value:p.host.diskTotalBytes?100*(p.host.diskUsedBytes??0)/p.host.diskTotalBytes:null}
      if(field==='netRx')return{ts:p.ts,value:net(p,'rxBytesPerSecond')}
      return{ts:p.ts,value:net(p,'txBytesPerSecond')}
    })
  }
  // 不同指标用不同的平均窗口：快变的更宽（更平滑），慢变的够用就行
  // 采样频率后端固定 10s 一次（嵌入式不增加负荷），纯前端调窗口
  const WINDOWS={cpu:120_000,bpu:120_000,memory:60_000,diskPct:60_000,net:120_000} as const
  const cardNow=history.at(-1)?.ts??snap?.ts??Date.now()
  const cpuCard=computeRecentStats(hostSeries('cpu'),WINDOWS.cpu,cardNow)
  const bpuCard=computeRecentStats(hostSeries('bpu'),WINDOWS.bpu,cardNow)
  const memCard=computeRecentStats(hostSeries('memory'),WINDOWS.memory,cardNow)
  const diskCard=computeRecentStats(hostSeries('diskPct'),WINDOWS.diskPct,cardNow)
  const netRxCard=computeRecentStats(hostSeries('netRx'),WINDOWS.net,cardNow)
  const netTxCard=computeRecentStats(hostSeries('netTx'),WINDOWS.net,cardNow)
  // 取 sparkline 的最近窗口切片（只画窗口内的点）
  function recentSlice(points:DataPoint[],windowMs:number):DataPoint[]{
    const start=cardNow-windowMs
    const out:DataPoint[]=[]
    for(let i=points.length-1;i>=0;i--){
      const p=points[i]
      if(!p||p.ts<start)break
      out.unshift(p)
    }
    return out
  }
  return <section className="space-y-5 text-slate-800" aria-label="运行与日志中心">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-xl font-semibold">运行与日志中心</h1><p className="mt-1 text-sm text-slate-500">设备、服务与故障记录，集中查看。</p></div>
      <div className="flex items-center gap-2">
        <button className={button+' flex items-center gap-2'} onClick={()=>{setSettingsOpen(!settingsOpen);setDraft(summary?.settings??null);setSaveMessage('')}}><Settings2 size={16}/>日志与保留策略</button>
        <button className={button+' flex items-center gap-2 border-red-300 text-red-600 hover:border-red-400 hover:text-red-700'} onClick={()=>{setShutdownOpen(true);setShutdownConfirm('');setShutdownError('')}}><Power size={16}/>安全关机</button>
      </div>
    </header>
    {(error||stale||summary?.applyError)&&<div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{error||summary?.applyError||'采样已长时间未更新，以下为最后已知数据，不代表实时状态。'}</div>}
    {settingsOpen&&<div className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-medium">集中归档策略</h2><p className="mt-1 text-xs text-slate-500">管理本系统脱敏归档。各服务的原始日志按部署时的轮转策略由系统管理；修改这里不会删除录像。</p>
      {draft?<><div className="my-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {([{key:'fileMiB',label:'单个归档文件（MiB）',min:1,max:50},{key:'files',label:'每服务文件总数',min:1,max:5},{key:'historyHours',label:'资源历史（小时）',min:1,max:168},{key:'repeatSeconds',label:'重复日志合并窗口（秒）',min:10,max:300}] as const).map(f=><label key={f.key} className="space-y-1 text-xs text-slate-600">{f.label}<input className={input+' w-full'} type="number" min={f.min} max={f.max} value={draft[f.key]} disabled={saving} onChange={e=>setDraft({...draft,[f.key]:Number(e.target.value)})}/></label>)}
        <label className="space-y-1 text-xs text-slate-600">最低归档级别<select className={input+' w-full'} value={draft.level} disabled={saving} onChange={e=>setDraft({...draft,level:e.target.value})}>{['DEBUG','INFO','WARN','ERROR'].map(v=><option key={v}>{v}</option>)}</select></label>
      </div><div className="flex flex-wrap items-center gap-3"><button className={button} disabled={saving} onClick={()=>void save()}>{saving?'应用中…':'保存并应用'}</button><span className="text-xs text-slate-500">9 个来源最多约 {draft.fileMiB*draft.files*9} MiB；操作审计不受最低级别过滤。缩短保留策略将清理超出的历史归档。</span><span role="status" className="text-sm">{saveMessage}</span></div></>:<p className="mt-3 text-sm text-slate-500">采集助手不可用，暂不能修改策略。</p>}
    </div>}
    {shutdownOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="shutdown-title">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        {shuttingDown ? (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <Power size={24} className="text-red-600 animate-pulse" />
            </div>
            <h2 id="shutdown-title" className="text-lg font-semibold text-slate-800">正在安全关机</h2>
            <p className="text-sm text-slate-500">正在按顺序停止服务，请稍候…设备断电后页面将自动断开。</p>
            {shutdownError && <p className="text-sm text-red-600">{shutdownError}</p>}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
                <Power size={20} className="text-red-600" />
              </div>
              <div>
                <h2 id="shutdown-title" className="text-lg font-semibold text-slate-800">安全关机</h2>
                <p className="text-xs text-slate-500">设备将按顺序停止所有服务后断电</p>
              </div>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-sm font-medium text-red-800">关机顺序</p>
              <ol className="mt-2 space-y-1 text-xs text-red-700">
                <li>1. 停止录像服务（确保录像文件完整关闭）</li>
                <li>2. 停止 AI 识别服务</li>
                <li>3. 系统关机：流媒体服务、控制台与数据库随系统正常关闭，下次开机自动恢复</li>
              </ol>
              <p className="mt-2 text-xs text-red-700">任一步失败会中止关机，并自动恢复已停止的服务，不会出现设备开着却不录像的情况。</p>
            </div>
            <div>
              <label className="text-xs text-slate-600">为确保不是误操作，请输入 <span className="font-semibold text-slate-800">「{SHUTDOWN_CONFIRM_TEXT}」</span> 后确认：</label>
              <input className={input+' mt-2 w-full'} type="text" value={shutdownConfirm}
                onChange={e=>setShutdownConfirm(e.target.value)}
                placeholder="请输入“关机”以确认"
                onKeyDown={e=>{ if(e.key==='Enter' && shutdownConfirm===SHUTDOWN_CONFIRM_TEXT) void doShutdown() }}
              />
            </div>
            {shutdownError && <p className="text-sm text-red-600">{shutdownError}</p>}
            <div className="flex justify-end gap-2">
              <button className={button} onClick={()=>setShutdownOpen(false)} disabled={shuttingDown}>取消</button>
              <button className={button+' border-red-400 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50'}
                disabled={shutdownConfirm !== SHUTDOWN_CONFIRM_TEXT || shuttingDown}
                onClick={()=>void doShutdown()}>
                确认关机
              </button>
            </div>
          </div>
        )}
      </div>
    </div>}
    <nav className="flex gap-1 border-b border-slate-200" aria-label="工作区">
      <button onClick={()=>setParams({})} className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm ${tab==='overview'?'border-blue-600 text-blue-700':'border-transparent text-slate-500'}`}><Activity size={16}/>运行总览</button>
      <button onClick={()=>setParams({tab:'logs'})} className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm ${tab==='logs'?'border-blue-600 text-blue-700':'border-transparent text-slate-500'}`}><FileText size={16}/>日志中心</button>
    </nav>
    {tab==='logs'?<LogViewer initialSource={params.get('source')??''}/>:<>
      <div className="grid gap-4 xl:grid-cols-[1fr_2fr]">
        <div className="rounded-2xl bg-slate-900 p-6 text-white"><p className="text-sm text-slate-300">设备 · 运行概况</p><h2 className="mt-3 text-2xl font-semibold">{!snap?'等待采集':stale?'数据已过期':unhealthy.length?`${unhealthy.length} 个服务需检查`:'核心服务运行正常'}</h2><p className="mt-3 text-sm text-slate-300">{services.length-unhealthy.length} / {services.length} 服务正常 · 最高温度 {snap?.host.temperatureC?.toFixed(1)??'—'}℃</p><p className="mt-4 text-xs leading-5 text-slate-400">先判断整机余量，再比较服务消耗；异常与日志联动，不用在多个页面之间查找。</p></div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            {label:'CPU · 整机利用率',color:'#2563eb',kind:'cpu' as const,unit:'%',stats:cpuCard,sparkPoints:recentSlice(hostSeries('cpu'),WINDOWS.cpu),scale:100,fallback:percent(snap?.host.cpuPercent,2),fallbackRatio:snap?.host.cpuPercent},
            {label:'BPU · 神经网络利用率',color:'#7c3aed',kind:'bpu' as const,unit:'%',stats:bpuCard,sparkPoints:recentSlice(hostSeries('bpu'),WINDOWS.bpu),scale:100,fallback:percent(snap?.host.bpuPercent),fallbackRatio:snap?.host.bpuPercent},
            {label:'内存 · 已用 / 总量',color:'#059669',kind:'memory' as const,unit:'MiB',stats:memCard,sparkPoints:recentSlice(hostSeries('memory'),WINDOWS.memory),scale:undefined,fallback:snap?`${bytes(snap.host.memoryBytes)} / ${bytes(snap.host.memoryTotalBytes)}`:'—',fallbackRatio:snap?100*snap.host.memoryBytes/snap.host.memoryTotalBytes:null},
            {label:'本机磁盘 · 已用 / 总量',color:'#d97706',kind:'disk' as const,unit:'%',stats:diskCard,sparkPoints:recentSlice(hostSeries('diskPct'),WINDOWS.diskPct),scale:100,fallback:snap?`${bytes(snap.host.diskUsedBytes)} / ${bytes(snap.host.diskTotalBytes)}`:'—',fallbackRatio:snap?.host.diskTotalBytes?100*(snap.host.diskUsedBytes??0)/snap.host.diskTotalBytes:null},
          ].map(m=>{
            const isMemory=m.kind==='memory'
            const isDisk=m.kind==='disk'
            const showAvg=m.stats&&m.stats.samples>1
            // 进度条比例：内存是 MiB 绝对值，需换算成占总量的百分比；CPU/BPU/磁盘本身就是百分比
            let ratio:number
            if(showAvg){
              if(isMemory){
                ratio=snap?.host.memoryTotalBytes?(m.stats!.avg*1024**2)/snap.host.memoryTotalBytes*100:0
              }else{
                ratio=m.stats!.avg
              }
            }else{
              ratio=m.fallbackRatio??0
            }
            const mainValue = showAvg
              ? (isMemory
                  ? `${bytes(m.stats!.avg*1024**2)} / ${snap?bytes(snap.host.memoryTotalBytes):'—'}`
                  : isDisk
                    ? `${bytes((m.stats!.avg/100)*(snap?.host.diskTotalBytes??0))} / ${snap?bytes(snap.host.diskTotalBytes):'—'}`
                    : percent(m.stats!.avg,m.kind==='cpu'?2:1))
              : m.fallback
            return <div key={m.label} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-slate-500">{m.label}</p>
                <Sparkline points={m.sparkPoints} color={m.color} scale={m.scale} width={80} height={28}/>
              </div>
              <p className="mt-2 text-lg font-semibold tabular-nums">{mainValue}</p>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full" style={{width:`${Math.min(100,Math.max(0,ratio))}%`,background:m.color}}/></div>
                {showAvg?<span className="text-[11px] text-slate-400 tabular-nums">平均 · {m.stats!.samples}点</span>:<span className="text-[11px] text-slate-400">瞬时</span>}
              </div>
            </div>
          })}
        </div>
      </div>
      <div className="flex flex-wrap justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm">
        <span className="font-medium">物理网卡吞吐</span>
        <span>接收 <strong className="text-blue-600">{netRxCard?`${netRxCard.avg.toFixed(2)}`:snap?net(snap,'rxBytesPerSecond')?.toFixed(2)??'—':'—'} Mbps</strong>{netRxCard&&snap?<span className="text-xs text-slate-400"> · 瞬时 {net(snap,'rxBytesPerSecond')?.toFixed(2)??'—'}</span>:''}</span>
        <span>发送 <strong className="text-violet-600">{netTxCard?`${netTxCard.avg.toFixed(2)}`:snap?net(snap,'txBytesPerSecond')?.toFixed(2)??'—':'—'} Mbps</strong>{netTxCard&&snap?<span className="text-xs text-slate-400"> · 瞬时 {net(snap,'txBytesPerSecond')?.toFixed(2)??'—'}</span>:''}</span>
        <span className="text-xs text-slate-500">{snap?.host.network?.map(n=>n.name).join(' · ')} · 不重复计算内部虚拟网卡</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500"><span>{snap?`最后采样 ${time(snap.ts)} · 主机 ${snap.host.cores} 核 · Swap ${bytes(snap.host.swapBytes)}`:'采集器启动后将显示真实数据'}</span><span>服务 CPU 按在线核心数折算，100% 为整机计算容量；进程树内存为 RSS 汇总。</span></div>
      <div className="grid gap-4 md:grid-cols-2">{(['cpu','memory'] as const).map(kind=><div key={kind} className="rounded-xl border border-slate-200 bg-white p-4"><h2 className="text-sm font-medium">{kind==='cpu'?'CPU 消耗对比 · 占整机计算容量':'内存消耗对比 · 占物理总量'}</h2><div className="mt-4 space-y-3">{[...services].sort((a,b)=>(kind==='cpu'?b.cpuPercent??-1:b.memoryBytes??-1)-(kind==='cpu'?a.cpuPercent??-1:a.memoryBytes??-1)).map(s=>{
        const value=kind==='cpu'?wholeHostCpu(s.cpuPercent,snap?.host.cores):(s.memoryBytes===null?null:100*s.memoryBytes/(snap?.host.memoryTotalBytes||1))
        return <button key={s.id} className="grid w-full grid-cols-[90px_1fr_64px] items-center gap-3 text-left text-xs hover:text-blue-600" onClick={()=>setMetricService(s.id)} title="查看该服务资源历史"><span>{names[s.id]}</span><span className="h-2 overflow-hidden rounded bg-slate-100"><span className={`block h-full rounded ${kind==='cpu'?'bg-blue-500':'bg-emerald-500'}`} style={{width:`${Math.min(100,Math.max(0,value??0))}%`}}/></span><span className="text-right tabular-nums">{kind==='cpu'?percent(value,2):bytes(s.memoryBytes)}</span></button>
      })}</div><p className="mt-3 text-xs text-slate-400">{kind==='cpu'?'统一换算为整机 100%，点击服务查看下方历史。':'原生服务 RSS 与容器工作集口径不同，不相加冒充整机用量。'}</p></div>)}</div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr>{['服务','状态','CPU（整机）','内存','连接数','关键状态','日志'].map(t=><th key={t} className="px-4 py-3 font-medium">{t}</th>)}</tr></thead><tbody>
        {services.map(s=><tr key={s.id} className="border-t border-slate-100"><td className="whitespace-nowrap px-4 py-4 font-medium">{names[s.id]??s.id}</td><td className="px-4 py-4"><span className={`inline-flex rounded-full px-2 py-1 text-xs ${stale?'bg-slate-100 text-slate-500':s.healthy?'bg-emerald-50 text-emerald-700':'bg-amber-50 text-amber-800'}`}>{stale?'已过期':s.healthy?'运行正常':s.state==='unknown'?'未知':s.state==='active'?'需检查':'未运行'}</span></td><td className="px-4 tabular-nums">{percent(wholeHostCpu(s.cpuPercent,snap?.host.cores),2)}</td><td className="px-4 tabular-nums">{bytes(s.memoryBytes)}</td><td className="px-4 tabular-nums">{s.connections??'—'}</td><td className="max-w-xs px-4 text-xs text-slate-500">{s.id==='alarm-service'?<AlarmServiceStatusCard/>:s.id==='llm-service'?<LlmServiceStatusCard/>:s.detail||'—'}{s.oomKilled&&<span className="ml-2 text-red-600">OOM</span>}{s.restarts?` · 重启 ${s.restarts} 次`:''}</td><td className="px-4"><button className="whitespace-nowrap text-blue-600 hover:underline" onClick={()=>setParams({tab:'logs',source:s.id})}>查看日志</button></td></tr>)}
        {!services.length&&<tr><td colSpan={7} className="p-10 text-center text-slate-400">{error?'无法获取服务状态':'正在采集服务状态…'}</td></tr>}
      </tbody></table></div>
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <StorageVolumes />
          <div><h2 className="font-medium">资源历史</h2><p className="mt-1 text-xs text-slate-500">持续展示 CPU、内存、BPU、磁盘和网络趋势，避免只依赖瞬时值判断系统状态。</p></div>
          <div className="flex flex-wrap items-center gap-2"><select aria-label="资源服务" className={input} value={metricService} onChange={e=>setMetricService(e.target.value)}><option value="host">设备主机</option>{services.map(s=><option key={s.id} value={s.id}>{names[s.id]}</option>)}</select><select aria-label="历史周期" className={input} value={hours} onChange={e=>setHours(Number(e.target.value))}>{[1,6,24,72,168].map(v=><option key={v} value={v}>最近 {v} 小时</option>)}</select></div>
        </div>
        <div className="space-y-4 p-4 sm:p-5">
          {historyError&&<p role="alert" className="text-sm text-amber-700">历史读取失败：{historyError}</p>}
          <div className="grid gap-4 lg:grid-cols-3"><Curve range={chartRange} title={`${names[metricService]} CPU · 占整机`} points={values('cpu')} digits={2} unit="%" color="#2563eb"/><Curve range={chartRange} title={`${names[metricService]} 内存`} points={values('memory')} unit="MiB" color="#059669"/><Curve range={chartRange} title="整机 BPU 利用率" points={values('bpu')} unit="%" color="#7c3aed"/><Curve range={chartRange} title="本机磁盘使用率" points={history.map(p=>({ts:p.ts,value:p.host.diskTotalBytes?100*(p.host.diskUsedBytes??0)/p.host.diskTotalBytes:null}))} unit="%" color="#d97706"/><Curve scale={networkScale} range={chartRange} title="网络接收" points={history.map(p=>({ts:p.ts,value:net(p,'rxBytesPerSecond')}))} unit="Mbps" color="#2563eb"/><Curve scale={networkScale} range={chartRange} title="网络发送" points={history.map(p=>({ts:p.ts,value:net(p,'txBytesPerSecond')}))} unit="Mbps" color="#7c3aed"/></div>
          <p className="text-xs text-slate-500">历史保存在设备本地，刷新页面不会丢失；采集停止或尚无 BPU 数据的时段不补零。BPU 展示整机神经网络负载，不按服务分摊。</p>
        </div>
      </section>
    </>}
  </section>
}
