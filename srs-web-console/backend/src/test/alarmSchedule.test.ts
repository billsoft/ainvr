import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {alarmScheduleSchema} from '../store/alarmSchedule.js';
it('accepts the same weekly schedule contract as the analysis service',()=>{
 const cases=JSON.parse(readFileSync(new URL('../../../../test/fixtures/alarm-weekly-schedule.json',import.meta.url),'utf8'));
 for(const c of cases)expect(alarmScheduleSchema.safeParse(c.schedule).success,c.name).toBe(c.valid);
 expect(alarmScheduleSchema.safeParse({mode:'weekly',timezone:'UTC',windows:Array.from({length:29},()=>({days:[1],start:'09:00',end:'10:00'}))}).success).toBe(false);
});
