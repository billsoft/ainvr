// Copyright AINVR. Read-only analytics over existing alarm facts.
import {fail} from './domain.mjs';

export const ANALYTICS_LIMITS=Object.freeze({facts:50000,groups:1000,catalog:5000,bytes:1800000,maxTimeMS:5000});
const audits=['pending','human_confirmed','human_false_positive','ai_reviewed','unknown'];
const validId=v=>typeof v==='string'&&v.trim().length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v);
const id=(v,label)=>{if(!validId(v))fail('invalid_filter',label+'无效，请重新选择筛选项（最多256个字符）');return v};
const literal=v=>({$literal:v});
export function normalizeAnalytics(input){
  if(typeof input==='string'){
    if(input.length>8192)fail('invalid_filter','统计筛选超过8192个字符，请减少筛选项后重试');
    try{input=JSON.parse(input)}catch{fail('invalid_filter','统计筛选格式无效，请返回统计页重新选择范围')}
  }
  const keys=['from','to','timezone','bucket','locations','trigger_id','primary_type','audit','weekday','hour','association'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k))||JSON.stringify(input).length>8192)fail('invalid_filter','统计筛选无效或包含不支持的条件，请返回统计页重新选择');
  const timestamp=v=>{
    if(typeof v!=='string')return false;
    const m=v.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/);
    if(!m||!Number.isFinite(Date.parse(v)))return false;
    const [y,month,day,hour,minute,second]=m.slice(1).map(Number),leap=y%4===0&&(y%100!==0||y%400===0);
    return month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]&&hour<24&&minute<60&&second<60;
  };
  if(!timestamp(input.from)||!timestamp(input.to)||Date.parse(input.to)<=Date.parse(input.from)||Date.parse(input.to)-Date.parse(input.from)>31*86400000)fail('invalid_time_range','请选择有效的起止时间，结束晚于开始且范围不超过31天；时间需包含时区');
  if(typeof input.timezone!=='string'||input.timezone.length>80||/^[+-]/.test(input.timezone))fail('invalid_filter','统计时区无效，请选择有效时区，例如 Asia/Shanghai');
  try{new Intl.DateTimeFormat('en',{timeZone:input.timezone}).format()}catch{fail('invalid_filter','统计时区无效，请选择有效时区，例如 Asia/Shanghai')}
  if(!['hour','day'].includes(input.bucket))fail('invalid_filter','统计分桶无效，请选择按小时或按天');
  const q={from:new Date(input.from).toISOString(),to:new Date(input.to).toISOString(),timezone:input.timezone,bucket:input.bucket};
  if(input.locations!==undefined){
    if(!Array.isArray(input.locations)||!input.locations.length||input.locations.length>100||JSON.stringify(input.locations).length>4096)fail('invalid_filter','请选择1至100个位置，位置筛选不超过4096个字符；查看全部时请清除位置筛选');
    const pairs=new Map();
    for(const p of input.locations){
      if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['channel_id','zone_id'].includes(k)))fail('invalid_filter','位置筛选格式无效，请重新选择通道和热区');
      const channel_id=id(p.channel_id,'通道ID'),zone_id=id(p.zone_id,'热区ID');
      pairs.set(JSON.stringify([channel_id,zone_id]),{channel_id,zone_id});
    }
    q.locations=[...pairs.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,v])=>v);
  }
  for(const k of ['trigger_id','primary_type'])if(input[k]!==undefined)q[k]=id(input[k],k==='trigger_id'?'触发器ID':'告警主类型');
  if(input.audit!==undefined){if(!audits.includes(input.audit))fail('invalid_filter','审核分类无效，请重新选择待审核、人工、AI或未知分类');q.audit=input.audit}
  for(const [k,max] of [['weekday',6],['hour',23]])if(input[k]!==undefined){if(!Number.isInteger(input[k])||input[k]<0||input[k]>max)fail('invalid_filter',k==='weekday'?'星期筛选无效，请从规律图重新选择（周一为0，周日为6）':'小时筛选无效，请从规律图重新选择0至23时');q[k]=input[k]}
  if(input.association!==undefined){if(input.association!=='unassociated')fail('invalid_filter','热区关联筛选无效，请重新选择未关联热区或清除该筛选');q.association=input.association}
  return q;
}

// This expression is also used by list(), including top-rule fallback and same-stage matching.
const stringExpr=v=>{
  const s={$cond:[{$eq:[{$type:v},'string']},v,'']};
  return {$and:[{$regexMatch:{input:s,regex:'^[^\\x00-\\x1f]{1,256}$'}},{$ne:[{$trim:{input:s,chars:' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'}},'']}]};
};
export const associationExpression=()=>({$concatArrays:[[
  {zone_id:{$ifNull:['$rule.snapshot.zone_id',null]},trigger_id:{$ifNull:['$trigger_id',{$ifNull:['$rule.id',null]}]},version:{$ifNull:['$rule.version',null]},zone_name:{$ifNull:['$rule.snapshot.zone_name',null]},trigger_name:{$ifNull:['$rule.name',null]}}
],{$map:{input:{$cond:[{$isArray:'$stages'},'$stages',[]]},as:'s',in:{zone_id:{$ifNull:['$$s.zone_id',null]},trigger_id:{$ifNull:['$$s.trigger_id',null]}}}}]});
export const auditExpression=()=>({$switch:{branches:[
  {case:{$and:[{$eq:['$handling.state','unacknowledged']},{$ne:['$handling.disposition','false_positive']}]},then:'pending'},
  {case:{$and:[{$eq:['$handling.state','acknowledged']},{$eq:['$handling.reviewed_by_kind','ai']}]},then:'ai_reviewed'},
  ...[['handled','human_confirmed'],['false_positive','human_false_positive']].map(([d,a])=>({case:{$and:[{$eq:['$handling.state','acknowledged']},{$eq:['$handling.reviewed_by_kind','human']},{$eq:['$handling.disposition',d]}]},then:a}))
],default:'unknown'}});
export function selectedAssociationExpression(q,as='$$a'){
  const parts=[];
  if(q.locations)parts.push({$or:q.locations.map(p=>({$and:[{$eq:['$channel_id',literal(p.channel_id)]},{$eq:[as+'.zone_id',literal(p.zone_id)]}]}))});
  if(q.trigger_id)parts.push({$eq:[as+'.trigger_id',literal(q.trigger_id)]});
  return parts.length?{$and:parts}:true;
}
export function analyticsFilter(q,as_of){
  const conditions=[];
  if(q.locations||q.trigger_id)conditions.push({$anyElementTrue:{$map:{input:associationExpression(),as:'a',in:selectedAssociationExpression(q)}}});
  if(q.audit)conditions.push({$eq:[auditExpression(),q.audit]});
  if(q.association)conditions.push({$not:[{$anyElementTrue:{$map:{input:associationExpression(),as:'a',in:stringExpr('$$a.zone_id')}}}]});
  const date={$convert:{input:'$occurred_at',to:'date',onError:null,onNull:null}};
  if(q.weekday!==undefined)conditions.push({$eq:[{$subtract:[{$isoDayOfWeek:{date,timezone:q.timezone}},1]},q.weekday]});
  if(q.hour!==undefined)conditions.push({$eq:[{$hour:{date,timezone:q.timezone}},q.hour]});
  return {occurred_at:{$gte:q.from,$lt:q.to},...(as_of?{ingested_at:{$lte:as_of}}:{}),...(q.primary_type?{behavior:q.primary_type}:{}),...(conditions.length?{$expr:{$and:conditions}}:{})};
}
const countGroup=id=>({$group:{_id:id,total:{$sum:1},pending:{$sum:{$cond:[{$eq:['$_audit','pending']},1,0]}},human_reviewed:{$sum:{$cond:[{$in:['$_audit',['human_confirmed','human_false_positive']]},1,0]}},human_false_positive:{$sum:{$cond:[{$eq:['$_audit','human_false_positive']},1,0]}}}});
const boundedSort=(n,sort={total:-1,_id:1})=>[{$sort:sort},{$limit:n+1}];

export function analyticsPipeline(q,as_of,limits=ANALYTICS_LIMITS,calendar=calendarBuckets(q)){
  const selected=[{$match:analyticsFilter(q)}];
  // Explicit absolute boundaries also handle fractional-hour DST transitions,
  // for which Mongo 7's hourly dateTrunc can disagree with wall-clock boundaries.
  const boundaries=[...calendar.map(b=>new Date(b.from)),new Date(q.to)];
  const refs=associationExpression();
  const zoneRows=(scoped=false)=>[
    {$set:{_refs:{$filter:{input:refs,as:'a',cond:scoped?selectedAssociationExpression(q):true}}}},{$unwind:'$_refs'},
    {$match:{$expr:stringExpr('$_refs.zone_id')}},
    {$group:{_id:{alarm:'$alarm_id',channel:'$channel_id',zone:'$_refs.zone_id'},audit:{$first:'$_audit'}}},
    {$set:{_audit:'$audit'}},countGroup({channel_id:'$_id.channel',zone_id:'$_id.zone'}),...boundedSort(scoped?limits.groups:limits.catalog)
  ];
  const triggerRows=(scoped=false)=>[
    {$set:{_refs:{$filter:{input:refs,as:'a',cond:scoped?selectedAssociationExpression(q):true}}}},{$unwind:'$_refs'},{$match:{$expr:stringExpr('$_refs.trigger_id')}},
    {$group:{_id:{alarm:'$alarm_id',trigger:'$_refs.trigger_id'},audit:{$first:'$_audit'}}},
    {$set:{_audit:'$audit'}},countGroup('$_id.trigger'),...boundedSort(scoped?limits.groups:limits.catalog)
  ];
  const dt={$convert:{input:'$occurred_at',to:'date',onError:null,onNull:null}};
  const middleRank={$or:[
    {$eq:['$rank',{$ceil:{$divide:['$n',2]}}]},
    {$eq:['$rank',{$add:[{$floor:{$divide:['$n',2]}},1]}]}
  ]};
  const p90Rank={$eq:['$rank',{$ceil:{$multiply:['$n',0.9]}}]};
  return [{$match:{occurred_at:{$gte:q.from,$lt:q.to},ingested_at:{$lte:as_of}}},{$sort:{occurred_at:-1,alarm_id:-1}},{$limit:limits.facts+1},
    {$project:{alarm_id:1,channel_id:1,occurred_at:1,behavior:1,'handling.state':1,'handling.disposition':1,'handling.reviewed_by_kind':1,'handling.acknowledged_at':1,trigger_id:1,'rule.id':1,'rule.version':1,'rule.name':1,'rule.snapshot.zone_id':1,'rule.snapshot.zone_name':1,'stages.zone_id':1,'stages.trigger_id':1}},
    {$set:{_audit:auditExpression(),_date:dt}},
    {$facet:{
      capacity:[{$count:'total'}],
      summary:[...selected,{$group:{_id:'$_audit',total:{$sum:1}}}],
      trend:[...selected,{$bucket:{groupBy:'$_date',boundaries,output:{total:{$sum:1}}}},{$sort:{_id:1}},{$limit:1501}],
      week:[...selected,{$group:{_id:{day:{$subtract:[{$isoDayOfWeek:{date:'$_date',timezone:q.timezone}},1]},hour:{$hour:{date:'$_date',timezone:q.timezone}}},total:{$sum:1}}}],
      zones:[...selected,...zoneRows(true)],triggers:[...selected,...triggerRows(true)],
      triggerVersions:[...selected,{$set:{_refs:{$filter:{input:refs,as:'a',cond:selectedAssociationExpression(q)}}}},{$unwind:'$_refs'},{$match:{$expr:{$and:[stringExpr('$_refs.trigger_id'),{$isNumber:'$_refs.version'}]}}},{$group:{_id:{trigger_id:'$_refs.trigger_id',version:'$_refs.version'}}},{$limit:limits.catalog+1}],
      historicalNames:[{$set:{_refs:refs}},{$unwind:'$_refs'},{$match:{$expr:{$or:[stringExpr('$_refs.zone_name'),stringExpr('$_refs.trigger_name')]}}},{$group:{_id:{channel_id:'$channel_id',zone_id:'$_refs.zone_id',trigger_id:'$_refs.trigger_id'},zone_name:{$first:'$_refs.zone_name'},trigger_name:{$first:'$_refs.trigger_name'}}},{$limit:limits.catalog+1}],
      types:[...selected,{$group:{_id:{$ifNull:['$behavior','unknown']},total:{$sum:1}}},...boundedSort(100)],
      catalogZones:zoneRows(),catalogTriggers:triggerRows(),catalogTypes:[{$group:{_id:{$ifNull:['$behavior','unknown']}}},...boundedSort(100,{_id:1})],
      unassociated:[...selected,{$match:{$expr:{$not:[{$anyElementTrue:{$map:{input:refs,as:'a',in:stringExpr('$$a.zone_id')}}}]}}},{$count:'total'}],
      wait:[...selected,{$match:{_audit:{$in:['human_confirmed','human_false_positive']}}},
        {$set:{_wait:{$subtract:[{$convert:{input:'$handling.acknowledged_at',to:'date',onError:null,onNull:null}},'$_date']}}},
        {$set:{_valid:{$and:[{$isNumber:'$_wait'},{$gte:['$_wait',0]},{$lte:['$_wait',{$subtract:[new Date(as_of),'$_date'] }]}]}}},
        {$setWindowFields:{partitionBy:'$_valid',sortBy:{_wait:1},output:{n:{$count:{},window:{documents:['unbounded','unbounded']}},rank:{$documentNumber:{}}}}},
        {$group:{_id:'$_valid',n:{$first:'$n'},
          middle:{$sum:{$cond:[{$and:['$_valid',middleRank]},'$_wait',0]}},
          p90:{$max:{$cond:[{$and:['$_valid',p90Rank]},'$_wait',null]}}
        }}
      ],
      pendingAge:[...selected,{$match:{_audit:'pending'}},{$group:{_id:{$switch:{branches:[{case:{$lt:[{$subtract:[new Date(as_of),'$_date']},600000]},then:'lt10m'},{case:{$lt:[{$subtract:[new Date(as_of),'$_date']},3600000]},then:'lt1h'}],default:'gte1h'}},total:{$sum:1}}}]
    }}];
}

// Local calendar transitions retain both repeated autumn hours and skip missing spring hours.
export function calendarBuckets(q){
  const start=Date.parse(q.from),end=Date.parse(q.to),fmt=new Intl.DateTimeFormat('en-GB',{timeZone:q.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'});
  const parts=t=>Object.fromEntries(fmt.formatToParts(t).map(x=>[x.type,x.value]));
  const key=p=>`${p.year}-${p.month}-${p.day}`+(q.bucket==='hour'?`T${p.hour}/${p.timeZoneName}`:'');
  const boundaries=[start];let t=start,p=parts(start),previous=key(p);
  // Jump to the next local calendar boundary. Only offset transitions require
  // binary search; ordinary hours take one Intl call rather than sixty.
  while(t<end){
    const ms=((t%1000)+1000)%1000;
    const until=(q.bucket==='hour'?60:Number(24-Number(p.hour))*60)-Number(p.minute);
    const projected=t+until*60000-Number(p.second)*1000-ms;
    let next=Math.min(projected,end,t+6*3600000),np=parts(next);
    if(np.timeZoneName!==p.timeZoneName){
      let low=t,high=next;
      while(high-low>1){const middle=Math.floor((low+high)/2);if(parts(middle).timeZoneName===p.timeZoneName)low=middle;else high=middle}
      next=high;np=parts(next);
    }
    const k=key(np);
    if(k!==previous&&next<end)boundaries.push(next);
    t=next;p=np;previous=k;
  }
  boundaries.push(end);return boundaries.slice(0,-1).map((t,i)=>({from:new Date(t).toISOString(),to:new Date(boundaries[i+1]).toISOString(),total:0}));
}
export async function queryAlarmAnalytics(repository,input,{limits=ANALYTICS_LIMITS}={}){
  const q=normalizeAnalytics(input),as_of=repository.clock(),calendar=calendarBuckets(q);
  let row;
  try{
    [row]=await repository.events.aggregate(analyticsPipeline(q,as_of,limits,calendar),{maxTimeMS:limits.maxTimeMS,allowDiskUse:false,hint:{occurred_at:-1,alarm_id:-1}}).toArray();
  }catch(error){
    if(error.code===50)fail('analytics_timeout','统计查询超时，请缩短时间范围后重试',503);
    if([292,10334,4031700,5414201].includes(error.code))fail('analytics_capacity','统计聚合内存或输出容量超限，请缩短时间范围',422);
    throw error;
  }
  const r=row??{};
  const capacity=message=>fail('analytics_capacity',message+'；请缩短日期范围后重试（位置筛选不减少全时段目录查询量）',422);
  if((r.capacity?.[0]?.total??0)>limits.facts)capacity('所选日期内告警超过'+limits.facts.toLocaleString('en-US')+'条统计容量');
  for(const k of ['zones','triggers'])if(r[k]?.length>limits.groups)capacity('位置或触发器排名超过'+limits.groups+'项容量');
  for(const k of ['catalogZones','catalogTriggers','historicalNames','triggerVersions'])if(r[k]?.length>limits.catalog)capacity('历史目录或版本关联超过'+limits.catalog+'项容量');
  if(r.types?.length>100||r.catalogTypes?.length>100||r.trend?.length>1500)capacity('统计类型或时间桶数量超过容量');
  const rules=await repository.listRules(undefined,{limit:5001,maxTimeMS:limits.maxTimeMS});
  if(!Array.isArray(rules)||rules.length>5000)capacity('当前规则目录超过5000项容量');
  const zones=new Map(),triggers=new Map(),types=new Set((r.catalogTypes??[]).map(x=>x._id));
  const pairKey=(c,z)=>JSON.stringify([c,z]);
  for(const x of r.catalogZones??[])if(validId(x._id.channel_id)&&validId(x._id.zone_id))zones.set(pairKey(x._id.channel_id,x._id.zone_id),{...x._id,name:x._id.zone_id});
  for(const x of r.catalogTriggers??[])if(validId(x._id))triggers.set(x._id,{trigger_id:x._id,name:x._id});
  for(const x of r.historicalNames??[]){
    const key=pairKey(x._id.channel_id,x._id.zone_id);
    if(zones.has(key)&&validId(x.zone_name))zones.get(key).name=x.zone_name;
    if(triggers.has(x._id.trigger_id)&&validId(x.trigger_name))triggers.get(x._id.trigger_id).name=x.trigger_name;
  }
  const rankZones=new Map(zones),rankTriggers=new Map(triggers);
  // Only bounded display names and stable identities leave the applied snapshot.
  for(const rule of rules){
    if(rule.alarm_enabled===false||rule.state&&rule.state!=='enabled')continue;
    const id=rule.trigger_id??rule.id;
    if(validId(id))triggers.set(id,{trigger_id:id,name:validId(rule.name)?rule.name:id});
    if(validId(rule.channel_id)&&validId(rule.zone_id))zones.set(pairKey(rule.channel_id,rule.zone_id),{channel_id:rule.channel_id,zone_id:rule.zone_id,name:validId(rule.zone_name)?rule.zone_name:rule.zone_id});
    if(validId(rule.behavior))types.add(rule.behavior);
  }
  if(zones.size>limits.catalog||triggers.size>limits.catalog||types.size>100)capacity('历史与当前配置合并后的筛选目录超过容量');
  const summary=Object.fromEntries((r.summary??[]).map(x=>[x._id,x.total]));
  const valid=(r.wait??[]).find(x=>x._id===true),invalid=(r.wait??[]).find(x=>x._id===false),human=(summary.human_confirmed??0)+(summary.human_false_positive??0);
  const trend=calendar;
  for(const x of r.trend??[]){const t=new Date(x._id).getTime(),bucket=trend.find(b=>t<Date.parse(b.to)&&Math.max(t,Date.parse(q.from))>=Date.parse(b.from));if(!bucket)fail('analytics_bucket','统计时间桶边界不一致，请缩短日期范围后重试',503);bucket.total+=x.total}
  const week=Array.from({length:7},()=>Array(24).fill(0));for(const x of r.week??[])week[x._id.day][x._id.hour]=x.total;
  const publicCounts=x=>({total:x.total,pending:x.pending,human_reviewed:x.human_reviewed,human_false_positive:x.human_false_positive});
  const result={schema_version:'1.0',...Object.fromEntries(['from','to','timezone','bucket'].map(k=>[k,q[k]])),as_of,
    total:Object.values(summary).reduce((a,b)=>a+b,0),pending:summary.pending??0,human_confirmed:summary.human_confirmed??0,human_false_positive:summary.human_false_positive??0,ai_reviewed:summary.ai_reviewed??0,unknown_review:summary.unknown??0,
    trend,zones:(r.zones??[]).map(x=>({...x._id,name:rankZones.get(pairKey(x._id.channel_id,x._id.zone_id))?.name??x._id.zone_id,...publicCounts(x)})),
    triggers:(r.triggers??[]).map(x=>({trigger_id:x._id,name:rankTriggers.get(x._id)?.name??x._id,...publicCounts(x),rule_versions:[...new Set((r.triggerVersions??[]).filter(v=>v._id.trigger_id===x._id).map(v=>v._id.version).filter(v=>Number.isSafeInteger(v)&&v>=0))].sort((a,b)=>a-b)})),
    types:(r.types??[]).map(x=>({id:x._id,total:x.total})),week,
    quality:{human_reviewed:human,false_positive_ratio:human?(summary.human_false_positive??0)/human:null,wait:{samples:valid?.n??0,median_ms:valid?(valid.n%2?valid.middle:valid.middle/2):null,p90_ms:valid?.p90??null,unknown:invalid?.n??0},pending_age:{lt10m:0,lt1h:0,gte1h:0,...Object.fromEntries((r.pendingAge??[]).map(x=>[x._id,x.total]))}},
    association:{unassociated:r.unassociated?.[0]?.total??0},catalog:{zones:[...zones.values()].sort((a,b)=>pairKey(a.channel_id,a.zone_id).localeCompare(pairKey(b.channel_id,b.zone_id))),triggers:[...triggers.values()].sort((a,b)=>a.trigger_id.localeCompare(b.trigger_id)),types:[...types].sort()},
    consistency:'non_transactional',coverage:'unknown',issues:['截止时间仅限制已入库记录；查询期间审核结论和合并阶段仍可能变化。','缺少完整采集覆盖分母，数量不代表风险发生率。','筛选目录使用当前配置名称；排名使用事件历史名称，缺失时显示稳定 ID。','旧阶段未保留执行规则版本关联，版本仅列出可核实的当前最高阶段快照。']};
  if(Buffer.byteLength(JSON.stringify(result))>limits.bytes)capacity('统计结果超过响应容量');
  return result;
}
