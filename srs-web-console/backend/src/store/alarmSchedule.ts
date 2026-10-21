import {z} from 'zod';

const minute=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3));
const clock=z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
const window=z.object({days:z.array(z.number().int().min(1).max(7)).min(1).max(7),start:clock,end:z.union([clock,z.literal('24:00')])}).strict();
export const alarmScheduleSchema=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('always')}).strict(),
  z.object({mode:z.literal('weekly'),timezone:z.string().min(1).max(64),windows:z.array(window).min(1).max(28)}).strict(),
]).superRefine((s,ctx)=>{
  if(s.mode==='always')return;
  const issue=(message:string)=>ctx.addIssue({code:z.ZodIssueCode.custom,message});
  try{
    if(/^[+-]/.test(s.timezone))throw Error();
    new Intl.DateTimeFormat('en',{timeZone:s.timezone});
  }catch{issue('请选择有效的 IANA 时区，例如 Asia/Shanghai');}
  const occupied=new Uint8Array(10080);
  for(const w of s.windows){
    const start=minute(w.start),end=minute(w.end);
    if(start===end){issue('开始与结束不能相同；全天请用 00:00–24:00');return;}
    if(new Set(w.days).size!==w.days.length){issue('星期不能重复');return;}
    for(const day of w.days){
      const from=(day-1)*1440+start,to=(day-1)*1440+end+(end<start?1440:0);
      for(let m=from;m<to;m++){
        if(occupied[m%10080]){issue('生效时段重叠，请检查跨午夜的次日部分');return;}
        occupied[m%10080]=1;
      }
    }
  }
}).transform(s=>s.mode==='always'?s:{...s,windows:s.windows.map(w=>({...w,days:[...w.days].sort((a,b)=>a-b)})).sort((a,b)=>a.days.join(',').localeCompare(b.days.join(','))||a.start.localeCompare(b.start)||a.end.localeCompare(b.end))});
export type AlarmSchedule=z.infer<typeof alarmScheduleSchema>;
