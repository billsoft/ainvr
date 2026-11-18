import type { ReactNode } from 'react'
import type { TriggerDefinition } from '@/features/alarmDefinitions'
import { behaviorNames, levelLook } from '@/features/alarmTriggers'
import { alarmBusinessName } from '@/features/alarmBusinessKind'
import type { AlarmRuleLink } from './alarmLink'

const states = { enabled: '已启用', paused: '已暂停', draft: '草稿', archived: '已归档' }
const stateLook = { enabled: 'bg-green-50 text-green-700', paused: 'bg-surface-page text-ink-subtle', draft: 'bg-amber-50 text-amber-800', archived: 'bg-surface-page text-ink-subtle' }
const card = (on: boolean) => `rounded-panel border transition-colors ${on ? 'border-primary bg-primary-50/40 shadow-sm' : 'border-line bg-surface hover:border-primary/40'}`
const n = (v: number | undefined) => v === undefined ? '—' : v.toLocaleString('zh-CN')

function Numbers({ total, pending, large }: { total?: number; pending?: number; large: boolean }) {
  return <span className="flex flex-wrap items-baseline gap-x-4 text-sm tabular-nums text-ink-subtle">
    <span>告警 <strong className={`font-semibold text-ink ${large ? 'text-2xl leading-8' : ''}`}>{n(total)}</strong></span>
    <span>待审核 <strong className={`font-semibold ${pending ? 'text-danger-700' : 'text-ink'} ${large ? 'text-2xl leading-8' : ''}`}>{n(pending)}</strong></span>
  </span>
}

/**
 * Beside the alarm views: every rule is one choice, plus every rule at once. A card shows its alarms and pending ones for
 * the page's period; the chosen card opens what the rule watches and where it is used.
 */
export function RuleColumn({ link, rules, details, menu }: { link: AlarmRuleLink; rules: TriggerDefinition[]; details: (t: TriggerDefinition) => ReactNode; menu: (t: TriggerDefinition) => ReactNode }) {
  const counts = link.counts
  const of = (id: string) => counts?.triggers.find(t => t.trigger_id === id)
  const all = link.rule === null
  return <div role="radiogroup" aria-label="选择告警规则" className="space-y-2">
    <article aria-label="全部规则" className={card(all)}>
      <button type="button" role="radio" aria-checked={all} onClick={() => link.choose(null)} className="flex w-full flex-col items-start gap-1 rounded-panel px-4 py-3 text-left">
        <span className="flex w-full items-baseline gap-2"><span className="text-base font-semibold text-ink">全部规则</span><span className="text-xs text-ink-subtle">{rules.length} 条规则</span></span>
        <Numbers total={counts?.total} pending={counts?.pending} large={all} />
        {all && counts && <span aria-label="审核概况" className="grid w-full grid-cols-2 gap-2 pt-1 text-xs">
          <span className="rounded-base bg-surface px-2 py-1.5"><span className="block text-ink-subtle">人工确认</span><strong className="text-sm tabular-nums text-ink">{n(counts.human_confirmed)}</strong></span>
          <span className="rounded-base bg-surface px-2 py-1.5"><span className="block text-ink-subtle">人工判为误报</span><strong className="text-sm tabular-nums text-ink">{n(counts.human_false_positive)}</strong></span>
        </span>}
      </button>
    </article>
    {rules.map(t => {
      const on = link.rule === t.trigger_id, c = of(t.trigger_id)
      const kind = t.region_state ? alarmBusinessName(t.region_state.event_kind) : behaviorNames[t.behavior]
      return <article key={t.trigger_id} aria-label={t.name} className={card(on)}>
        <div className="flex items-start gap-1 pr-1">
          <button type="button" role="radio" aria-checked={on} onClick={() => link.choose(t.trigger_id)} className="flex min-h-11 min-w-0 flex-1 flex-col items-start gap-1 rounded-panel py-3 pl-4 text-left">
            <span className="flex items-center gap-1.5 text-xs text-ink-subtle"><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: levelLook[t.behavior]?.color }} />{kind}</span>
            <span className="flex flex-wrap items-center gap-2 break-words text-base font-semibold leading-6 text-ink">{t.name}{t.state !== 'enabled' && <span className={`rounded-full px-2 py-0.5 text-xs font-normal ${stateLook[t.state]}`}>{states[t.state]}</span>}</span>
            <Numbers total={c?.total ?? (counts ? 0 : undefined)} pending={c?.pending ?? (counts ? 0 : undefined)} large={on} />
            {on && c && c.human_reviewed > 0 && <span className="text-xs text-ink-subtle">人工误报 {c.human_false_positive} / 明确结论 {c.human_reviewed}（{(c.human_false_positive / c.human_reviewed * 100).toFixed(0)}%{c.human_reviewed < 20 ? '，样本少' : ''}）</span>}
          </button>
          <div className="pt-1.5">{menu(t)}</div>
        </div>
        {on && <div className="space-y-2 border-t border-line px-4 pb-3 pt-2 text-sm">{details(t)}</div>}
      </article>
    })}
    {!rules.length && <p className="rounded-panel border border-dashed border-line p-6 text-center text-sm text-ink-subtle">没有符合筛选的告警规则。</p>}
    {link.countsError && <p role="status" className="text-xs text-ink-subtle">数量暂不可用：{link.countsError}</p>}
  </div>
}
