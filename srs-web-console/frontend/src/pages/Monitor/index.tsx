import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronLeft, ChevronRight, GripVertical, History, Maximize2, X } from 'lucide-react'
import { VideoPlayer } from '@/components/player/VideoPlayer'
import { Toaster } from '@/components/ui/Toaster'
import { toast } from '@/store/toast'
import { useMonitorStore } from '@/store/monitor'
import { useSettingsStore } from '@/store/settings'
import { LAYOUT_CAPACITY, MONITOR_LAYOUTS, gridClassFor } from '@/utils/monitorLayout'
import { useMonitorCatalog } from './useMonitorCatalog'
import { isH265 } from '@/utils/codec'
import {ArmingLauncher} from '@/pages/AlarmCenter/ArmingLauncher'
import type {ChannelWithStatus} from '@/types/channel'

const button = 'rounded-base border border-line bg-surface px-3 py-2 text-xs text-ink-subtle hover:bg-primary-50 disabled:opacity-40'

export default function MonitorPage() {
  const navigate = useNavigate()
  const catalogue = useMonitorCatalog()
  const { allChannels, outputIds, variants, ready, error } = catalogue
  const state = useMonitorStore()
  const { layout, slots, page, hardLimit, focusedChannelId } = state
  const { settings, fetchSettings } = useSettingsStore()
  const [search, setSearch] = useState('')
  const [arming,setArming]=useState<{channel:ChannelWithStatus;processorId:string;outputName:string;video:HTMLVideoElement}|null>(null)
  const zoneChannelId=arming?.channel.id??null
  const outputs = state.selectedOutputs
  const [moving, setMoving] = useState<number | null>(null)
  const dragFrom = useRef<number | null>(null)
  const softWarned = useRef(false)
  const defaults = useMemo(() => allChannels.map(c => c.id), [allChannels])
  const byId = useMemo(() => new Map(allChannels.map(c => [c.id, c])), [allChannels])
  useEffect(() => { void fetchSettings() }, [fetchSettings])
  useEffect(() => { if (settings) state.setHardLimit(settings.monitorHardLimit) }, [settings, state.setHardLimit])
  useEffect(() => { if (ready) state.initialize(defaults) }, [ready, defaults, state.initialize])
  const capacity = LAYOUT_CAPACITY[layout]
  const start = page * capacity
  const pageSlots = slots.slice(start, start + capacity)
  const pageCount = Math.max(1, Math.ceil(slots.length / capacity))
  const chosenOutput = (id: string) => Object.hasOwn(outputs, id) ? outputs[id]! : id
  const resolved = (id: string) => {
    const selected = chosenOutput(id)
    // Keep an invalid saved choice explicit; never silently play a different source.
    if (selected !== id && !variants.get(id)?.some(c => c.id === selected)) return undefined
    return byId.get(selected)
  }
  // Only mounted players consume connections. Offline/deleted slots never reshuffle the catalogue.
  const playable = pageSlots.filter((id): id is string => !!id && !!resolved(id)?.status.online)
  const active = new Set(settings ? playable.slice(0, hardLimit) : [])
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
  const focus = focusedChannelId ? resolved(focusedChannelId) : undefined
  const used = slots.filter(Boolean).length
  const filtered = allChannels.filter(c => `${c.name} ${c.upstream.app}/${c.upstream.stream}`.toLowerCase().includes(search.toLowerCase()))

  function arrange() {
    if (!ready) { toast.info('接入通道尚未加载完成，请稍后重试'); return }
    state.arrange(defaults)
    setMoving(null)
  }
  function move(to: number) {
    const from = dragFrom.current ?? moving
    if (from !== null) state.swap(from, to)
    dragFrom.current = null
    setMoving(null)
  }
  function player(id: string) {
    const c = resolved(id)
    if (!c) return <div className="p-4 text-center text-sm text-slate-300">通道暂不可用，位置已保留</div>
    if (!c.status.online) return <div className="p-4 text-center text-sm text-slate-300">{c.name} · 离线</div>
    if (!settings) return <div className="p-4 text-center text-sm text-slate-300">正在读取监看上限，请稍候</div>
    const processorId=outputIds.get(`${c.upstream.app}/${c.upstream.stream}`)
    const parents=processorId?allChannels.filter(source=>variants.get(source.id)?.some(output=>output.id===c.id)):[]
    const original=parents.length===1?parents[0]:undefined
    const zoneSource=processorId&&original&&original.registered!==false?{id:original.id,processorId,updatedAt:original.updatedAt,createdAt:original.createdAt,inputGeneration:original.inputGeneration}:undefined
    return <VideoPlayer key={c.id} title="" protocols={c.downstream.protocols} primary={c.downstream.primary}
      savedZoneSource={zoneSource} compactZones={focusedChannelId!==id}
      onArming={zoneSource&&original&&processorId?video=>setArming({channel:original,processorId,outputName:c.name,video}):undefined}
      stream={{ host: window.location.hostname, app: c.upstream.app, stream: c.upstream.stream }}
      muted allowPanorama className="h-full w-full" aiChannelId={outputIds.get(`${c.upstream.app}/${c.upstream.stream}`)}
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
    <aside className="ui-panel flex max-h-52 shrink-0 flex-col md:max-h-none md:w-52 xl:w-60">
      <div className="border-b border-line p-3"><h2 className="text-sm font-semibold">通道列表</h2>
        <input aria-label="搜索监看通道" className="form-input mt-2" placeholder="搜索通道…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2"><ul className="space-y-1">
        {filtered.map(c => {
          const index = slots.indexOf(c.id)
          const isOutput = outputIds.has(`${c.upstream.app}/${c.upstream.stream}`)
          return <li key={c.id}><button className={`flex w-full items-center gap-2 rounded-base p-2 text-left text-sm ${index >= 0 ? 'bg-primary-50 text-primary-600' : 'text-ink-subtle hover:bg-surface-page'}`}
            title={index >= 0 ? `${c.name}：定位到第 ${Math.floor(index / capacity) + 1} 页` : `${c.name}：加入监看`}
            disabled={!!zoneChannelId} data-testid={`monitor-item-${c.id}`} onClick={() => { if (focusedChannelId) state.enterFocus(c.id); else if (!state.add(c.id)) toast.error('监看排列已达到容量上限') }}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${c.status.online ? 'bg-success' : 'bg-ink-faint'}`} />
            <span className="min-w-0 flex-1 truncate">{c.name}{isOutput && <span className="ml-1 text-xs">AI</span>}</span>
            {index >= 0 && <span className="text-xs tabular-nums">{index + 1}</span>}
          </button></li>
        })}
      </ul>{!filtered.length && <p className="p-3 text-xs text-ink-subtle">{ready ? '没有匹配的通道' : '正在加载通道…'}</p>}</div>
      <p className="border-t border-line p-3 text-xs leading-5 text-ink-subtle">恢复通道顺序会按本列表顺序安排全部通道，超出一页自动分页。已加入的通道点击定位，移除请使用画面右上角。</p>
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="monitor-title" className="page-title">实时监看</h1>
        {focusedChannelId ? <button className={button} disabled={!!zoneChannelId} onClick={state.exitFocus} data-testid="focus-back"><ArrowLeft size={14} className="mr-1 inline" />返回宫格</button> :
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="监看布局" className="flex items-center gap-1 rounded-base border border-line bg-surface p-1">
              {MONITOR_LAYOUTS.map(l => <button key={l} type="button" aria-label={`${LAYOUT_CAPACITY[l]} 宫格`} aria-pressed={layout === l}
                className={`min-h-11 min-w-11 rounded px-2 text-sm font-medium transition-colors ${layout === l ? 'bg-primary text-white' : 'text-ink-subtle hover:bg-primary-50'}`}
                onClick={() => { setMoving(null); state.setLayout(l) }}>{LAYOUT_CAPACITY[l]}</button>)}
            </div>
            <button className={button} disabled={!ready} onClick={() => arrange()}>恢复通道顺序</button>
            <button className={button} onClick={() => { state.clear(); setMoving(null) }}>清空监看</button>
          </div>}
      </header>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-subtle">
        <span data-testid="monitor-usage">已安排 {used} 路 · 本页可播放 {focusedChannelId ? (focus?.status.online && settings ? 1 : 0) : active.size} 路 · 并发上限 {settings ? hardLimit : '读取中'}</span>
        {!focusedChannelId && <div className="flex items-center gap-2"><button aria-label="上一页" className={button} disabled={page === 0} onClick={() => { state.setPage(page - 1); setMoving(null) }}><ChevronLeft size={14} /></button>
          <span>第 {page + 1} / {pageCount} 页</span><button aria-label="下一页" className={button} disabled={page + 1 >= pageCount} onClick={() => { state.setPage(page + 1); setMoving(null) }}><ChevronRight size={14} /></button></div>}
      </div>
      {(error || state.persistenceUnavailable || !settings) && <p role="status" className="rounded-base bg-amber-50 p-3 text-xs text-amber-800">{error || (state.persistenceUnavailable ? '浏览器无法保存布局，本次调整仅在当前会话有效。' : '监看参数尚未就绪，暂不建立播放连接。')} {!settings && <button className="underline" onClick={() => void fetchSettings()}>重试读取</button>}</p>}
      {!focusedChannelId && playable.length > hardLimit && <p className="text-xs text-amber-800">超出并发上限的画面暂不播放；可切换较小宫格分页查看，或单独放大。</p>}
      {heavyH265 >= 2 && <p role="note" className="text-xs text-amber-800">本页有 {heavyH265} 路 4K H.265 同时播放，受本机硬件解码路数限制可能卡顿或黑屏；卡顿时请减少宫格路数或单独放大。</p>}
      {moving !== null && <p role="status" className="text-xs text-primary-600">已选位置 {moving + 1}，点击目标位置的“放到这里”完成交换。<button className="ml-2 underline" onClick={() => setMoving(null)}>取消</button></p>}
      {focusedChannelId ? <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel bg-slate-950">
        <div className="flex shrink-0 items-center justify-between gap-2 p-3 text-white"><span data-testid="focus-title">{focus?.name ?? byId.get(focusedChannelId)?.name ?? '通道暂不可用'}</span><div className="flex items-center gap-2">{!zoneChannelId&&variantSelect(focusedChannelId)}<button aria-label="关闭聚焦画面" disabled={!!zoneChannelId} onClick={state.closeFocus} data-testid="focus-close"><X size={16} /></button></div></div>
        <div className="relative flex min-h-0 flex-1 items-center justify-center">{player(focusedChannelId)}</div>
      </div> : <div className={`grid min-h-0 flex-1 gap-2 ${gridClassFor(layout)}`} data-testid="monitor-grid">
        {pageSlots.map((id, offset) => {
          const index = start + offset
          const c = id ? resolved(id) : undefined
          const aiId = c && outputIds.get(`${c.upstream.app}/${c.upstream.stream}`)
          return <div key={`${index}:${id ?? 'empty'}`} data-slot-index={index} onDragOver={e => { if (dragFrom.current !== null) e.preventDefault() }} onDrop={e => { e.preventDefault(); move(index) }}
            className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-panel border ${moving === index ? 'border-primary ring-2 ring-primary/30' : 'border-line'} bg-slate-950`}>
            <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1 px-2 py-1 text-xs text-white">
              <span className="min-w-0 flex-1 truncate" title={c?.name}>{index + 1} · {c?.name ?? (id ? byId.get(id)?.name ?? '通道暂不可用' : '空位')}</span>
              {id && <>
                {variantSelect(id)}
                <button draggable aria-label={`移动位置 ${index + 1}`} title="拖动换位，或点击后选择目标位置" onDragStart={e => { dragFrom.current = index; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(index)) }} onDragEnd={() => { dragFrom.current = null }} onClick={() => setMoving(index)}><GripVertical size={15} /></button>
                {aiId && <button aria-label="识别历史" onClick={() => navigate(`/recognition-history/${aiId}`)}><History size={14} /></button>}
                <button aria-label={`放大 ${c?.name ?? '通道'}`} data-testid={`slot-focus-${index}`} onClick={() => state.enterFocus(id)}><Maximize2 size={14} /></button>
                <button aria-label={`移除位置 ${index + 1}`} data-testid={`slot-remove-${index}`} onClick={() => state.remove(index)}><X size={15} /></button>
              </>}
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center" data-testid={`slot-tile-${index}`} onDoubleClick={e => { if (id && !(e.target as HTMLElement).closest('button,select,input')) state.enterFocus(id) }}>
              {id ? active.has(id) ? player(id) : <p className="p-3 text-center text-xs text-slate-300">{!c ? '通道暂不可用，位置已保留' : !c.status.online ? '通道离线，位置已保留' : !settings ? '等待读取监看上限' : '并发上限已达 · 可单独放大'}</p> : <p className="p-3 text-center text-xs text-slate-400">从左侧选择通道</p>}
            </div>
            {moving !== null && <button className="absolute inset-0 z-20 bg-primary/80 text-sm text-white" onClick={() => move(index)}>放到这里 · {index + 1}</button>}
          </div>
        })}
      </div>}
      <p className="text-xs leading-5 text-ink-subtle">仅播放当前页；放大时释放其他连接。双击画面放大，拖动手柄交换位置。布局保存在当前浏览器，新增通道不会挤动已有画面。</p>
    </div>
    {arming&&<ArmingLauncher outputName={arming.outputName} processorId={arming.processorId} channel={arming.channel} video={arming.video} onClose={()=>setArming(null)} onSaved={()=>{toast.success("布防已保存，应用状态将在配置同步后更新");window.dispatchEvent(new Event("ainvr-arming-saved"))}}/>}
    <Toaster />
  </section>
}
