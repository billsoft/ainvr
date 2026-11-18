import { BarChart3, CalendarClock, ListChecks, MapPin, RefreshCw, X } from 'lucide-react'
import { aiChannelService } from '@/api/aiChannelService'
import type { AlarmLocation } from '@/api/alarmEventService'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { field, fieldSelect, segment, segmented } from '@/components/ui/filterStyles'
import { DateTimeRangePicker } from '@/components/ui/DateTimeRangePicker'
import { validateCustomRange } from '@/pages/Flow/flowRange'
import { toDatetimeLocalValue } from '@/utils/timeRange'
import { alarmBusinessKinds } from '@/features/alarmBusinessKind'
import AlarmAnalyticsPage from '@/pages/Analytics/AlarmAnalyticsPage'
import AlarmListPage from './AlarmListPage'
import { ZoneChecklist } from '@/components/ZoneChecklist'
import { alarmPeriod, alarmPresets, drillSearch, useAlarmLink, type AlarmRuleLink } from './alarmLink'

const toggle = segment + ' !min-h-9 [@media(pointer:coarse)]:!min-h-11'
// One control height for the whole combined page: 36 px with a mouse, 44 px on touch.
const bar = 'inline-flex !min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-base border border-line bg-surface px-3 text-sm text-ink-subtle hover:text-ink aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary [@media(pointer:coarse)]:!min-h-11'
const barField = 'inline-flex !min-h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-base border border-line bg-surface pl-3 text-sm text-ink-subtle [@media(pointer:coarse)]:!min-h-11'
const barSelect = '!min-h-9 max-w-[9rem] cursor-pointer border-0 bg-transparent py-0 pl-1 pr-2 text-sm font-medium text-ink focus:outline-none [@media(pointer:coarse)]:!min-h-11'
/** From this width the list and the analysis share the page (1920 px screens with the rules column open give ~1270). */
export const COMBINED_MIN_WIDTH = 1120

const pairKey = (z: AlarmLocation) => JSON.stringify([z.channel_id, z.zone_id])

/**
 * The page's place choice when the rules column (where zones are picked on the cards) is folded away: the same checklist,
 * over every zone with alarms this period, grouped by channel.
 */
function PlacePicker({ link, className }: { link: AlarmRuleLink; className: string }) {
  const [names, setNames] = useState<Record<string, string>>({})
  useEffect(() => { let live = true; void aiChannelService.list().then(r => { if (live) setNames(Object.fromEntries(r.map(c => [c.id, c.name]))) }).catch(() => undefined); return () => { live = false } }, [])
  const zones = [...(link.counts?.catalog.zones ?? [])].sort((a, b) => a.channel_id.localeCompare(b.channel_id) || a.name.localeCompare(b.name, 'zh-CN'))
  const keys = new Set(zones.map(pairKey))
  const chosen = new Set(link.locations ? link.locations.map(pairKey) : keys)
  const outside = (link.locations ?? []).filter(z => !keys.has(pairKey(z)))
  const label = link.locations ? `${link.locations.length} 个热区` : '全部'
  return <div className="flex shrink-0 items-center">
    <details className="relative" onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus() } }}>
      <summary className={className + ' cursor-pointer list-none'} aria-label={`告警位置：${label}`}><MapPin size={14} aria-hidden="true" />位置 · {label}</summary>
      <div className="absolute left-0 top-full z-30 mt-1 max-h-[60vh] w-80 overflow-auto rounded-panel border border-line bg-surface p-2 shadow-lg">
        {zones.length ? <ZoneChecklist label="告警位置" hint="本时段有告警的热区" options={zones.map(z => ({ key: pairKey(z), name: z.name, group: names[z.channel_id] ?? z.channel_id }))} chosen={chosen} limit={12}
          onChange={next => link.setLocations(next.length === zones.length ? null : zones.filter(z => next.includes(pairKey(z))).map(({ channel_id, zone_id }) => ({ channel_id, zone_id })))}
          outside={outside.length ? { count: outside.length, clear: () => link.setLocations(null) } : undefined} />
          : <p className="px-2 py-3 text-xs text-ink-subtle">本时段还没有带热区的告警。</p>}
      </div>
    </details>
    {link.locations && <button type="button" aria-label="清除位置选择" className="ml-0.5 inline-flex min-h-9 min-w-9 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover hover:text-ink [@media(pointer:coarse)]:min-h-11" onClick={() => link.setLocations(null)}><X size={14} aria-hidden="true" /></button>}
  </div>
}

/** With the rules column open, the zones are chosen on the cards; the page only says that a choice narrows it, and clears it. */
function ZoneNote({ link }: { link: AlarmRuleLink }) {
  if (!link.locations) return null
  return <span role="status" aria-label="已选热区" className="inline-flex !min-h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-base bg-primary-50 pl-3 text-sm text-primary [@media(pointer:coarse)]:!min-h-11"><MapPin size={14} aria-hidden="true" />已选 {link.locations.length} 个热区
    <button type="button" aria-label="清除热区选择" className="inline-flex !min-h-9 min-w-9 items-center justify-center rounded-base hover:bg-primary-100 [@media(pointer:coarse)]:!min-h-11" onClick={() => link.setLocations(null)}><X size={14} aria-hidden="true" /></button></span>
}

function useWidth(fixed?: number) {
  const ref = useRef<HTMLDivElement>(null), [width, setWidth] = useState(fixed ?? 0)
  useEffect(() => {
    const el = ref.current
    if (fixed !== undefined || !el) return
    setWidth(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width) })
    observer.observe(el)
    return () => observer.disconnect()
  }, [fixed])
  return [ref, fixed ?? width] as const
}

/**
 * The middle of 告警分析, for the rule chosen in the rules column (or every rule). Wide enough, the alarm list (work
 * through alarms) and the analysis (where and when they happen) share one page, and a drill-down in the analysis filters
 * the list beside it. Narrower, one of them at a time.
 */
export default function AlarmWorkspace({ layoutWidth }: { /** Tests set the width; the page measures itself. */ layoutWidth?: number } = {}) {
  const [params, setParams] = useSearchParams()
  const link = useAlarmLink()
  const [box, width] = useWidth(layoutWidth)
  const combined = width >= COMBINED_MIN_WIDTH
  const view = params.get('view') === 'analysis' ? 'analysis' : 'list'
  const rule = link?.rule ?? null
  const rules = link?.counts?.catalog.triggers ?? []
  const ruleName = rule ? rules.find(t => t.trigger_id === rule)?.name || '所选规则' : ''
  const show = (next: 'list' | 'analysis') => setParams(old => {
    const p = new URLSearchParams(old)
    if (next === 'analysis') { p.set('view', 'analysis'); for (const key of ['analytics_scope', 'from', 'to', 'locations', 'status']) p.delete(key) }
    else p.delete('view')
    return p
  })
  // A period running up to now gives the list no end, so it neither reloads every minute nor misses new alarms.
  const period = link ? alarmPeriod(params, link.now) : null
  const ended = !!period && (!!period.custom || period.preset === 'yesterday')
  const listPeriod = combined && link && period ? { from: period.range.from.toISOString(), ...(ended ? { to: period.range.to.toISOString() } : {}), label: link.periodLabel } : undefined
  // Drill-downs stay on this page: the list beside the analysis takes their scope; a new tab still opens as usual.
  const drill = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const anchor = (e.target as Element).closest?.('a')
    const href = anchor?.getAttribute('href')
    if (!href) return
    const next = drillSearch(params, href)
    if (!next) return
    e.preventDefault()
    setParams(next)
  }
  const [picker, setPicker] = useState<{ from: string; to: string } | null>(null)
  const set = (changes: Record<string, string | null>) => setParams(old => { const p = new URLSearchParams(old); for (const [k, v] of Object.entries(changes)) v === null ? p.delete(k) : p.set(k, v); return p })
  const compare = params.get('compare') !== '0'
  // One business filter for the whole page: the analysis reads it from the address, the list follows it.
  const businessKind = params.get('event_kind') ?? ''
  const list = <AlarmListPage rule={rule} ruleName={ruleName} onShowAll={() => link?.choose(null)} compact={combined} period={listPeriod} onChanged={link?.bump} {...(combined ? { businessKind } : {})} {...(link ? { locations: link.locations } : {})} />
  return <div ref={box} className="flex h-full min-h-0 flex-col bg-surface-page">
    <header className={`flex shrink-0 items-center gap-x-3 gap-y-2 px-3 pt-3 [@container(min-width:40rem)]:px-4 ${combined ? 'flex-nowrap' : 'flex-wrap'}`}>
      <h1 className="min-w-0 max-w-[24rem] truncate text-lg font-semibold leading-7 text-ink" title={ruleName || undefined}>告警分析<span className="font-normal text-ink-subtle"> · {ruleName || '全部规则'}</span></h1>
      {/* The page's one toolbar: the period, comparison and business type govern both halves. */}
      {combined && link && period && <div role="toolbar" aria-label="告警分析条件" className="flex min-w-0 flex-1 items-center gap-2">
        <div role="group" aria-label="时段" className="flex shrink-0 gap-1">{alarmPresets.map(([id, label]) => <button key={id} type="button" className={bar} aria-pressed={!period.custom && period.preset === id} onClick={() => { link.refresh(); set({ range: id, afrom: null, ato: null }) }}>{label}</button>)}
          <button type="button" className={bar} aria-label="告警自选时间范围" aria-pressed={!!period.custom} onClick={() => setPicker({ from: toDatetimeLocalValue(period.range.from), to: toDatetimeLocalValue(new Date(period.range.to.getTime() - 1000)) })}><CalendarClock size={14} aria-hidden="true" />{period.custom ? link.periodLabel : '自选'}</button></div>
        <button type="button" className={bar} aria-pressed={compare} onClick={() => set({ compare: compare ? '0' : '1' })}>对比：{compare ? period.range.compare : '关闭'}</button>
        {/* Zones are picked on the rule cards; only with the column folded away does the page offer the choice itself. */}
        {link.columnOpen ? <ZoneNote link={link} /> : <PlacePicker link={link} className={bar} />}
        <label className={barField}>业务<select aria-label="告警业务类别" className={barSelect} value={businessKind} onChange={e => set({ event_kind: e.target.value || null, primary_type: null })}><option value="">全部类型</option>{Object.entries(alarmBusinessKinds).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <button type="button" className={bar + ' ml-auto'} aria-label="刷新告警统计" title="重新统计到现在" onClick={() => link.refresh()}><RefreshCw size={14} aria-hidden="true" /></button>
      </div>}
      {!combined && <div role="group" aria-label="告警视图" className={segmented}>
        <button type="button" className={toggle} aria-pressed={view === 'list'} onClick={() => show('list')}><ListChecks size={16} aria-hidden="true" />告警列表</button>
        <button type="button" className={toggle} aria-pressed={view === 'analysis'} onClick={() => show('analysis')}><BarChart3 size={16} aria-hidden="true" />告警分析</button>
      </div>}
      {!combined && link && (link.columnOpen ? <ZoneNote link={link} /> : <PlacePicker link={link} className={bar} />)}
      {/* With the rules column folded away, the rule is still one choice here. */}
      {link && !link.columnOpen && <label className={field}>规则<select aria-label="告警规则" className={fieldSelect} value={rule ?? ''} onChange={e => link.choose(e.target.value || null)}>
        <option value="">全部规则</option>
        {rule && !rules.some(t => t.trigger_id === rule) && <option value={rule}>所选规则</option>}
        {rules.map(t => <option key={t.trigger_id} value={t.trigger_id}>{t.name || t.trigger_id}</option>)}
      </select></label>}
    </header>
    {picker && <DateTimeRangePicker open from={picker.from} to={picker.to} validateRange={validateCustomRange} onConfirm={(from, to) => { set({ range: 'custom', afrom: new Date(from).toISOString(), ato: new Date(Date.parse(to) + 1000).toISOString() }); setPicker(null) }} onClose={() => setPicker(null)} />}
    <div className="min-h-0 flex-1">
      {combined
        ? <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-3 p-3 [@container(min-width:40rem)]:px-4">
            <div className="min-h-0 min-w-0">{list}</div>
            <div className="min-h-0 min-w-0" onClickCapture={drill}><AlarmAnalyticsPage triggerId={rule} compact /></div>
          </div>
        : view === 'list' ? list : <div className="h-full p-3 [@container(min-width:40rem)]:px-4" onClickCapture={drill}><AlarmAnalyticsPage triggerId={rule} /></div>}
    </div>
  </div>
}
