import { ScanLine } from 'lucide-react'
import { SideDockedSection } from '@/components/layout/SideDockedSection'
import AlarmListPage from './AlarmListPage'
import TriggerDefinitionsPage from './TriggerDefinitionsPage'

const tabs = [
  { to: '/alarms', name: '告警记录' },
  { to: '/alarms/rules', name: '触发规则' },
]

/** 告警：中间是告警记录，右侧是触发规则（宽屏并排，窄屏两个页签）。 */
export function AlarmSection() {
  return (
    <SideDockedSection label="告警" tabs={tabs} sideRoute="/alarms/rules" storageKey="alarms.columns" middleMin={640}
      sideTitle="触发规则" sideIcon={ScanLine} middle={<AlarmListPage />} side={<TriggerDefinitionsPage />} />
  )
}
