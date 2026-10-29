import { describe, expect, it } from 'vitest'
import { names } from '../pages/Dashboard/format'

describe('dashboard optional service identity', () => {
  it('labels search as a service and leaves model readiness to its business view', () => {
    expect(names['search-service']).toBe('智能搜索服务')
    expect(names['search-service']).not.toMatch(/模型就绪|索引就绪/)
    expect(names['onvif']).toBe('ONVIF 接入')
    expect(names['llm-service']).toBe('大模型服务')
  })
})
