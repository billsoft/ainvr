import { describe, expect, it } from 'vitest'
import { configApplySummary } from '@/features/configApplySummary'
import type { ApplyOperation, ServiceState } from '@/api/configService'

const good = { serviceName: 'backend', status: 'applied', appliedVersion: 2,
  desiredVersion: 2, restartRequired: false } as ServiceState
const done = { status: 'succeeded', stage: '配置已保存并生效' } as ApplyOperation
describe('current configuration confirmation', () => {
  it('only confirms equal applied versions without restart requirements', () => {
    expect(configApplySummary([good], done, ['backend']).tone).toBe('success')
    for (const changes of [{restartRequired:true}, {desiredVersion:3}, {status:'failed'}, {status:'partial'}]) {
      expect(configApplySummary([{...good,...changes} as ServiceState], done, ['backend']).tone).toBe('warning')
    }
  })
  it('does not show success for unavailable or missing status', () => {
    expect(configApplySummary([], done, ['backend']).tone).toBe('warning')
    expect(configApplySummary([good], done, ['backend'], 'offline').tone).toBe('warning')
  })
  it('keeps active progress and failure explanation', () => {
    const job = {...done,status:'running',stage:'等待服务恢复'} as ApplyOperation
    expect(configApplySummary([],job,['backend'])).toEqual({text:job.stage,tone:'running'})
    expect(configApplySummary([good],{...job,status:'timeout'},['backend']).text).toBe(job.stage)
  })
})
