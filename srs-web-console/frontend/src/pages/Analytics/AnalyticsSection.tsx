import { useMemo, useState } from 'react'
import { Footprints } from 'lucide-react'
import { SideDockedSection } from '@/components/layout/SideDockedSection'
import FlowPage from '@/pages/Flow'
import AnalyticsPage from './index'
import { AnalyticsLinkContext, type CounterSelection } from './analyticsLinkContext'

const tabs = [
  { to: '/analytics', name: '数据分析' },
  { to: '/analytics/counters', name: '计数统计' },
]

/** 统计分析：中间看数据，右侧管计数器；勾选哪些计数器进入分析，增删改后中间自动刷新。 */
export function AnalyticsSection() {
  const [reload, setReload] = useState(0)
  const [selection, publish] = useState<CounterSelection | null>(null)
  const [columnOpen, setColumnOpen] = useState(false)
  const link = useMemo(() => ({ reload, bump: () => setReload(n => n + 1), selection, publish, columnOpen }), [reload, selection, columnOpen])
  return (
    <AnalyticsLinkContext.Provider value={link}>
      <SideDockedSection label="统计分析" tabs={tabs} sideRoute="/analytics/counters" storageKey="analytics.columns" middleMin={680}
        sideTitle="计数统计" sideIcon={Footprints} onOpenChange={setColumnOpen}
        middle={<AnalyticsPage />} side={<FlowPage variant="manage" />} />
    </AnalyticsLinkContext.Provider>
  )
}
