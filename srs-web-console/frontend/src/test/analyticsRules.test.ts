import { describe,it,expect } from 'vitest'
import { ruleError } from '@/features/analyticsRules'
describe('rule geometry',()=>{
 it('rejects crossed polygons',()=>expect(ruleError({id:'a',type:'region',points:[[0,0],[1,1],[0,1],[1,0]]})).toBeTruthy())
 it('accepts a proper region',()=>expect(ruleError({id:'a',type:'region',points:[[0,0],[1,0],[1,1],[0,1]]})).toBeNull())
 it('rejects unfinished and identical line endpoints',()=>{
  expect(ruleError({id:'a',type:'line',points:[]})).toBeTruthy()
  expect(ruleError({id:'a',type:'line',points:[[0,0],[0,0]]})).toBeTruthy()
 })
 it('requires a positive dwell time',()=>expect(ruleError({id:'a',type:'dwell',points:[[0,0],[1,0],[1,1]],dwell_seconds:0})).toBeTruthy())
})
