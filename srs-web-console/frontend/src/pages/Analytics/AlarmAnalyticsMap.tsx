import { Pencil } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { alarmAnalyticsHref, type AlarmAnalyticsQuery, type AlarmAnalyticsResult } from '@/api/alarmAnalyticsService'
import { createFloorPlanSession } from '@/api/floorPlanService'
import { FloorPlanEditor } from './plan/FloorPlanEditor'
import { PlanCanvas } from './plan/PlanCanvas'
import { activePlan, addPlan, emptyDraft, heatCells, setActive, type PlanDraft, type ZoneInfo } from './plan/planModel'

interface Props { expanded?: boolean; result: AlarmAnalyticsResult; query: AlarmAnalyticsQuery; onEditingChange?: (editing: boolean) => void }
const control = 'btn-secondary !min-h-7 [@media(pointer:coarse)]:!min-h-11 !px-2 text-xs'
const pairKey = (channel: string, zone: string) => JSON.stringify([channel, zone])
const zoneLabel = (z: {name: string; zone_id: string}) => z.name && z.name !== z.zone_id ? z.name : `热区 · ${z.zone_id.length > 16 ? '…' + z.zone_id.slice(-8) : z.zone_id}`

/** Server layout shared with flow; only unambiguous zone IDs can address legacy placements. */
export function AlarmAnalyticsMap({ result, query, onEditingChange, expanded = false }: Props) {
  const [session] = useState(() => createFloorPlanSession())
  const [draft, setDraft] = useState<PlanDraft>(emptyDraft), [loading, setLoading] = useState(true)
  const [error, setError] = useState(''), [retry, setRetry] = useState(0), [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<string | null>(null), [cold, setCold] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    void session.load().then(value => { if (live) setDraft(value) }).catch(e => { if (live) setError(e instanceof Error ? e.message : '平面图读取失败') }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [session, retry])
  useEffect(() => () => session.dispose(), [session])
  useEffect(() => { onEditingChange?.(editing); return () => onEditingChange?.(false) }, [editing, onEditingChange])
  const catalog = useMemo(() => Array.from(new Map([...result.catalog.zones, ...result.zones].map(z => [pairKey(z.channel_id, z.zone_id), z])).values()), [result])
  const ambiguous = useMemo(() => {
    const owners = new Map<string, Set<string>>()
    for (const z of catalog) { const set = owners.get(z.zone_id) ?? new Set<string>(); set.add(z.channel_id); owners.set(z.zone_id, set) }
    return new Set([...owners].filter(([, owners]) => owners.size > 1).map(([id]) => id))
  }, [catalog])
  const zones: ZoneInfo[] = useMemo(() => catalog.filter(z => !ambiguous.has(z.zone_id)).map(z => ({ key: z.zone_id, zoneId: z.zone_id, channelId: z.channel_id, name: zoneLabel(z), counters: [] })), [catalog, ambiguous])
  const saved = activePlan(draft)
  const plan = useMemo(() => {
    const original = saved ?? (zones.length ? activePlan(addPlan(emptyDraft(), '', zones)) : null)
    return original ? { ...original, placements: Object.fromEntries(Object.entries(original.placements).filter(([key]) => !ambiguous.has(key))) } : null
  }, [saved, zones, ambiguous])
  const values = useMemo(() => Object.fromEntries(result.zones.filter(z => !ambiguous.has(z.zone_id)).map(z => [z.zone_id, z.total])), [result, ambiguous])
  const heat = useMemo(() => plan ? heatCells(plan, values, 96, 54) : undefined, [plan, values])
  const selectedRow = result.zones.find(z => !ambiguous.has(z.zone_id) && z.zone_id === selected)
  const rank = result.zones.filter(z => !query.locations || query.locations.some(p => pairKey(p.channel_id, p.zone_id) === pairKey(z.channel_id, z.zone_id))).sort((a, b) => b.total - a.total || pairKey(a.channel_id, a.zone_id).localeCompare(pairKey(b.channel_id, b.zone_id)))
  const selectedInfo = catalog.find(z => !ambiguous.has(z.zone_id) && z.zone_id === selected)
  const selectedInScope = selectedInfo && (!query.locations || query.locations.some(p => pairKey(p.channel_id, p.zone_id) === pairKey(selectedInfo.channel_id, selectedInfo.zone_id)))
  const unresolved = Object.keys(plan?.placements ?? {}).filter(key => !zones.some(z => z.key === key))
  return <section className="ui-panel flex min-h-0 min-w-0 flex-col gap-2 p-3 [&>*]:shrink-0" aria-label="告警热区分布">
    <header className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-ink">告警热区分布</h2><span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">涉及告警 · 条</span>
      {draft.plans.length > 1 && <select aria-label="告警平面图" className="form-input !min-h-7 [@media(pointer:coarse)]:!min-h-11 !w-auto !py-1 text-xs" value={saved?.id ?? ''} onChange={e => setDraft(old => setActive(old, e.target.value))}>{draft.plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      <button type="button" className={control + ' ml-auto'} disabled={loading || !!error || ambiguous.size > 0} title={ambiguous.size ? '跨通道重复热区编号无法安全编辑，请先消除编号歧义' : '编辑布局不改变检测范围'} onClick={() => setEditing(true)}><Pencil size={14} aria-hidden="true" />编辑平面图</button>
    </header>
    {loading ? <p role="status" className="py-12 text-center text-xs text-ink-subtle">正在读取服务器平面图…</p> : error ? <div role="alert" className="rounded-lg bg-amber-50 p-3 text-sm">服务器平面图读取失败：{error}<button className={control + ' ml-2'} onClick={() => setRetry(n => n + 1)}>重试平面图</button></div> : <>
      <div className="grid min-h-0 gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(14rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-1">
          <div className={"flex min-w-0 flex-col " + (expanded ? "h-[clamp(11rem,calc(100dvh-36rem),40rem)] xl:h-[clamp(11rem,calc(100dvh-32.5rem),40rem)]" : "h-[clamp(11rem,27vh,24rem)]")}>{plan ? <PlanCanvas plan={plan} zones={zones} heat={heat} heatPalette="alarm" heatMin={cold / 100} selectedKey={selected} onSelectZone={setSelected} readOnly /> : <p className="py-12 text-center text-xs text-ink-subtle">没有可绘制的热区位置；未关联告警保留在明细中。</p>}</div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-subtle"><span>{saved ? saved.name : '临时布局 · 尚未保存'}</span><label className="flex min-h-8 [@media(pointer:coarse)]:min-h-11 items-center gap-2">隐藏冷区<input aria-label="告警隐藏冷区" type="range" min={0} max={90} step={5} value={cold} className="w-20 accent-amber-600" onChange={e => setCold(Number(e.target.value))} /></label></div>
          <div aria-live="polite" className="min-h-8 [@media(pointer:coarse)]:min-h-11 rounded-lg bg-surface-page px-2 py-2 text-xs">{selectedInfo ? <span>{zoneLabel(selectedInfo)} · {selectedInfo.channel_id}：{selectedRow ? `${selectedRow.total.toLocaleString('zh-CN')} 条涉及告警` : '当前统计没有该位置读数'} {selectedInScope ? <Link className="ml-2 text-primary underline" to={alarmAnalyticsHref({ ...query, locations: [{ channel_id: selectedInfo.channel_id, zone_id: selectedInfo.zone_id }] })}>查看告警</Link> : <span className="ml-2 text-amber-800">筛选外位置；请通过顶部位置筛选改变范围。</span>}</span> : <span>选择规划框或排名行，查看该位置告警。</span>}</div>
        </div>
        <div className="flex min-w-0 flex-col gap-2"><div className="max-h-[clamp(15rem,38vh,29rem)] min-w-0 overflow-auto"><table className="w-full table-fixed text-xs" aria-label="告警热区排名"><thead className="sticky top-0 bg-white text-left text-ink-subtle"><tr><th className="w-[62%] py-2 font-medium">热区 / 通道</th><th className="text-right font-medium">涉及告警</th><th className="text-right font-medium">待审核</th></tr></thead><tbody>{rank.map((z, i) => <tr key={pairKey(z.channel_id, z.zone_id)} className={'border-t border-line ' + (selected === z.zone_id && !ambiguous.has(z.zone_id) ? 'bg-amber-50' : '')}><td className="overflow-hidden py-1 pr-2"><button type="button" disabled={ambiguous.has(z.zone_id)} title={`${z.name} · ${z.zone_id}`} className="min-h-8 [@media(pointer:coarse)]:min-h-11 w-full min-w-0 max-w-full break-all text-left" onClick={() => setSelected(z.zone_id)}><span className="mr-2 text-ink-faint">{i + 1}</span>{zoneLabel(z)}<span className="block break-all text-[10px] text-ink-faint">{z.channel_id}{ambiguous.has(z.zone_id) ? ' · 编号重复，不绘制' : saved && !saved.placements[z.zone_id] ? ' · 未布置在本图' : ''}</span></button></td><td className="text-right tabular-nums"><Link className="inline-flex min-h-8 [@media(pointer:coarse)]:min-h-11 items-center px-1 text-primary underline" aria-label={`${zoneLabel(z)} ${z.channel_id} ${z.total}条告警`} to={alarmAnalyticsHref({ ...query, locations: [{ channel_id: z.channel_id, zone_id: z.zone_id }] })}>{z.total.toLocaleString('zh-CN')}</Link></td><td className="text-right tabular-nums"><Link className="inline-flex min-h-8 [@media(pointer:coarse)]:min-h-11 items-center px-1 text-primary" to={alarmAnalyticsHref({ ...query, locations: [{ channel_id: z.channel_id, zone_id: z.zone_id }], audit: 'pending' })}>{z.pending.toLocaleString('zh-CN')}</Link></td></tr>)}</tbody></table>{!rank.length && <p className="py-6 text-xs text-ink-subtle">当前范围没有关联热区的告警。</p>}</div>
      {saved && rank.some(z => !saved.placements[z.zone_id]) && <p className="text-xs text-amber-800">有告警位置未布置在本图；在“编辑平面图”中摆放后显示热度。未布置位置仍计入统计。</p>}
      {ambiguous.size > 0 && <p role="status" className="text-xs text-amber-800">跨通道重复热区编号：{[...ambiguous].join('、')}。已从图层排除；表格按通道＋热区保留独立读数。</p>}
      {unresolved.length > 0 && <details className="text-xs text-ink-subtle"><summary>本图还有 {unresolved.length} 个未知或筛选外引用</summary><p className="break-all">{unresolved.join('、')}。仅保留布局，不补造数量。</p></details>}
        </div>
      </div>
    </>}
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-[11px] text-ink-subtle"><span className="flex items-center gap-1">低<span className="h-1.5 w-20 rounded-full bg-gradient-to-r from-amber-200 via-amber-500 to-red-600" aria-hidden="true" />高</span><span>独立告警数量相对热度层 · 规划框透明</span><details className="ml-auto"><summary className="cursor-pointer">分布口径</summary><p className="max-w-prose">按热区汇总的相对分布示意，不代表区内真实发生坐标或地面投影；热区可交叉归属，各行不能直接相加。编辑只改变布局，不改变布防。</p></details></footer>
    {editing && <FloorPlanEditor context="alarm" zones={zones} counters={[]} counts={values} countLabel="涉及告警 · 条 · 相对分布示意" server={{ draft, save: async value => { await session.save(value); setDraft(value) }, reload: async () => { const value = await session.load(); setDraft(value); return value } }} onClose={() => setEditing(false)} />}
  </section>
}
