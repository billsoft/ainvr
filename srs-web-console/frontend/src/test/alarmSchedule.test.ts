/// <reference types="node" />
import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
const cases=JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'../../../../test/fixtures/alarm-weekly-schedule.json'),'utf8')) as {name:string;schedule:unknown;valid:boolean}[]
import {scheduleError,scheduleSummary,type AlarmSchedule} from '@/features/alarmSchedule'
it('validates the same weekly contract and labels overnight start days',()=>{
 for(const c of cases)expect(!scheduleError(c.schedule as unknown as AlarmSchedule),c.name).toBe(c.valid)
 expect(scheduleSummary({mode:'weekly',timezone:'Asia/Shanghai',windows:[{days:[7],start:'22:00',end:'06:00'}]})).toBe('Asia/Shanghai · 周日 22:00–06:00（次日结束）')
 expect(scheduleSummary({mode:'always'})).toBe('每天全天生效')
})
