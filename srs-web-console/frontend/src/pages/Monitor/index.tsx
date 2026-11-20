import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, History, Maximize2, X } from 'lucide-react'
import { VideoPlayer } from '@/components/player/VideoPlayer'
import { Toaster } from '@/components/ui/Toaster'
import { toast } from '@/store/toast'
import { useMonitorStore } from '@/store/monitor'
import { useSettingsStore } from '@/store/settings'
import { autoMonitorCapacity } from './autoLayout'
import { useMonitorCatalog } from './useMonitorCatalog'
import {usePtzCatalog} from './usePtzCatalog'
import {PtzPanel} from '@/components/player/PtzPanel'
import { isH265 } from '@/utils/codec'
import {ArmingLauncher} from '@/pages/AlarmCenter/ArmingLauncher'
import type {ChannelWithStatus} from '@/types/channel'
import { buildMonitorSources, type MonitorSource } from '@/utils/monitorSource'

const button = 'rounded-base border border-line bg-surface px-3 py-2 text-xs text-ink-subtle hover:bg-primary-50 disabled:opacity-40'

function SourceLabel({ value }: { value?: MonitorSource }) {
  if (!value) return null
  return <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-4 text-slate-300" title={value.detail} aria-label={value.detail}>
    <span className="shrink-0 rounded bg-slate-800 px-1 font-medium text-slate-200">{value.protocol}</span>
    <span className="truncate">{value.text}</span>
  </div>
}

export default function MonitorPage() {
  const navigate = useNavigate()
  const [params]=useSearchParams()
  const requestedPtz=params.get('ptz'),handledPtz=useRef<string|null>(null)
  const catalogue = useMonitorCatalog()
  const ptzCandidates=usePtzCatalog()
  const [ptz,setPtz]=useState<{slot:string;channel:string}|null>(null)
  const { allChannels, outputIds, variants, gbBindings, ready, error } = catalogue
  const sourceInfo = useMemo(() => buildMonitorSources(allChannels, outputIds, variants, gbBindings), [allChannels, outputIds, variants, gbBindings])
  const state = useMonitorStore()
  const { hardLimit, focusedChannelId } = state
  const { settings, fetchSettings } = useSettingsStore()
  const [search, setSearch] = useState('')
  const [arming,setArming]=useState<{channel:ChannelWithStatus;processorId:string;outputName:string;video:HTMLVideoElement}|null>(null)
  const zoneChannelId=arming?.channel.id??null
  const outputs = state.selectedOutputs
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [visibleIds, setVisibleIds] = useState<Set<string> | null>(null)
  const [gridWidth, setGridWidth] = useState(960)
  const softWarned = useRef(false)
  const defaults = useMemo(() => allChannels.map(c => c.id), [allChannels])
  const byId = useMemo(() => new Map(allChannels.map(c => [c.id, c])), [allChannels])
  useEffect(() => { void fetchSettings() }, [fetchSettings])
  useEffect(() => { if (settings) state.setHardLimit(settings.monitorHardLimit) }, [settings, state.setHardLimit])
  const capacity = autoMonitorCapacity(defaults.length)
  const slots: (string | null)[] = Array.from({ length: capacity }, (_, i) => defaults[i] ?? null)
  const catalogueKey = defaults.join('\n')
  useEffect(() => {
    if (!ready) return
    // Persist source choices against the current catalogue, including newly added channels.
    // Legacy manual slots no longer determine the visible grid.
    useMonitorStore.setState({ slots: Array.from({ length: capacity }, (_, i) => defaults[i] ?? null), initialized: true, page: 0 })
  }, [ready, catalogueKey, capacity])
  useEffect(() => {
    if (ready && focusedChannelId && !byId.has(focusedChannelId)) state.exitFocus()
  }, [ready, focusedChannelId, byId, state.exitFocus])
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    setVisibleIds(null)
    const resize = () => setGridWidth(grid.clientWidth || 960)
    resize()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    ro?.observe(grid)
    const seen = new Set<string>()
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.channelId!
        if (entry.isIntersecting && entry.intersectionRatio >= 0.25) seen.add(id)
        else seen.delete(id)
      }
      setVisibleIds(new Set(seen))
    }, { root: grid, threshold: [0, 0.25] })
    grid.querySelectorAll('[data-channel-id]').forEach(tile => observer?.observe(tile))
    return () => { ro?.disconnect(); observer?.disconnect() }
  }, [catalogueKey, focusedChannelId])
  const columns = Math.max(1, Math.min(Math.ceil(Math.sqrt(capacity)), Math.floor((gridWidth + 6) / 208)))
  const chosenOutput = (id: string) => Object.hasOwn(outputs, id) ? outputs[id]! : id
  const resolved = (id: string) => {
    const selected = chosenOutput(id)
    // Keep an invalid saved choice explicit; never silently play a different source.
    if (selected !== id && !variants.get(id)?.some(c => c.id === selected)) return undefined
    return byId.get(selected)
  }
  // Only mounted players consume connections. Offline/deleted slots never reshuffle the catalogue.
  const playable = slots.filter((id): id is string => !!id && !!resolved(id)?.status.online)
  const active = new Set(settings ? playable.filter(id => visibleIds === null || visibleIds.has(id)).slice(0, hardLimit) : [])
  const softLimit = settings?.monitorSoftLimit ?? 6
  useEffect(() => {
    if (!focusedChannelId && active.size > softLimit && !softWarned.current) {
      softWarned.current = true
      toast.info(`当前播放超过建议的 ${softLimit} 路，请留意解码和网络负载。`)
    }
  }, [active.size, softLimit, focusedChannelId])
  // 客户端解码才是多路 4K 的真实瓶颈（测试 PC 解 1 路 4K 约 10fps，264/265 相同），
  // H.265 还常只能走硬解、硬解路数有限：同屏 ≥2 路 4K H.265 时提示（设计 §8.4②）
  const heavyH265 = focusedChannelId ? 0 : [...active].filter(id => {
    const s = resolved(id)?.status
    return !!s && isH265(s.videoCodec) && (s.videoWidth ?? 0) * (s.videoHeight ?? 0) >= 3840 * 1920
  }).length
  useEffect(()=>{
    if(!ready||!requestedPtz||handledPtz.current===requestedPtz||!byId.has(requestedPtz))return
    handledPtz.current=requestedPtz
    state.enterFocus(requestedPtz)
    const channel=Object.hasOwn(outputs,requestedPtz)?outputs[requestedPtz]!:requestedPtz
    setPtz({slot:requestedPtz,channel})
  },[ready,requestedPtz,byId,outputs,state.enterFocus])
  const focus = focusedChannelId ? resolved(focusedChannelId) : undefined
  const focusProcessor = focus && outputIds.get(`${focus.upstream.app}/${focus.upstream.stream}`)
  const used = slots.filter(Boolean).length
  const filtered = allChannels.filter(c => `${c.name} ${c.upstream.app}/${c.upstream.stream}`.toLowerCase().includes(search.toLowerCase()))

  function player(id: string) {
    const c = resolved(id)
    if (!c) return <div className="p-4 text-center text-sm text-slate-300">通道暂不可用，位置已保留</div>
    const processorId=outputIds.get(`${c.upstream.app}/${c.upstream.stream}`)
    const single = focusedChannelId === id
    const togglePtz = () => {
      if (ptz?.slot === id && ptz.channel === c.id) { setPtz(null); return; }
      if (focusedChannelId !== id) state.enterFocus(id);
      setPtz({slot:id,channel:c.id});
    };
    if (!c.status.online) return <div className="flex h-full min-h-0 flex-col"><div className="flex flex-1 items-center justify-center gap-3 p-4 text-center text-sm text-slate-300">{c.name} · 离线{ptzCandidates.has(c.id)&&<button className={button} onClick={togglePtz}>云台状态</button>}</div>{ptz?.slot===id&&ptz.channel===c.id&&<PtzPanel channelId={c.id} isAiOutput={!!processorId} onClose={()=>setPtz(null)}/>}</div>
    if (!settings) return <div className="p-4 text-center text-sm text-slate-300">正在读取监看上限，请稍候</div>
    const parents=processorId?allChannels.filter(source=>variants.get(source.id)?.some(output=>output.id===c.id)):[]
    const original=parents.length===1?parents[0]:undefined
    const zoneSource=processorId&&original&&original.registered!==false?{id:original.id,processorId,updatedAt:original.updatedAt,createdAt:original.createdAt,inputGeneration:original.inputGeneration}:undefined
    return <VideoPlayer key={c.id} title="" protocols={c.downstream.protocols} primary={c.downstream.primary}
      overviewTile={!single}
      showControls={single}
      talkChannel={single && ((original ?? c).onvif || gbBindings?.some(b => b.input_id === (original ?? c).id)) ? (original ?? c).id : undefined}
      ptz={single && ptzCandidates.has(c.id)?{channelId:c.id,open:ptz?.slot===id&&ptz.channel===c.id,onToggle:togglePtz}:undefined}
      savedZoneSource={zoneSource} compactZones={focusedChannelId!==id}
      onArming={single&&zoneSource&&original&&processorId?video=>setArming({channel:original,processorId,outputName:c.name,video}):undefined}
      stream={{ host: window.location.hostname, app: c.upstream.app, stream: c.upstream.stream }}
      muted allowPanorama className="h-full w-full" aiChannelId={processorId}
      videoInfo={{ codec: c.status.videoCodec, level: c.status.videoLevel, width: c.status.videoWidth, height: c.status.videoHeight }}
      diagLabel={`${c.upstream.app}/${c.upstream.stream}`} />
  }
  function variantSelect(id: string) {
    const options = variants.get(id) ?? []
    const selected = chosenOutput(id)
    const invalid = selected !== id && !options.some(c => c.id === selected)
    if (!options.length && !invalid) return null
    return <select aria-label={`播放来源 ${byId.get(id)?.name ?? id}`} className="max-w-36 rounded bg-white/10 px-1 py-1 text-xs text-white" value={selected}
      onChange={e => state.selectOutput(id, e.target.value)}>
      <option className="text-ink" value={id}>原始视频</option>
      {invalid && <option className="text-ink" value={selected} disabled>已保存的 AI 输出不可用</option>}
      {options.map(c => <option className="text-ink" key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  }
  return <section aria-labelledby="monitor-title" className="flex h-full min-h-0 flex-col gap-4 md:flex-row">
    <aside className="ui-panel flex max-h-52 shrink-0 flex-col md:max-h-none md:w-44 xl:w-52">
      <div className="border-b border-line p-3"><h2 className="text-sm font-semibold">通道列表</h2>
        <input aria-label="搜索监看通道" className="form-input mt-2" placeholder="搜索通道…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2"><ul className="space-y-1">
        {filtered.map(c => {
          const index = slots.indexOf(c.id)
          const isOutput = outputIds.has(`${c.upstream.app}/${c.upstream.stream}`)
          return <li key={c.id}><button className="channel-choice flex w-full items-center gap-2 rounded-base p-2 text-left text-sm"
            aria-current={focusedChannelId === c.id ? true : undefined}
            title={`${c.name}：放大查看`}
            disabled={!!zoneChannelId} data-testid={`monitor-item-${c.id}`} onClick={() => state.enterFocus(c.id)}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${c.status.online ? 'bg-success' : 'bg-ink-faint'}`} />
            <span className="min-w-0 flex-1 truncate">{c.name}{isOutput && <span className="ml-1 text-xs">AI</span>}</span>
            {index >= 0 && <span className="text-xs tabular-nums">{index + 1}</span>}
          </button></li>
        })}
      </ul>{!filtered.length && <p className="p-3 text-xs text-ink-subtle">{ready ? '没有匹配的通道' : '正在加载通道…'}</p>}</div>
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 id="monitor-title" className="page-title">实时监看</h1>
        <span className="text-xs text-ink-subtle" data-testid="monitor-usage">共 {used} 路 · 自动 {capacity} 宫格 · {focusedChannelId ? (focus?.status.online && settings ? 1 : 0) : active.size} 路播放中</span>
        {focusedChannelId && <button className={button + ' ml-auto'} disabled={!!zoneChannelId} onClick={state.exitFocus} data-testid="focus-back"><ArrowLeft size={14} className="mr-1 inline" />返回总览</button>}
      </header>
      {(error || state.persistenceUnavailable || !settings) && <p role="status" className="rounded-base bg-amber-50 p-3 text-xs text-amber-800">{error || (state.persistenceUnavailable ? '浏览器无法保存播放来源选择，本次选择仅在当前会话有效。' : '监看参数尚未就绪，暂不建立播放连接。')} {!settings && <button className="underline" onClick={() => void fetchSettings()}>重试读取</button>}</p>}
      {!focusedChannelId && playable.length > hardLimit && <p className="text-xs text-amber-800">优先播放可见画面，滚动时自动释放屏外连接；点击画面可单路查看。</p>}
      {heavyH265 >= 2 && <p role="note" className="text-xs text-amber-800">当前有 {heavyH265} 路 4K H.265 同时播放，受本机硬件解码路数限制可能卡顿或黑屏；可单独放大查看。</p>}
      {focusedChannelId ? <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel bg-slate-950">
        <div className="flex shrink-0 items-center justify-between gap-2 p-3 text-white"><div className="min-w-0 flex-1"><span className="block truncate" data-testid="focus-title">{focus?.name ?? byId.get(focusedChannelId)?.name ?? '通道暂不可用'}</span><SourceLabel value={focus && sourceInfo.get(focus.id)} /></div><div className="flex shrink-0 items-center gap-2">{focusProcessor && !zoneChannelId && <button aria-label="识别历史" title="识别历史" className="p-2" onClick={() => navigate(`/recognition-history/${focusProcessor}`)}><History size={16} /></button>}{!zoneChannelId&&variantSelect(focusedChannelId)}<button aria-label="关闭聚焦画面" disabled={!!zoneChannelId} onClick={state.exitFocus} data-testid="focus-close"><X size={16} /></button></div></div>
        <div className="relative flex min-h-0 flex-1 items-center justify-center">{player(focusedChannelId)}</div>
      </div> : <div ref={gridRef} className="grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} data-testid="monitor-grid">
        {slots.map((id, index) => {
          const c = id ? resolved(id) : undefined
          const name = c?.name ?? (id ? byId.get(id)?.name ?? '通道暂不可用' : '空位')
          const status = !id ? '暂无通道' : !c ? '来源不可用' : !c.status.online ? '离线' : !settings ? '等待读取监看上限' : '点击单路查看'
          return <div key={id ?? `empty:${index}`} data-channel-id={id ?? undefined} data-slot-index={index}
            className="relative isolate aspect-video min-w-0 overflow-hidden rounded-base bg-slate-950">
            <div className="absolute inset-0 flex items-center justify-center" data-testid={`slot-tile-${index}`}>
              {id && active.has(id) ? player(id) : <span className="text-xs text-slate-400">{status}</span>}
            </div>
            {id && <button type="button" aria-label={`放大 ${name}`} title={`放大 ${name}`} data-testid={`slot-focus-${index}`}
              className="group/wall absolute inset-0 z-30 text-white focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-400"
              onClick={() => state.enterFocus(id)}>
              <span className="absolute bottom-1 left-1 max-w-[calc(100%-0.5rem)] truncate rounded bg-black/65 px-1.5 py-0.5 text-left text-[11px] leading-4">
                <span className="mr-1.5 tabular-nums text-white/75">{index + 1}</span>{name}
              </span>
              <span className="absolute right-1 top-1 rounded bg-black/60 p-1 opacity-0 group-hover/wall:opacity-100 group-focus-visible/wall:opacity-100 [@media(hover:none)]:opacity-100">
                <Maximize2 size={14} aria-hidden="true" />
              </span>
            </button>}
          </div>
        })}
      </div>}
    </div>
    {arming&&<ArmingLauncher outputName={arming.outputName} processorId={arming.processorId} channel={arming.channel} video={arming.video} onClose={()=>setArming(null)} onSaved={()=>{toast.success("布防已保存，应用状态将在配置同步后更新");window.dispatchEvent(new Event("ainvr-arming-saved"))}}/>}
    <Toaster />
  </section>
}
