// Weekly wall-clock policy. No timers: evaluate the captured frame's instant.
import {createHash} from 'node:crypto';
const dayMinutes=1440,weekMinutes=7*dayMinutes,cache=new Map();
function invalid(message){throw new Error(message);}
function time(value,end=false){
  if(typeof value!=='string'||!(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)||end&&value==='24:00'))invalid('Invalid schedule time');
  const [h,m]=value.split(':').map(Number);return h*60+m;
}
function compile(input){
  if(!input||typeof input!=='object'||Array.isArray(input))invalid('Schedule must be an object');
  if(input.mode==='always'){
    if(Object.keys(input).some(k=>k!=='mode'))invalid('Unexpected always schedule fields');
    return {schedule:{mode:'always'},intervals:[],signature:'always'};
  }
  if(input.mode!=='weekly'||Object.keys(input).some(k=>!['mode','timezone','windows'].includes(k)))invalid('Unsupported schedule mode or fields');
  if(typeof input.timezone!=='string'||input.timezone.length>64||!input.timezone||/^[+-]/.test(input.timezone))invalid('Use a named IANA timezone');
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:input.timezone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  if(!Array.isArray(input.windows)||input.windows.length<1||input.windows.length>28)invalid('Select 1 to 28 weekly windows');
  const segments=[];
  const windows=input.windows.map(w=>{
    if(!w||typeof w!=='object'||Array.isArray(w)||Object.keys(w).some(k=>!['days','start','end'].includes(k))||!Array.isArray(w.days)||!w.days.length||w.days.length>7||new Set(w.days).size!==w.days.length||w.days.some(d=>!Number.isInteger(d)||d<1||d>7))invalid('Select distinct ISO weekdays 1 to 7');
    const start=time(w.start),end=time(w.end,true);
    if(start===end)invalid('Equal times are ambiguous; use 00:00 to 24:00 for a full day');
    const days=[...w.days].sort((a,b)=>a-b);
    for(const d of days){
      const a=(d-1)*dayMinutes+start,b=(d-1)*dayMinutes+end+(end<start?dayMinutes:0);
      if(b>weekMinutes)segments.push([a,weekMinutes],[0,b-weekMinutes]);else segments.push([a,b]);
    }
    return {days,start:w.start,end:w.end};
  }).sort((a,b)=>a.days.join(',').localeCompare(b.days.join(','))||a.start.localeCompare(b.start)||a.end.localeCompare(b.end));
  segments.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const intervals=[];
  for(const [a,b] of segments){
    const last=intervals.at(-1);
    if(last&&a<last[1])invalid('Weekly windows overlap, including across midnight');
    if(last&&a===last[1])last[1]=b;else intervals.push([a,b]);
  }
  if(intervals.length>1&&intervals[0][0]===0&&intervals.at(-1)[1]===weekMinutes){
    const first=intervals.shift();intervals.at(-1)[1]+=first[1];
  }
  const schedule={mode:'weekly',timezone:input.timezone,windows};
  return {schedule,formatter,intervals,signature:createHash('sha256').update(JSON.stringify(schedule)).digest('hex')};
}
function compiled(input){
  const value=input===undefined?{mode:'always'}:input;
  const key=JSON.stringify(value);
  let result=cache.get(key);
  if(!result){result=compile(value);if(cache.size>=256)cache.delete(cache.keys().next().value);cache.set(key,result);}
  return result;
}
export function normalizeSchedule(input){return structuredClone(compiled(input).schedule);}
export function createScheduleEvaluator(capturedAt){
  const instant=new Date(capturedAt),partsByZone=new Map(),periods=new Map();
  return input=>{
    const c=compiled(input);
    if(c.signature==='always')return 'always';
    if(!Number.isFinite(instant.getTime())||!/(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(capturedAt))invalid('Scheduled observations require an absolute captured_at instant');
    if(periods.has(c.signature))return periods.get(c.signature);
    let local=partsByZone.get(c.schedule.timezone);
    if(!local){
      const fields=Object.fromEntries(c.formatter.formatToParts(instant).map(p=>[p.type,p.value]));
      const date=Date.UTC(Number(fields.year),Number(fields.month)-1,Number(fields.day));
      const weekday=(new Date(date).getUTCDay()+6)%7;
      local={monday:date-weekday*86400000,minute:weekday*dayMinutes+Number(fields.hour)*60+Number(fields.minute)};
      partsByZone.set(c.schedule.timezone,local);
    }
    const interval=c.intervals.find(([a,b])=>b<=weekMinutes?local.minute>=a&&local.minute<b:local.minute>=a||local.minute<b-weekMinutes);
    let period=null;
    if(interval){
      const [a,b]=interval;
      const monday=local.monday-(b>weekMinutes&&local.minute<a?7*86400000:0);
      // Adjacent slots form one continuous interval, including Sunday -> Monday.
      period=a===0&&b===weekMinutes?c.signature+':continuous':`${c.signature}:${new Date(monday).toISOString().slice(0,10)}:${a}`;
    }
    periods.set(c.signature,period);return period;
  };
}
