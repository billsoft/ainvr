import { describe, expect, it } from 'vitest'
import { DEFAULT_WIZARD_VALUE, toCreatePatch, toUpdatePatch } from '@/features/aiChannelForm'
describe('analytics wizard configuration', () => {
  it('preserves legacy creation without an analytics field', () => {
    expect(toCreatePatch(DEFAULT_WIZARD_VALUE).analytics).toBeUndefined()
  })
  it('sends enabled tracking and preserves rules without sharing mutable state', () => {
    const value = {...DEFAULT_WIZARD_VALUE, analytics: {enabled: true,
      rules: [{id: 'door', type: 'line' as const, points: [[0,0],[1,1]] as [number,number][]}]}}
    const patch = toCreatePatch(value)
    expect(patch.analytics).toEqual(value.analytics)
    expect(patch.analytics).not.toBe(value.analytics)
    expect(toUpdatePatch(value, null).analytics).toEqual(value.analytics)
    patch.analytics!.rules![0]!.id = 'changed'
    expect(value.analytics.rules[0]!.id).toBe('door')
  })
  it('preserves review configuration and copies its description independently', () => {
    const value={...DEFAULT_WIZARD_VALUE,analytics:{enabled:true,review:{enabled:true,model_path:'/models/review.hbm',description:'a person',timeout_seconds:30}}}
    const patch=toUpdatePatch(value,null)
    expect(patch.analytics?.review).toEqual(value.analytics.review)
    patch.analytics!.review!.description='a car'
    expect(value.analytics.review.description).toBe('a person')
  })
  it('sends an explicit disable request', () => {
    expect(toUpdatePatch({...DEFAULT_WIZARD_VALUE,analytics:{enabled:false}},null)
      .analytics?.enabled).toBe(false)
  })
})
