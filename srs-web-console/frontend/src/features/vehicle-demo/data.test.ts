import { describe,it,expect } from 'vitest'
import { initialRecords,initialScope,selectRecords,metrics,normalizePlate } from './data'
describe('vehicle prototype query contract',()=>{
 it('keeps unread plates in passage denominator',()=>{
  const rows=selectRecords(initialRecords,initialScope),m=metrics(rows)
  expect(m.total).toBe(30);expect(m.read).toBeLessThan(m.total);expect(m.incoming+m.outgoing).toBe(m.total)
 })
 it('retains location and time scope for map drill-down',()=>{
  const rows=selectRecords(initialRecords,{...initialScope,zone:'东门入口'})
  expect(rows.length).toBe(10);expect(rows.every(r=>r.zone==='东门入口'&&r.at.startsWith('2026-11-11'))).toBe(true)
 })
 it('uses normalized substring only for retrieval, not list matching',()=>{
  expect(normalizePlate(' 京a·12345 ')).toBe('京A12345')
  const rows=selectRecords(initialRecords,{...initialScope,query:'123'})
  expect(rows.length).toBeGreaterThan(0);expect(rows.every(r=>r.plate.includes('123'))).toBe(true)
 })
 it('returns unknown coverage for no records, not 100%',()=>{
  expect(metrics(selectRecords(initialRecords,{...initialScope,query:'不存在'})).rate).toBeNull()
 })
 it('filters prior day and each status without losing unknown records',()=>{
  expect(selectRecords(initialRecords,{...initialScope,from:'2026-11-10T00:00:00',to:'2026-11-10T23:59:59'})).toHaveLength(18)
  expect(selectRecords(initialRecords,{...initialScope,state:'未检出车牌'}).every(r=>!r.plate)).toBe(true)
 })
})
