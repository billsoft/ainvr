import { expect, it } from 'vitest'
import { triggerAvailability } from '@/features/triggerAvailability'
import { reviewerDisplay } from '@/features/alarmReview'
import type { TriggerDefinition } from '@/features/alarmDefinitions'
import type { AlarmSource } from '@/api/alarmTriggerService'

const trigger = { labels: [{ label_id: 'helmet:no_helmet', name: 'no_helmet' }],
  usages: [{ assignment_id: 'a', processor_id: 'p', source_id: 's', zone_name: '门口' }] } as TriggerDefinition
const source = { channel_id: 'p', labels: [{ label_id: 'helmet:no_helmet', name: 'no_helmet' }] } as AlarmSource

it('模型删除、重新添加与目录不可达分别显示失效、可用和待核验', () => {
  expect(triggerAvailability(trigger, [source])[0]?.state).toBe('available')
  expect(triggerAvailability(trigger, [{ ...source, labels: [] }])[0]?.state).toBe('missing')
  expect(triggerAvailability(trigger, [source])[0]?.state).toBe('available')
  expect(triggerAvailability(trigger, [])[0]?.state).toBe('unknown')
  expect(triggerAvailability({ ...trigger, usages: [] }, [])[0]).toBeUndefined()
})
it('同名不同标签不能误认为旧目标仍可用，多个选用独立判断', () => {
  const changed = { ...source, labels: [{ ...source.labels[0]!, label_id: 'new:no_helmet' }] }
  const second = { ...source, channel_id: 'p2' }
  expect(triggerAvailability({ ...trigger, usages: [...trigger.usages!, { ...trigger.usages![0]!, assignment_id: 'b', processor_id: 'p2' }] }, [changed, second]).map(v => v.state)).toEqual(['missing', 'available'])
})
it('区域能力不可用不伪装成正常布防', () => {
  const region = { ...trigger, region_state: { operator: 'presence', event_kind: 'helmet_violation' } } as TriggerDefinition
  expect(triggerAvailability(region, [source])[0]?.state).toBe('unsupported')
  expect(triggerAvailability(region, [{ ...source, region_capabilities: [{ event_kind: 'helmet_violation', ready: true, label_ids: ['helmet:no_helmet'] }] }])[0]?.state).toBe('available')
})
it('审核行使用可读名称，真实用户名保持原样', () => {
  expect(reviewerDisplay('console-administrator')).toBe('管理员')
  expect(reviewerDisplay('console-local')).toBe('本机操作员')
  expect(reviewerDisplay('张三')).toBe('张三')
  expect(reviewerDisplay()).toBe('审核员')
})
