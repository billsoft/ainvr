import { ScanLine } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { alarmAnalyticsService, type AlarmAnalyticsResult } from '@/api/alarmAnalyticsService'
import { SideDockedSection } from '@/components/layout/SideDockedSection'
import { formatRangeLabel } from '@/pages/Flow/counterText'
import AlarmWorkspace from './AlarmWorkspace'
import TriggerDefinitionsPage from './TriggerDefinitionsPage'
import { AlarmLinkContext, alarmPeriod, alarmPresets } from './alarmLink'

const tabs = [
  { to: '/alarms', name: '告警分析' },
  { to: '/alarms/rules', name: '告警规则' },
]

/** 告警分析：右侧选告警规则（或全部），中间在告警列表和告警分析之间切换，都按所选规则显示。 */
export function AlarmSection() {
  const [params, setParams] = useSearchParams()
  const [columnOpen, setColumnOpen] = useState(false)
  const [reload, setReload] = useState(0), [now, setNow] = useState(() => new Date())
  const [counts, setCounts] = useState<AlarmAnalyticsResult | null>(null), [countsError, setCountsError] = useState('')
  const rule = params.get('rule')
  const period = alarmPeriod(params, now)
  const periodKey = period.custom ? `${period.custom.from.getTime()}-${period.custom.to.getTime()}` : period.preset
  const periodLabel = period.custom ? formatRangeLabel(period.range.from, period.range.to) : alarmPresets.find(p => p[0] === period.preset)![1]
  const shownPeriod = useRef('')
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden) setNow(new Date()) }, 60000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    const controller = new AbortController()
    // Another period clears the cards; the minute refresh keeps them on screen until the new numbers arrive.
    if (shownPeriod.current !== periodKey) { setCounts(null); shownPeriod.current = periodKey }
    void alarmAnalyticsService.query({ from: period.range.from.toISOString(), to: period.range.to.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', bucket: period.range.bucket }, controller.signal)
      .then(r => { if (!controller.signal.aborted) { setCounts(r); setCountsError('') } })
      .catch(e => { if (!controller.signal.aborted) setCountsError(e instanceof Error ? e.message : '告警统计读取失败') })
    return () => controller.abort()
  // The period is fully described by its key and its end, which moves with `now`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodKey, period.range.to.getTime(), reload])
  const choose = useCallback((next: string | null) => setParams(old => {
    const p = new URLSearchParams(old)
    if (next) p.set('rule', next); else p.delete('rule')
    // A fixed statistics scope belongs to the rule it was opened with; choosing another rule leaves it.
    for (const key of ['analytics_scope', 'from', 'to', 'locations']) p.delete(key)
    return p
  }, { replace: true }), [setParams])
  const link = useMemo(() => ({ rule, choose, periodLabel, counts, countsError, columnOpen, reload, bump: () => setReload(n => n + 1) }), [rule, choose, periodLabel, counts, countsError, columnOpen, reload])
  return (
    <AlarmLinkContext.Provider value={link}>
      <SideDockedSection label="告警分析" tabs={tabs} sideRoute="/alarms/rules" storageKey="alarms.columns" middleMin={640}
        sideTitle="告警规则" sideIcon={ScanLine} onOpenChange={setColumnOpen} middle={<AlarmWorkspace />} side={<TriggerDefinitionsPage />} />
    </AlarmLinkContext.Provider>
  )
}
