import { BarChart3, ListChecks } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { field, fieldSelect, segment, segmented } from '@/components/ui/filterStyles'
import AlarmAnalyticsPage from '@/pages/Analytics/AlarmAnalyticsPage'
import AlarmListPage from './AlarmListPage'
import { useAlarmLink } from './alarmLink'

const toggle = segment + ' !min-h-9 [@media(pointer:coarse)]:!min-h-11'

/**
 * The middle of 告警分析: the alarm list (work through alarms) or the analysis (where and when they happen), both for
 * the rule chosen in the rules column, or for every rule.
 */
export default function AlarmWorkspace() {
  const [params, setParams] = useSearchParams()
  const link = useAlarmLink()
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
  return <div className="flex h-full min-h-0 flex-col bg-surface-page">
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 pt-3 [@container(min-width:40rem)]:px-4">
      <h1 className="min-w-0 truncate text-lg font-semibold leading-7 text-ink" title={ruleName || undefined}>告警分析<span className="font-normal text-ink-subtle"> · {ruleName || '全部规则'}</span></h1>
      <div role="group" aria-label="告警视图" className={segmented}>
        <button type="button" className={toggle} aria-pressed={view === 'list'} onClick={() => show('list')}><ListChecks size={16} aria-hidden="true" />告警列表</button>
        <button type="button" className={toggle} aria-pressed={view === 'analysis'} onClick={() => show('analysis')}><BarChart3 size={16} aria-hidden="true" />告警分析</button>
      </div>
      {/* With the rules column folded away, the rule is still one choice here. */}
      {link && !link.columnOpen && <label className={field}>规则<select aria-label="告警规则" className={fieldSelect} value={rule ?? ''} onChange={e => link.choose(e.target.value || null)}>
        <option value="">全部规则</option>
        {rule && !rules.some(t => t.trigger_id === rule) && <option value={rule}>所选规则</option>}
        {rules.map(t => <option key={t.trigger_id} value={t.trigger_id}>{t.name || t.trigger_id}</option>)}
      </select></label>}
    </header>
    <div className="min-h-0 flex-1">
      {view === 'list' ? <AlarmListPage rule={rule} ruleName={ruleName} onShowAll={() => link?.choose(null)} /> : <div className="h-full p-3 [@container(min-width:40rem)]:px-4"><AlarmAnalyticsPage triggerId={rule} /></div>}
    </div>
  </div>
}
