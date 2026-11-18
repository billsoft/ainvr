import { Download, Eye, Hand, ImagePlus, Minus, MousePointer2, PenLine, Plus, Redo2, RotateCcw, Slash, Square, Trash2, Type, Undo2, Upload, X, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'
import { useDiscardConfirmation } from '@/components/modals/useDiscardConfirmation'
import { segment, segmented } from '@/components/ui/filterStyles'
import { CardMenu } from '@/pages/Flow/CardMenu'
import { PlanCanvas, type PlanTool, type PlanCanvasProps, type PlanView } from './PlanCanvas'
import {
  PLAN_H, PLAN_W, activePlan, addPlan, addShape, emptyDraft, groupByCounter, heatCells, isPlaced, placeAll, placeZone, plansOfZone, removePlan, removeShape,
  renamePlan, setActive, setImage, setPlacement, unplaceZone, unresolvedPlacementKeys, updateActive, updateShape, type NewShape, type Placement, type Plan, type PlanDraft, type ZoneInfo,
} from './planModel'
import { loadDraft, readImage, saveDraft } from './planStorage'

const quiet = 'inline-flex !min-h-9 items-center justify-center gap-1.5 rounded-base px-2 text-sm text-ink-subtle hover:bg-surface-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:!min-h-11'
const small = 'btn-secondary !min-h-8 !px-2.5 !py-1 text-xs [@media(pointer:coarse)]:!min-h-11'
const numberField = 'form-input !py-1 text-xs tabular-nums'
const toggle = segment + ' !min-h-8 !px-2.5 text-xs [@media(pointer:coarse)]:!min-h-11'
const FIT: PlanView = { zoom: 1, x: 0, y: 0 }
const GRID = 20
const toolList: [PlanTool, string, string, LucideIcon, string][] = [
  ['select', '选择', 'V', MousePointer2, '点选或拖动热区和图形'],
  ['pan', '平移', 'H', Hand, '拖动画布；按住空格也可临时平移'],
  ['room', '房间', 'R', Square, '按住拖出一个房间'],
  ['line', '墙线', 'L', Slash, '拖出一段墙线；从已有端点开始会自动接上'],
  ['label', '文字', 'T', Type, '点一下放置文字'],
]
const hints: Record<PlanTool, string> = {
  select: '点选热区或图形查看属性；拖动只改摆放位置，不影响计数和检测范围。',
  pan: '拖动画布平移，滚轮或双指缩放。',
  room: '按住拖出一个房间，松开后自动选中，可在右侧改名。',
  line: '拖出一段墙线；从已有墙线端点开始会自动接上。按 Esc 结束。',
  label: '在画布上点一下放置文字，然后在右侧改内容。',
}
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
interface Props { context?: 'flow' | 'alarm'; zones: ZoneInfo[]; counters: { id: string; name: string }[]; counts: Record<string, number>; countLabel?: string; sourceHeat?:PlanCanvasProps['sourceHeat']; onClose: () => void; server?: { draft: PlanDraft; save: (draft: PlanDraft) => Promise<void>; reload: () => Promise<PlanDraft> } }

/**
 * 平面图编辑：像绘图软件一样，左边是平面图和热区，中间是画板（工具条、缩放、网格），右边是所选对象的属性。
 * 客户可以导入底图后在上面摆热区，也可以直接在白板上画房间和墙线；成果用于统计页的热力展示。
 */
export function FloorPlanEditor({ context = 'flow', zones, counters, counts, countLabel, onClose, server, sourceHeat }: Props) {
  const [initial, setInitial] = useState(() => loadDraft())
  const [draft, setDraft] = useState<PlanDraft>(() => server ? (server.draft.plans.length ? server.draft : addPlan(emptyDraft(), '', zones)) : initial.draft.plans.length ? initial.draft : addPlan(emptyDraft(), '', zones))
  const draftRef = useRef(draft); draftRef.current = draft
  const [history, setHistory] = useState<{ past: PlanDraft[]; future: PlanDraft[] }>({ past: [], future: [] })
  const lastEdit = useRef<{ key: string; at: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(false)
  const { requestDiscard, dialog: discardDialog } = useDiscardConfirmation()
  const [confirmation, setConfirmation] = useState<{ kind: 'import'; plans: Plan[] } | { kind: 'delete'; id: string; name: string } | null>(null)
  const [dirty, setDirty] = useState(false), [notice, setNotice] = useState(initial.status === 'invalid' ? '本机草稿无法读取，已忽略' : ''), [error, setError] = useState('')
  const [mode, setMode] = useState<'counter' | 'zone'>(context === 'alarm' ? 'zone' : 'counter'), [tool, setTool] = useState<PlanTool>('select')
  const [spacePan, setSpacePan] = useState(false)
  const [view, setView] = useState<PlanView>(FIT), [grid, setGrid] = useState(true), [snap, setSnap] = useState(true), [opacity, setOpacity] = useState(0.9)
  const [selectedKey, setSelectedKey] = useState<string | null>(null), [selectedShape, setSelectedShape] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null), board = useRef<HTMLElement>(null)
  useEffect(()=>{const opener=document.activeElement as HTMLElement|null;dialog.current?.querySelector<HTMLInputElement>('[aria-label="平面图名称"]')?.focus();return()=>{if(opener?.isConnected)opener.focus()}},[])
  const plan = activePlan(draft), groups = useMemo(() => groupByCounter(zones, counters), [zones, counters])
  const previewHeat = useMemo(() => preview && plan ? heatCells(plan, counts, 96, 54) : undefined, [preview, plan, counts])
  const unresolved = unresolvedPlacementKeys(plan, zones)
  const zone = zones.find(z => z.key === selectedKey) ?? null, shape = plan?.shapes.find(s => s.id === selectedShape) ?? null
  const placedCount = zones.filter(z => isPlaced(plan, z.key)).length
  const empty = !!plan && !plan.image && !plan.shapes.length && !Object.keys(plan.placements).length

  // Every content change goes through here so it can be undone; typing into one field merges into one step.
  const commit = (next: PlanDraft, key?: string) => {
    const prev = draftRef.current
    if (next === prev) return
    const now = Date.now(), merge = !!key && lastEdit.current?.key === key && now - lastEdit.current.at < 1500
    lastEdit.current = key ? { key, at: now } : null
    setHistory(h => ({ past: merge ? h.past : [...h.past.slice(-79), prev], future: [] }))
    draftRef.current = next; setDraft(next); setDirty(true); setNotice('')
  }
  const edit = (change: (d: PlanDraft) => PlanDraft, key?: string) => commit(change(draftRef.current), key)
  const editPlan = (change: Parameters<typeof updateActive>[1], key?: string) => edit(d => updateActive(d, change), key)
  const step = (back: boolean) => {
    const from = back ? history.past : history.future
    const target = from.at(-1)
    if (!target) return
    const current = draftRef.current
    setHistory(h => back ? { past: h.past.slice(0, -1), future: [...h.future, current] } : { past: [...h.past, current], future: h.future.slice(0, -1) })
    lastEdit.current = null
    draftRef.current = target; setDraft(target); setDirty(true)
  }
  const switchPlan = (id: string) => { setDraft(d => setActive(d, id)); setSelectedKey(null); setSelectedShape(null); setView(FIT) }
  const clearSelection = () => { setSelectedKey(null); setSelectedShape(null) }
  const deleteSelection = () => {
    if (shape) { editPlan(p => removeShape(p, shape.id)); setSelectedShape(null) }
    else if (zone && isPlaced(plan, zone.key)) editPlan(p => unplaceZone(p, zone.key))
  }
  const zoomBy = (factor: number) => setView(v => { const zoom = Math.min(8, Math.max(0.25, v.zoom * factor)); return { zoom, x: v.x * zoom / v.zoom, y: v.y * zoom / v.zoom } })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const stack = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (saving || e.defaultPrevented || stack[stack.length - 1] !== dialog.current) return
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        if (!preview && tool !== 'select') setTool('select')
        else if (!preview && (selectedKey || selectedShape) && !typing(e.target)) clearSelection()
        else close()
        return
      }
      if (e.key === 'Tab' && dialog.current) {
        const targets=Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')).filter(el=>el.getClientRects().length>0)
        const first=targets[0],last=targets.at(-1)
        if (!first) {e.preventDefault();dialog.current.focus()}
        else if (e.shiftKey && (document.activeElement===first || !dialog.current.contains(document.activeElement))) {e.preventDefault();last?.focus()}
        else if (!e.shiftKey && (document.activeElement===last || !dialog.current.contains(document.activeElement))) {e.preventDefault();first.focus()}
        return
      }
      if (typing(e.target) || preview) return
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase()
      if (mod && k === 'z') { e.preventDefault(); step(!e.shiftKey); return }
      if (mod && k === 'y') { e.preventDefault(); step(false); return }
      if (mod || e.altKey) return
      if (e.key === 'Delete' || e.key === 'Backspace') { if (shape || zone) { e.preventDefault(); deleteSelection() } return }
      // Space pans only over the board; on a focused button or checkbox it keeps pressing that control.
      if (e.key === ' ') { const t = e.target; if (t === document.body || (t instanceof HTMLElement && board.current?.contains(t) && !t.closest('button,a,input,select,textarea,summary,[role="button"]'))) { e.preventDefault(); setSpacePan(true) } return }
      if (e.key === '+' || e.key === '=') { zoomBy(1.2); return }
      if (e.key === '-') { zoomBy(1 / 1.2); return }
      if (e.key === '0') { setView(FIT); return }
      if (k === 'i') { file.current?.click(); return }
      const picked = toolList.find(t => t[2].toLowerCase() === k)
      if (picked) setTool(picked[0])
    }
    const onUp = (e: KeyboardEvent) => { if (e.key === ' ') setSpacePan(false) }
    window.addEventListener('keydown', onKey); window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp) }
  })
  const backupDraft = async () => {
    const plans=await Promise.all(draft.plans.map(async p=>{if(!p.image?.data.startsWith('blob:'))return p;const response=await fetch(p.image.data);if(!response.ok)throw new Error('底图无法保存到本机');const blob=await response.blob();const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('底图无法保存到本机'));reader.readAsDataURL(blob)});return {...p,image:{...p.image,data}}}))
    return saveDraft({...draft,plans})
  }
  function close() {
    if (!saving) requestDiscard(dirty, '关闭会放弃当前窗口未保存的平面图修改；已保存的内容不受影响。', onClose)
  }
  const save = async () => {
    if (server) {
      setSaving(true); setError('')
      try { await server.save(draft); setDirty(false); setNotice('已保存到服务器') }
      catch (e) { setError(e instanceof Error ? `保存失败：${e.message}。修改仍保留，请重试或重新打开。` : '保存失败，修改仍保留') }
      finally { setSaving(false) }
      return
    }
    const result = saveDraft(draft)
    if (result.ok) { setDirty(false); setError(''); setNotice('') } else setError(result.reason === 'too_large' ? '本机存储空间不够，请换小一点的底图或删掉不用的平面图' : '本机存储不可用，草稿没有保存')
  }
  const reloadServer = async () => {
    if (!server) return
    let backup;try{backup=await backupDraft()}catch{setError('无法保留本机底图，未重新读取');return}
    if(!backup.ok){setError('无法保留本机草稿，未重新读取');return}
    setInitial(loadDraft()); setSaving(true)
    try{const next=await server.reload();draftRef.current=next;setDraft(next);setHistory({past:[],future:[]});setDirty(false);setError('');setNotice('已读取服务器版本，原修改保存在本机草稿；可导入为新图')}
    catch(e){setError(e instanceof Error?e.message:'读取失败，当前修改仍保留')}
    finally{setSaving(false)}
  }
  const backupLocal = async () => { let result;try{result=await backupDraft()}catch{setError('无法保留本机底图，当前修改仍保留');return} if(result.ok) {setInitial(loadDraft());setNotice('已另存本机草稿，可重新打开服务器版本后导入')} else setError('本机草稿保存失败，当前修改仍保留') }
  const importLocal = () => { const existing=new Set(draft.plans.map(p=>p.id)); const additions=initial.draft.plans.map(p=>existing.has(p.id)?{...p,id:'copy-'+crypto.randomUUID(),name:p.name+'（副本）'}:p); if (!additions.length) { setNotice('本机没有可导入的图'); return } if (draft.plans.length+additions.length>20) { setError('导入后超过 20 张，请先整理草稿'); return } setConfirmation({kind:'import',plans:additions}) }
  const importImage = async (f: File | undefined) => {
    if (!f) return
    try { const image = await readImage(f); editPlan(p => setImage(p, image)); setError(''); setView(FIT) } catch (e) { setError(e instanceof Error ? e.message : '图片导入失败') }
    if (file.current) file.current.value = ''
  }
  // A new shape is selected at once so it can be renamed or deleted; walls keep the wall tool so they chain end to end.
  const create = (s: NewShape) => {
    const next = updateActive(draftRef.current, p => addShape(p, s))
    commit(next)
    if (s.kind !== 'line') setTool('select')
    setSelectedKey(null); setSelectedShape(activePlan(next)?.shapes.at(-1)?.id ?? null)
  }
  const placement = zone && plan?.placements[zone.key]
  const setPl = (patch: Partial<Placement>, key: string) => { if (zone && placement) editPlan(p => setPlacement(p, zone.key, { ...placement, ...patch }), key) }
  const counted = (z: ZoneInfo) => Number.isFinite(counts[z.key]) ? counts[z.key] : undefined
  const row = (z: ZoneInfo, showCounters: boolean) => {
    const placed = isPlaced(plan, z.key)
    return <li key={`${z.key}`}>
      <button type="button" aria-pressed={selectedKey === z.key} onClick={() => { setSelectedKey(z.key); setSelectedShape(null) }}
        className={`flex min-h-9 w-full items-start gap-2 rounded-base px-2 py-1.5 text-left text-sm hover:bg-surface-hover [@media(pointer:coarse)]:min-h-11 ${selectedKey === z.key ? 'bg-primary-50 text-primary' : 'text-ink'}`}>
        <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${placed ? 'bg-success' : 'border border-ink-faint'}`} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex w-full items-center gap-2"><span className="truncate">{z.name}</span>
            {counted(z) !== undefined && <span className="ml-auto text-xs tabular-nums text-ink-subtle">{counted(z)!.toLocaleString('zh-CN')}</span>}</span>
          <span className="text-[11px] text-ink-faint">{placed ? '在本平面图' : '不在本平面图'}{showCounters && ` · ${z.counters.length ? z.counters.map(c => c.name).join('、') : '未关联统计'}`}</span>
        </span>
      </button></li>
  }
  const activeTool: PlanTool = spacePan ? 'pan' : tool
  const menuItems = [
    ...(server ? [{ label: '重新读取服务器', icon: RotateCcw, onSelect: () => void reloadServer() }, { label: '另存本机草稿', icon: Download, onSelect: () => void backupLocal() }] : []),
    ...(server && initial.status === 'ok' ? [{ label: '导入本机草稿', icon: Upload, onSelect: importLocal, disabled: saving }] : []),
    ...(plan ? [{ label: '删除平面图', icon: Trash2, danger: true, onSelect: () => setConfirmation({ kind: 'delete', id: plan.id, name: plan.name }) }] : []),
  ]

  return <><div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="平面图编辑" aria-busy={saving} inert={saving} className="fixed inset-0 z-50 flex flex-col bg-surface-page">
    <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
      <button type="button" aria-label="关闭" title="关闭（Esc）" disabled={saving} className={quiet + ' !min-w-9'} onClick={close}><X size={18} aria-hidden="true" /></button>
      <span aria-hidden="true" className="h-6 w-px bg-line" />
      {plan && <input aria-label="平面图名称" disabled={preview} value={plan.name} maxLength={40} title="点击改名"
        className="min-h-9 w-48 min-w-0 rounded-base border border-transparent bg-transparent px-2 text-base font-semibold text-ink hover:border-line focus:border-primary focus:bg-surface focus:outline-none disabled:opacity-100"
        onChange={e => editPlan(p => renamePlan(p, e.target.value || p.name), 'name')} />}
      <span className="rounded-full bg-surface-page px-2.5 py-0.5 text-xs text-ink-subtle" title={server ? '保存后更新统计页的平面图；未保存的修改只在当前窗口' : '草稿：仅保存在本机浏览器，尚未保存到服务器'}>{server ? '服务器平面图' : '本机草稿 · 未上传服务器'}</span>
      {dirty && <span className="flex items-center gap-1 text-xs text-amber-700"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />有未保存的修改</span>}
      <div role="group" aria-label="视图" className={segmented + ' mx-auto'}>
        <button type="button" className={toggle} aria-pressed={!preview} onClick={() => setPreview(false)}><PenLine size={14} aria-hidden="true" />编辑</button>
        <button type="button" className={toggle} aria-pressed={preview} onClick={() => { setPreview(true); setTool('select') }}><Eye size={14} aria-hidden="true" />预览</button>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" aria-label="撤销" title="撤销（Ctrl+Z）" className={quiet} disabled={preview || !history.past.length} onClick={() => step(true)}><Undo2 size={18} aria-hidden="true" /></button>
        <button type="button" aria-label="重做" title="重做（Ctrl+Shift+Z）" className={quiet} disabled={preview || !history.future.length} onClick={() => step(false)}><Redo2 size={18} aria-hidden="true" /></button>
        {menuItems.length > 0 && <CardMenu label="更多操作" items={menuItems} />}
        <button type="button" className="btn-primary ml-1 !min-h-9 !px-4 text-sm [@media(pointer:coarse)]:!min-h-11" disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : server ? '保存到服务器' : '保存草稿'}</button>
      </div>
    </header>
    {(notice || error) && <p role={error ? 'alert' : 'status'} className={`px-4 py-1.5 text-sm ${error ? 'bg-danger-50 text-danger-700' : 'bg-amber-50 text-ink'}`}>{error || notice}</p>}
    <input ref={file} type="file" accept="image/*" aria-label="导入平面图图片" className="hidden" onChange={e => void importImage(e.target.files?.[0])} />
    <div className={`grid min-h-0 flex-1 ${preview ? 'grid-cols-1' : '[@container(min-width:44rem)]:grid-cols-[16rem_minmax(0,1fr)_17rem]'}`}>
      {!preview && <aside className="flex min-h-0 flex-col border-r border-line bg-surface">
        <section aria-label="平面图列表" className="flex max-h-[38%] shrink-0 flex-col border-b border-line p-2">
          <header className="flex items-center gap-1 px-1 pb-1"><h3 className="text-xs font-semibold text-ink-subtle">平面图</h3>
            <button type="button" aria-label="新建平面图" title="新建平面图" className={quiet + ' ml-auto !min-h-7 !min-w-7 !px-1'} disabled={draft.plans.length >= 20} onClick={() => { edit(d => addPlan(d, '')); clearSelection(); setView(FIT) }}><Plus size={16} aria-hidden="true" /></button></header>
          <ul className="min-h-0 overflow-auto">{draft.plans.map(p => <li key={p.id}>
            <button type="button" aria-pressed={p.id === plan?.id} onClick={() => switchPlan(p.id)}
              className={`flex min-h-9 w-full items-center gap-2 rounded-base px-2 text-left text-sm [@media(pointer:coarse)]:min-h-11 ${p.id === plan?.id ? 'bg-primary-50 font-medium text-primary' : 'text-ink hover:bg-surface-hover'}`}>
              <span data-plan-name className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">{Object.keys(p.placements).length} 个热区</span>
            </button></li>)}</ul>
        </section>
        <section aria-label="热区" className="flex min-h-0 flex-1 flex-col gap-1.5 p-2">
          <header className="flex items-center gap-1 px-1"><h3 className="text-xs font-semibold text-ink-subtle">{context === 'alarm' ? '告警位置' : '热区'} <span className="font-normal tabular-nums">{placedCount}/{zones.length}</span></h3>
            {context === 'flow' && <div role="group" aria-label="列表方式" className={segmented + ' ml-auto'}>{([['counter', '按统计'], ['zone', '按热区']] as const).map(([id, name]) => <button key={id} type="button" aria-pressed={mode === id} className={toggle + ' !min-h-7 !px-2'} onClick={() => setMode(id)}>{name}</button>)}</div>}
          </header>
          <nav aria-label="热区列表" className="min-h-0 flex-1 overflow-auto">
            {!zones.length && <p className="p-2 text-sm text-ink-subtle">还没有热区。先到实时监看的布防里画热区。</p>}
            {mode === 'counter' ? groups.map(g => <section key={g.id ?? 'loose'} className="mb-2"><h3 className="px-2 py-1 text-xs font-semibold text-ink-subtle">{g.name}</h3>
              <ul>{g.zones.map(z => row(z, false))}{!g.zones.length && <li className="px-2 text-xs text-ink-faint">还没有选用到热区</li>}</ul></section>)
              : <ul>{[...zones].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map(z => row(z, context === 'flow'))}</ul>}
          </nav>
          {unresolved.length > 0 && <section aria-label="未读取引用" className="max-h-40 overflow-auto border-t border-line pt-2 text-xs">
            <h3 className="font-semibold">失效/未读取引用 {unresolved.length} 个</h3>
            <p>可能已移除、未读取或在当前筛选外；原摆放会保留。移除仅修改当前草稿，保存后生效。</p>
            <ul>{unresolved.map(key => <li key={key} className="flex flex-wrap items-center gap-1 py-1"><button type="button" className="min-h-11 break-all text-left" onClick={() => {setSelectedKey(key);setSelectedShape(null)}}>{key}</button><button type="button" className="btn-secondary min-h-11 text-xs" aria-label={`从草稿移除未读取引用 ${key}`} onClick={() => {editPlan(p=>unplaceZone(p,key));if(selectedKey===key)setSelectedKey(null)}}>从草稿移除</button></li>)}</ul>
          </section>}
          {plan && placedCount < zones.length && <button type="button" className={small + ' w-full justify-center'} onClick={() => editPlan(p => placeAll(p, zones))}><Plus size={14} aria-hidden="true" />放入全部热区（还有 {zones.length - placedCount} 个）</button>}
        </section>
      </aside>}

      <section ref={board} className="relative flex min-h-[24rem] min-w-0 flex-col" aria-label="平面图画布">
        {plan ? <PlanCanvas plan={plan} zones={zones} selectedKey={selectedKey} selectedShapeId={selectedShape} tool={activeTool} readOnly={preview} heat={sourceHeat?undefined:previewHeat} heatPalette={context} sourceHeat={preview?sourceHeat:null}
            view={preview ? undefined : view} onViewChange={setView} grid={grid} snap={snap ? GRID : 0} imageOpacity={opacity}
            onSelectZone={setSelectedKey} onSelectShape={setSelectedShape}
            onChangeZone={(key, p) => editPlan(pl => setPlacement(pl, key, p))} onChangeShape={(id, patch) => editPlan(pl => updateShape(pl, id, patch))}
            onCreateShape={create} />
          : <p className="py-10 text-center text-sm text-ink-subtle">还没有平面图。</p>}
        {!preview && <div role="toolbar" aria-label="绘图工具" aria-orientation="vertical" className="absolute left-3 top-3 z-10 flex flex-col gap-0.5 rounded-panel border border-line bg-surface p-1 shadow-md">
          {toolList.map(([id, name, key, Icon, tip]) => <button key={id} type="button" aria-pressed={activeTool === id} title={`${name}（${key}）：${tip}`}
            className="group relative flex h-10 w-10 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover hover:text-ink aria-pressed:bg-primary aria-pressed:text-white [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" onClick={() => setTool(id)}>
            <Icon size={18} aria-hidden="true" /><span className="sr-only">{name}</span><span aria-hidden="true" className="absolute bottom-0.5 right-1 text-[9px] leading-none opacity-60">{key}</span></button>)}
          <span aria-hidden="true" className="mx-1.5 my-0.5 h-px bg-line" />
          <button type="button" title="导入底图（I）" className="flex h-10 w-10 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover hover:text-ink [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" onClick={() => file.current?.click()}><ImagePlus size={18} aria-hidden="true" /><span className="sr-only">导入底图</span></button>
        </div>}
        {!preview && empty && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
          <section aria-label="开始绘制" className="pointer-events-auto w-full max-w-xl space-y-3 rounded-panel border border-line bg-surface/95 p-5 shadow-lg backdrop-blur-sm">
            <h3 className="text-base font-semibold text-ink">先画出现场的样子</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <button type="button" className="flex flex-col items-start gap-1.5 rounded-panel border border-line p-4 text-left hover:border-primary hover:bg-primary-50/40" onClick={() => file.current?.click()}>
                <ImagePlus size={22} aria-hidden="true" className="text-primary" /><span className="font-medium text-ink">导入底图</span><span className="text-xs leading-5 text-ink-subtle">建筑平面图、CAD 截图或现场照片，再把热区摆到对应位置。</span></button>
              <button type="button" className="flex flex-col items-start gap-1.5 rounded-panel border border-line p-4 text-left hover:border-primary hover:bg-primary-50/40" onClick={() => setTool('room')}>
                <PenLine size={22} aria-hidden="true" className="text-primary" /><span className="font-medium text-ink">直接在白板上画</span><span className="text-xs leading-5 text-ink-subtle">用房间、墙线和文字勾出大致布局，不需要精确尺寸。</span></button>
            </div>
            {zones.length > 0 && <button type="button" className={small} onClick={() => editPlan(p => placeAll(p, zones))}><Plus size={14} aria-hidden="true" />先放入全部 {zones.length} 个热区</button>}
          </section>
        </div>}
        {!preview && <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex items-end gap-3">
          <p className="min-w-0 flex-1 truncate rounded-base bg-surface/90 px-2 py-1 text-xs text-ink-subtle shadow-sm backdrop-blur-sm">{hints[activeTool]}</p>
          <div role="group" aria-label="缩放" className="pointer-events-auto flex items-center gap-0.5 rounded-panel border border-line bg-surface p-0.5 shadow-md">
            <button type="button" aria-label="缩小" title="缩小（-）" className={quiet + ' !min-w-9 !px-1'} onClick={() => zoomBy(1 / 1.2)}><Minus size={16} aria-hidden="true" /></button>
            <button type="button" aria-label={`适应画布，当前 ${Math.round(view.zoom * 100)}%`} title="适应画布（0）" className={quiet + ' min-w-14 tabular-nums'} onClick={() => setView(FIT)}>{Math.round(view.zoom * 100)}%</button>
            <button type="button" aria-label="放大" title="放大（+）" className={quiet + ' !min-w-9 !px-1'} onClick={() => zoomBy(1.2)}><Plus size={16} aria-hidden="true" /></button>
          </div>
        </div>}
        {preview && <p className="absolute inset-x-3 bottom-3 z-10 truncate rounded-base bg-surface/90 px-2 py-1 text-xs text-ink-subtle shadow-sm">{countLabel ? `${countLabel} · ` : ''}{sourceHeat?'当前草稿预览 · 真实画面网格独立嵌入规划框，非地面投影；保存后才更新布局。':'当前草稿预览 · 数量热力图为独立叠加层，保存后才会更新页面布局。'}</p>}
      </section>

      {!preview && <aside className="min-h-0 space-y-4 overflow-auto border-l border-line bg-surface p-3 text-sm">
        {zone ? <section aria-label="热区属性" className="space-y-3">
          <header><p className="text-[11px] text-ink-faint">热区</p><h3 className="text-base font-semibold text-ink">{zone.name}</h3></header>
          {context === 'flow' && <p className="text-xs text-ink-subtle">所属统计：{zone.counters.length ? zone.counters.map(c => c.name).join('、') : '未关联'}</p>}
          <p className="text-xs text-ink-subtle">出现在 {plansOfZone(draft, zone.key).length} 张平面图</p>
          {placement ? <>
            <div className="grid grid-cols-2 gap-2">{([['x', 'X 位置'], ['y', 'Y 位置'], ['w', '宽度'], ['h', '高度']] as const).map(([k, label]) =>
              <label key={k} className="flex flex-col gap-0.5 text-xs text-ink-subtle">{label}<input type="number" aria-label={label} value={Math.round(placement[k])} className={numberField} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setPl({ [k]: v }, `${zone.key}:${k}`) }} /></label>)}</div>
            <button type="button" className={small} onClick={() => editPlan(p => unplaceZone(p, zone.key))}>从本平面图移除</button>
          </> : <button type="button" className="btn-primary !min-h-8 !px-3 !py-1 text-xs" onClick={() => editPlan(p => placeZone(p, zones, zone.key))}>加入本平面图</button>}
          <div className="space-y-2 rounded-base bg-surface-page p-2.5 text-xs text-ink-subtle">
            <p>{context === 'flow' ? '名称、形状和关联的统计在布防里改。' : '热区名称、检测形状和关联告警规则在布防里改；这里仅保存展示位置。'}</p>
            <Link to="/monitor" className="inline-flex items-center gap-1 text-primary hover:underline">在布防中修改形状和名称</Link>
          </div>
        </section> : shape ? <section aria-label="图形属性" className="space-y-3">
          <header><p className="text-[11px] text-ink-faint">图形</p><h3 className="text-base font-semibold text-ink">{shape.kind === 'room' ? '房间' : shape.kind === 'line' ? '墙线' : '文字'}</h3></header>
          {shape.kind === 'room' && <label className="flex flex-col gap-0.5 text-xs text-ink-subtle">房间名称<input value={shape.name} maxLength={40} className="form-input !py-1 text-xs" onChange={e => editPlan(p => updateShape(p, shape.id, { name: e.target.value }), `${shape.id}:name`)} /></label>}
          {shape.kind === 'label' && <label className="flex flex-col gap-0.5 text-xs text-ink-subtle">文字内容<input value={shape.text} maxLength={60} className="form-input !py-1 text-xs" onChange={e => editPlan(p => updateShape(p, shape.id, { text: e.target.value }), `${shape.id}:text`)} /></label>}
          {shape.kind === 'line' && <p className="text-xs text-ink-subtle">长度约 {Math.round(Math.hypot(shape.points[2] - shape.points[0], shape.points[3] - shape.points[1]))}（画板单位）</p>}
          <button type="button" className={small + ' text-danger'} onClick={deleteSelection}><Trash2 size={14} aria-hidden="true" />删除所选图形</button>
        </section> : <section aria-label="平面图属性" className="space-y-4">
          <header><p className="text-[11px] text-ink-faint">平面图</p><h3 className="truncate text-base font-semibold text-ink">{plan?.name}</h3></header>
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-ink-subtle">底图</h4>
            {plan?.image ? <>
              <p className="text-xs text-ink-subtle">已导入 {plan.image.w} × {plan.image.h}</p>
              <label className="flex items-center gap-2 text-xs text-ink-subtle">不透明度<input type="range" min={0.2} max={1} step={0.05} value={opacity} aria-label="底图不透明度" className="h-6 min-w-0 flex-1 accent-primary" onChange={e => setOpacity(Number(e.target.value))} /><span className="w-9 text-right tabular-nums">{Math.round(opacity * 100)}%</span></label>
              <div className="flex flex-wrap gap-2"><button type="button" className={small} onClick={() => file.current?.click()}>替换底图</button><button type="button" className={small} onClick={() => editPlan(p => setImage(p, null))}>移除底图</button></div>
            </> : <>
              <button type="button" className={small} onClick={() => file.current?.click()}><ImagePlus size={14} aria-hidden="true" />导入底图</button>
              <p className="text-[11px] leading-4 text-ink-faint">平面图、CAD 截图或照片；缩放到最长边 1600 像素后保存。</p>
            </>}
          </div>
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-ink-subtle">网格</h4>
            <label className="flex min-h-8 items-center gap-2 text-sm text-ink"><input type="checkbox" className="h-4 w-4 accent-primary" checked={grid} onChange={e => setGrid(e.target.checked)} />显示网格</label>
            <label className="flex min-h-8 items-center gap-2 text-sm text-ink"><input type="checkbox" className="h-4 w-4 accent-primary" checked={snap} onChange={e => setSnap(e.target.checked)} />吸附网格</label>
            <p className="text-[11px] text-ink-faint">画板 {PLAN_W} × {PLAN_H}，网格 {GRID}。</p>
          </div>
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-ink-subtle">快捷键</h4>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-ink-subtle">
              {[['V / H', '选择 / 平移'], ['R / L / T', '房间 / 墙线 / 文字'], ['空格 + 拖动', '临时平移'], ['滚轮', '缩放'], ['Delete', '删除所选'], ['Ctrl+Z', '撤销'], ['Esc', '结束绘制 / 取消选择']].map(([k, v]) =>
                <div key={k} className="contents"><dt><kbd className="rounded border border-line bg-surface-page px-1 font-sans">{k}</kbd></dt><dd>{v}</dd></div>)}
            </dl>
          </div>
          <p className="text-xs leading-5 text-ink-subtle">一个热区可以放在多张平面图上，每张图上的位置各自独立。</p>
        </section>}
      </aside>}
    </div>
  </div>
    {discardDialog}
    <ConfirmDialog
      open={confirmation !== null}
      title={confirmation?.kind === 'import' ? '导入本机草稿？' : '删除平面图？'}
      content={confirmation?.kind === 'import'
        ? `导入本机草稿 ${confirmation.plans.length} 张？已有同编号的图将作为副本导入。确认只加入当前草稿，保存后才会上传；本机草稿会保留。`
        : confirmation?.kind === 'delete'
          ? `从草稿移除“${confirmation.name}”？确认仅从当前草稿移除，点击“${server ? '保存到服务器' : '保存草稿'}”后才保存删除。热区本身不受影响。`
          : ''}
      confirmText={confirmation?.kind === 'import' ? '导入草稿' : '从草稿移除'}
      danger={confirmation?.kind === 'delete'}
      onClose={() => setConfirmation(null)}
      onConfirm={() => {
        if (confirmation?.kind === 'import') {
          const additions = confirmation.plans
          edit(d => ({...d, plans: [...d.plans, ...additions]}))
          setNotice('草稿已加入编辑，保存后才会上传')
        } else if (confirmation?.kind === 'delete') {
          const id = confirmation.id
          edit(d => { const rest = removePlan(d, id); return rest.plans.length ? rest : addPlan(rest, '') })
          clearSelection()
        }
      }}
    />
  </>
}
