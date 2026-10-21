import { describe, it, expect } from 'vitest'
import { SERVICES } from '@/pages/ConfigCenter'

// 契约（2026-09-16 评审 P3-10）：配置中心服务名单前后端必须一致，
// 后端真源是 backend/src/store/services.ts 的 CONFIG_SERVICES。
// 后端 servicesContract.test.ts 会反过来读本页源码再比对一次，
// 任何一侧漂移都会让 CI 红。
describe('配置中心服务名单', () => {
  it('key 顺序与后端 CONFIG_SERVICES 完全一致', () => {
    expect(SERVICES.map((s) => s.key)).toEqual([
      'backend',
      'srs',
      'ai-service',
      'recorder',
      'alarm-service',
    ])
  })

  it('key 唯一，且每项 label/description 非空', () => {
    const keys = SERVICES.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of SERVICES) {
      expect(s.label.trim().length).toBeGreaterThan(0)
      expect(s.description.trim().length).toBeGreaterThan(0)
    }
  })
})
