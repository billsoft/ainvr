import { Eye, ImagePlus, MousePointer2, Minus, Square, Type, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'
import { useDiscardConfirmation } from '@/components/modals/useDiscardConfirmation'
import { PlanCanvas, type PlanTool, type PlanCanvasProps } from './PlanCanvas'
import {
  PLAN_H, PLAN_W, activePlan, addPlan, addShape, emptyDraft, groupByCounter, heatCells, isPlaced, placeAll, placeZone, plansOfZone, removePlan, removeShape,
  renamePlan, setActive, setImage, setPlacement, unplaceZone, unresolvedPlacementKeys, updateActive, updateShape, type NewShape, type Placement, type Plan, type PlanDraft, type ZoneInfo,
} from './planModel'
import { loadDraft, readImage, saveDraft } from './planStorage'

const seg = 'btn-secondary !px-2.5 !py-1 text-xs aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
const field = 'form-input !w-24 !py-1 text-xs'
interface Props { zones: ZoneInfo[]; counters: { id: string; name: string }[]; counts: Record<string, number>; countLabel?: string; sourceHeat?:PlanCanvasProps['sourceHeat']; onClose: () => void; server?: { draft: PlanDraft; save: (draft: PlanDraft) => Promise<void>; reload: () => Promise<PlanDraft> } }

/** 平面图编辑：导入底图、画房间/线/文字、把热区摆到平面图上。一个热区可以出现在多张平面图上。 */
export function FloorPlanEditor({ zones, counters, counts, countLabel, onClose, server, sourceHeat }: Props) {
  const [initial, setInitial] = useState(() => loadDraft())
  const [draft, setDraft] = useState<PlanDraft>(() => server ? (server.draft.plans.length ? server.draft : addPlan(emptyDraft(), '', zones)) : initial.draft.plans.length ? initial.draft : addPlan(emptyDraft(), '', zones))
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(false)
  const { requestDiscard, dialog: discardDialog } = useDiscardConfirmation()
  const [confirmation, setConfirmation] = useState<{ kind: 'import'; plans: Plan[] } | { kind: 'delete'; id: string; name: string } | null>(null)
  const [dirty, setDirty] = useState(false), [notice, setNotice] = useState(initial.status === 'invalid' ? '本机草稿无法读取，已忽略' : ''), [error, setError] = useState('')
  const [mode, setMode] = useState<'counter' | 'zone'>('counter'), [tool, setTool] = useState<PlanTool>('select')
  const [selectedKey, setSelectedKey] = useState<string | null>(null), [selectedShape, setSelectedShape] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(()=>{const opener=document.activeElement as HTMLElement|null;dialog.current?.querySelector<HTMLInputElement>('[aria-label="平面图名称"]')?.focus();return()=>{if(opener?.isConnected)opener.focus()}},[])
  const plan = activePlan(draft), groups = useMemo(() => groupByCounter(zones, counters), [zones, counters])
  const previewHeat = useMemo(() => preview && plan ? heatCells(plan, counts, 96, 54) : undefined, [preview, plan, counts])
  const unresolved = unresolvedPlacementKeys(plan, zones)
  const zone = zones.find(z => z.key === selectedKey) ?? null, shape = plan?.shapes.find(s => s.id === selectedShape) ?? null
  const edit = (change: (d: PlanDraft) => PlanDraft) => { setDraft(change); setDirty(true); setNotice('') }
  const editPlan = (change: Parameters<typeof updateActive>[1]) => edit(d => updateActive(d, change))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const stack = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (saving || e.defaultPrevented || stack[stack.length - 1] !== dialog.current) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
      if (e.key === 'Tab' && dialog.current) {
        const targets=Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')).filter(el=>el.getClientRects().length>0)
        const first=targets[0],last=targets.at(-1)
        if (!first) {e.preventDefault();dialog.current.focus()}
        else if (e.shiftKey && (document.activeElement===first || !dialog.current.contains(document.activeElement))) {e.preventDefault();last?.focus()}
        else if (!e.shiftKey && (document.activeElement===last || !dialog.current.contains(document.activeElement))) {e.preventDefault();first.focus()}
      }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  })
  const backupDraft = async () => {
    const plans=await Promise.all(draft.plans.map(async p=>{if(!p.image?.data.startsWith('blob:'))return p;const response=await fetch(p.image.data);if(!response.ok)throw new Error('底图无法保存到本机');const blob=await response.blob();const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('底图无法保存到本机'));reader.readAsDataURL(blob)});return {...p,image:{...p.image,data}}}))
    return saveDraft({...draft,plans})
  }
  const close = () => {
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
  const importImage = async (f: File | undefined) => {
    if (!f) return
    try { const image = await readImage(f); editPlan(p => setImage(p, image)); setError('') } catch (e) { setError(e instanceof Error ? e.message : '图片导入失败') }
    if (file.current) file.current.value = ''
  }
  // 新建图形后自动选中它，方便立刻改名或删除。
  const create = (s: NewShape) => {
    const next = updateActive(draft, p => addShape(p, s))
    setDraft(next); setDirty(true); setNotice(''); setTool('select'); setSelectedKey(null); setSelectedShape(activePlan(next)?.shapes.at(-1)?.id ?? null)
  }
  const placement = zone && plan?.placements[zone.key]
  const setPl = (patch: Partial<Placement>) => { if (zone && placement) editPlan(p => setPlacement(p, zone.key, { ...placement, ...patch })) }
  const counted = (z: ZoneInfo) => Number.isFinite(counts[z.key]) ? counts[z.key] : undefined
  const row = (z: ZoneInfo, showCounters: boolean) => <li key={`${z.key}`}>
    <button type="button" aria-pressed={selectedKey === z.key} onClick={() => { setSelectedKey(z.key); setSelectedShape(null) }}
      className={`flex min-h-9 w-full flex-col items-start rounded-base px-2 py-1 text-left text-sm hover:bg-surface-hover [@media(pointer:coarse)]:min-h-11 ${selectedKey === z.key ? 'bg-primary-50 text-primary' : 'text-ink'}`}>
      <span className="flex w-full items-center gap-2"><span className="truncate">{z.name}</span>
        {counted(z) !== undefined && <span className="ml-auto text-xs tabular-nums text-ink-subtle">{counted(z)!.toLocaleString('zh-CN')}</span>}</span>
      <span className="text-[11px] text-ink-faint">{isPlaced(plan, z.key) ? '在本平面图' : '不在本平面图'}{showCounters && ` · ${z.counters.length ? z.counters.map(c => c.name).join('、') : '未关联计数器'}`}</span>
    </button></li>

  return <><div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="平面图编辑" aria-busy={saving} inert={saving} className="fixed inset-0 z-50 flex flex-col bg-surface-page">
    <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
      <h2 className="text-base font-semibold text-ink">平面图编辑</h2>
      <span className="rounded-full border border-warning bg-amber-50 px-2.5 py-0.5 text-xs text-ink">{server ? '服务器平面图；未保存修改仅在当前窗口' : '草稿：仅保存在本机浏览器，尚未保存到服务器'}</span>
      {server && <button type="button" className={seg} onClick={async () => { let backup;try{backup=await backupDraft()}catch{setError('无法保留本机底图，未重新读取');return} if(!backup.ok){setError('无法保留本机草稿，未重新读取');return} setInitial(loadDraft()); setSaving(true);try{const next=await server.reload();setDraft(next);setDirty(false);setError('');setNotice('已读取服务器版本，原修改保存在本机草稿；可导入为新图')}catch(e){setError(e instanceof Error?e.message:'读取失败，当前修改仍保留')}finally{setSaving(false)} }}>重新读取服务器</button>}
      {server && <button type="button" className={seg} onClick={async () => { let result;try{result=await backupDraft()}catch{setError('无法保留本机底图，当前修改仍保留');return} if(result.ok) {setInitial(loadDraft());setNotice('已另存本机草稿，可重新打开服务器版本后导入')} else setError('本机草稿保存失败，当前修改仍保留') }}>另存本机草稿</button>}
      {server && initial.status === 'ok' && <button type="button" className={seg} disabled={saving} onClick={() => { const existing=new Set(draft.plans.map(p=>p.id)); const additions=initial.draft.plans.map(p=>existing.has(p.id)?{...p,id:'copy-'+crypto.randomUUID(),name:p.name+'（副本）'}:p); if (!additions.length) { setNotice('本机没有可导入的图'); return } if (draft.plans.length+additions.length>20) { setError('导入后超过 20 张，请先整理草稿'); return } setConfirmation({kind:'import',plans:additions}) }}>导入本机草稿</button>}
      {countLabel && <span className="text-xs text-ink-subtle">统计读数：{countLabel}</span>}
      {dirty && <span className="text-xs text-danger-700">有未保存的修改</span>}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <select aria-label="平面图" value={plan?.id ?? ''} className="form-input !w-auto !py-1 text-sm" onChange={e => edit(d => setActive(d, e.target.value))}>
          {draft.plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        {plan && <input aria-label="平面图名称" disabled={preview} value={plan.name} maxLength={40} className="form-input !w-36 !py-1 text-sm" onChange={e => editPlan(p => renamePlan(p, e.target.value || p.name))} />}
        <button type="button" disabled={preview} className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => edit(d => addPlan(d, ''))}>新建平面图</button>
        {plan && <button type="button" disabled={preview} className="btn-secondary !px-2.5 !py-1 text-xs text-danger" onClick={() => setConfirmation({kind:'delete',id:plan.id,name:plan.name})}>删除平面图</button>}
        <button type="button" className="btn-primary !px-3 !py-1 text-sm" disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : server ? '保存到服务器' : '保存草稿'}</button>
        <button type="button" aria-label="关闭" disabled={saving} className="btn-secondary min-h-11 min-w-11 !px-2.5 !py-1 text-sm" onClick={close}><X size={16} aria-hidden="true" />关闭</button>
      </div>
    </header>
    {(notice || error) && <p role={error ? 'alert' : 'status'} className={`px-4 py-1.5 text-sm ${error ? 'bg-danger-50 text-danger-700' : 'bg-amber-50 text-ink'}`}>{error || notice}</p>}
    <div className={`grid min-h-0 flex-1 gap-3 p-3 ${preview ? 'lg:grid-cols-1' : 'lg:grid-cols-[18rem_minmax(0,1fr)_16rem]'}`}>
      {!preview && <aside className="ui-panel flex min-h-0 flex-col gap-2 overflow-hidden p-3">
        <div role="group" aria-label="列表方式" className="flex gap-1">{([['counter', '按计数器'], ['zone', '按热区']] as const).map(([id, name]) => <button key={id} type="button" aria-pressed={mode === id} className={seg} onClick={() => setMode(id)}>{name}</button>)}</div>
        <nav aria-label="热区列表" className="min-h-0 flex-1 overflow-auto">
          {!zones.length && <p className="p-2 text-sm text-ink-subtle">还没有热区。先到实时监看的布防里画热区。</p>}
          {mode === 'counter' ? groups.map(g => <section key={g.id ?? 'loose'} className="mb-2"><h3 className="px-2 py-1 text-xs font-semibold text-ink-subtle">{g.name}</h3>
            <ul>{g.zones.map(z => row(z, false))}{!g.zones.length && <li className="px-2 text-xs text-ink-faint">还没有选用到热区</li>}</ul></section>)
            : <ul>{[...zones].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map(z => row(z, true))}</ul>}
        </nav>
        {unresolved.length > 0 && <section aria-label="未读取引用" className="max-h-40 overflow-auto border-t border-line pt-2 text-xs">
          <h3 className="font-semibold">失效/未读取引用 {unresolved.length} 个</h3>
          <p>可能已移除、未读取或在当前筛选外；原摆放会保留。移除仅修改当前草稿，保存后生效。</p>
          <ul>{unresolved.map(key => <li key={key} className="flex flex-wrap items-center gap-1 py-1"><button type="button" className="min-h-11 break-all text-left" onClick={() => {setSelectedKey(key);setSelectedShape(null)}}>{key}</button><button type="button" className="btn-secondary min-h-11 text-xs" aria-label={`从草稿移除未读取引用 ${key}`} onClick={() => {editPlan(p=>unplaceZone(p,key));if(selectedKey===key)setSelectedKey(null)}}>从草稿移除</button></li>)}</ul>
        </section>}
        {plan && <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => editPlan(p => placeAll(p, zones))}>放入全部热区</button>}
      </aside>}

      <section className="flex min-h-0 min-w-0 flex-col gap-2" aria-label="平面图画布">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-pressed={preview} className={seg} onClick={() => setPreview(v => !v)}><Eye size={14} aria-hidden="true" />{preview ? '返回布局编辑' : '预览展示'}</button>
          {!preview && <><div role="group" aria-label="绘图工具" className="flex gap-1">{([['select', '选择', MousePointer2], ['room', '房间', Square], ['line', '线条', Minus], ['label', '文字', Type]] as const).map(([id, name, Icon]) =>
            <button key={id} type="button" aria-pressed={tool === id} className={seg} onClick={() => setTool(id)}><Icon size={14} aria-hidden="true" />{name}</button>)}</div>
          <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" disabled={!plan} onClick={() => file.current?.click()}><ImagePlus size={14} aria-hidden="true" />导入平面图</button>
          <input ref={file} type="file" accept="image/*" aria-label="导入平面图图片" className="hidden" onChange={e => void importImage(e.target.files?.[0])} />
          {plan?.image && <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => editPlan(p => setImage(p, null))}>移除底图</button>}
          </>}
          <p className="ml-auto text-xs text-ink-subtle">{preview ? sourceHeat?'当前草稿预览 · 居中自动适配 · 真实画面网格独立嵌入规划框，非地面投影；保存后才更新布局。':'当前草稿预览 · 居中自动适配 · 计数热力图为独立叠加层，保存后才会更新页面布局。' : '在平面图上拖动只改摆放位置，不影响计数和检测范围；要改检测范围到布防里改。'}</p>
        </div>
        {plan ? <PlanCanvas plan={plan} zones={zones} selectedKey={selectedKey} selectedShapeId={selectedShape} tool={tool} readOnly={preview} heat={sourceHeat?undefined:previewHeat} sourceHeat={preview?sourceHeat:null}
            onSelectZone={setSelectedKey} onSelectShape={setSelectedShape}
            onChangeZone={(key, p) => editPlan(pl => setPlacement(pl, key, p))} onChangeShape={(id, patch) => editPlan(pl => updateShape(pl, id, patch))}
            onCreateShape={create} />
          : <p className="py-10 text-center text-sm text-ink-subtle">还没有平面图，点“新建平面图”开始。</p>}
        <p className="text-[11px] text-ink-faint">画布 {PLAN_W} × {PLAN_H}；底图缩放到最长边 1600 像素后保存。</p>
      </section>

      {!preview && <aside className="ui-panel min-h-0 space-y-3 overflow-auto p-3 text-sm">
        {zone ? <section aria-label="热区属性" className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">{zone.name}</h3>
          <p className="text-xs text-ink-subtle">所属计数器：{zone.counters.length ? zone.counters.map(c => c.name).join('、') : '未关联'}</p>
          <p className="text-xs text-ink-subtle">出现在 {plansOfZone(draft, zone.key).length} 张平面图</p>
          {placement ? <>
            <div className="grid grid-cols-2 gap-2">{([['x', 'X 位置'], ['y', 'Y 位置'], ['w', '宽度'], ['h', '高度']] as const).map(([k, label]) =>
              <label key={k} className="flex flex-col gap-0.5 text-xs text-ink-subtle">{label}<input type="number" aria-label={label} value={Math.round(placement[k])} className={field} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setPl({ [k]: v }) }} /></label>)}</div>
            <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => editPlan(p => unplaceZone(p, zone.key))}>从本平面图移除</button>
          </> : <button type="button" className="btn-primary !px-2.5 !py-1 text-xs" onClick={() => editPlan(p => placeZone(p, zones, zone.key))}>加入本平面图</button>}
          <p className="rounded-base border border-line bg-surface-page p-2 text-xs text-ink-subtle">名称、形状和关联的计数器在布防里改。</p>
          <Link to="/monitor" className="btn-secondary !px-2.5 !py-1 text-xs">在布防中修改形状和名称</Link>
          <p className="text-[11px] text-ink-faint">到实时监看，点对应通道的“布防”。</p>
        </section> : shape ? <section aria-label="图形属性" className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">{shape.kind === 'room' ? '房间' : shape.kind === 'line' ? '线条' : '文字'}</h3>
          {shape.kind === 'room' && <label className="flex flex-col gap-0.5 text-xs text-ink-subtle">房间名称<input value={shape.name} maxLength={40} className="form-input !py-1 text-xs" onChange={e => editPlan(p => updateShape(p, shape.id, { name: e.target.value }))} /></label>}
          {shape.kind === 'label' && <label className="flex flex-col gap-0.5 text-xs text-ink-subtle">文字内容<input value={shape.text} maxLength={60} className="form-input !py-1 text-xs" onChange={e => editPlan(p => updateShape(p, shape.id, { text: e.target.value }))} /></label>}
          <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs text-danger" onClick={() => { editPlan(p => removeShape(p, shape.id)); setSelectedShape(null) }}>删除所选图形</button>
        </section> : <p className="text-xs text-ink-subtle">点画布上的热区或图形查看属性。一个热区可以放在多张平面图上，每张图上的位置各自独立。</p>}
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
        }
      }}
    />
  </>
}
