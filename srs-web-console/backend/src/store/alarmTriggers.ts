import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {AlarmConfigError} from './alarmZones.js';
import {alarmScheduleSchema} from './alarmSchedule.js';

// A trigger detects one behavior on one or more AI channels; each channel binds its
// own zone, direction (zone edge indexes; empty = any) and approach range in pixels.
const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const behaviors=['appearance','region_approach','region_enter','region_traverse'] as const;
const edges=z.array(z.number().int().min(0).max(31)).max(32);
const binding=z.object({channel_id:id,label_map_version:id,geometry_revision:id,zone_id:id.nullable(),zone_version:z.number().int().positive().nullable(),
  direction:z.object({entry_edges:edges,exit_edges:edges}).strict(),approach_px:z.number().int().min(1).max(4000).optional()}).strict();
const label=z.object({label_id:id,name:z.string().min(1).max(256)}).strict();
const schema=z.object({trigger_id:id,name:z.string().trim().min(1).max(128),behavior:z.enum(behaviors),labels:z.array(label).min(1).max(128),
  duration_ms:z.number().int().min(0).max(3600000),alarm_enabled:z.boolean(),state:z.enum(['draft','enabled','paused','archived']),
  schedule:alarmScheduleSchema.default({mode:'always'}),bindings:z.array(binding).min(1).max(64)}).strict();
/** Obtained by the BFF from the actual input/model configuration, never from request claims. */
export interface TriggerSourceCatalog {channel_id:string;input_stream_id:string;label_map_version:string;label_ids:string[];labels?:{label_id:string;name?:string;description?:string}[];geometry_revision:string;tracking_available:boolean;width?:number;height?:number;observed_at?:string;stream_fingerprint?:string}
type Lookup=(channelId:string)=>Promise<TriggerSourceCatalog|null>;
const invalid=(message:string)=>new AlarmConfigError('invalid_trigger',message);
function check(trigger:z.infer<typeof schema>){
  const zoned=trigger.behavior!=='appearance';
  if(new Set(trigger.labels.map(l=>l.label_id)).size!==trigger.labels.length)throw invalid('目标不能重复');
  if(new Set(trigger.bindings.map(b=>b.channel_id)).size!==trigger.bindings.length)throw invalid('同一通道只能绑定一次');
  if(!zoned&&trigger.duration_ms<0)throw invalid('持续时间无效');
  if(zoned&&trigger.duration_ms!==0)throw invalid('只有出现使用持续时间');
  for(const b of trigger.bindings){
    if(!zoned&&(b.zone_id!==null||b.zone_version!==null||b.direction.entry_edges.length||b.direction.exit_edges.length))throw invalid('出现按全画面判断，不使用热区和方向');
    if(zoned&&(b.zone_id===null||b.zone_version===null))throw new AlarmConfigError('zone_required','接近、碰撞侵入和穿过需要为每个通道选择热区');
    if((trigger.behavior==='region_approach')!==(b.approach_px!==undefined))throw invalid('接近范围只用于接近，且必须设置');
    const {entry_edges:entry,exit_edges:exit}=b.direction;
    if(new Set(entry).size!==entry.length||new Set(exit).size!==exit.length||entry.some(e=>exit.includes(e))||(trigger.behavior!=='region_traverse'&&exit.length))
      throw new AlarmConfigError('invalid_direction','方向的边重复或与行为不匹配');
  }
}
export class AlarmTriggerStore {
  constructor(private pool:Pool){}
  async list(){
    const result=await this.pool.query('SELECT document,version FROM alarm_triggers ORDER BY trigger_id LIMIT 1001');
    if(result.rows.length>1000)throw new AlarmConfigError('trigger_capacity','触发器数量超过上限',503);
    return result.rows.map(r=>({...r.document,version:r.version}));
  }
  async save(input:unknown,expected:number,actor:string,key:string,lookup:Lookup){
    const parsed=schema.safeParse(input);
    if(!parsed.success)throw invalid('触发器参数无效');
    const trigger=parsed.data;check(trigger);
    if(!Number.isInteger(expected)||expected<0||expected>=2147483647||!id.safeParse(actor).success||!id.safeParse(key).success)throw new AlarmConfigError('invalid_operation','版本或操作编号无效');
    const catalogs=await Promise.all(trigger.bindings.map(b=>lookup(b.channel_id).catch(()=>null)));
    const hash=createHash('sha256').update(JSON.stringify(['trigger',trigger,expected])).digest('hex');
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`alarm-operation:${actor}:${key}`]);
      const prior=await client.query('SELECT request_hash,response FROM alarm_config_operations WHERE actor=$1 AND operation_key=$2',[actor,key]);
      if(prior.rows.length){
        if(prior.rows[0].request_hash!==hash)throw new AlarmConfigError('idempotency_conflict','操作编号已用于其他内容',409);
        await client.query('COMMIT');return prior.rows[0].response;
      }
      const bindings=[];
      for(const [index,b] of trigger.bindings.entries()){
        const catalog=catalogs[index];
        if(!catalog||!id.safeParse(catalog.input_stream_id).success)throw new AlarmConfigError('source_unavailable','通道来源或标签目录暂不可用，请检查 AI 通道状态',409);
        if(catalog.channel_id!==b.channel_id||catalog.label_map_version!==b.label_map_version||catalog.geometry_revision!==b.geometry_revision||trigger.labels.some(l=>!catalog.label_ids.includes(l.label_id)||
          // Same class number in another model can be another target: names must agree.
          (catalog.labels&&!catalog.labels.some(c=>c.label_id===l.label_id&&(c.name||c.description||c.label_id)===l.name))))
          throw new AlarmConfigError('source_changed','通道来源或模型目标已经改变，请重新确认',409);
        if(trigger.state==='enabled'&&!catalog.tracking_available)throw new AlarmConfigError('tracking_required','请先在 AI 通道开启并验证目标跟踪',409);
        let zone=null;
        if(b.zone_id){
          const row=(await client.query('SELECT document,version,channel_id FROM alarm_zones WHERE zone_id=$1 FOR SHARE',[b.zone_id])).rows[0];
          if(!row||row.version!==b.zone_version||row.channel_id!==catalog.input_stream_id||row.document.state!=='active'||row.document.geometry_revision!==b.geometry_revision||!(row.document.points?.length>=3))
            throw new AlarmConfigError('zone_changed','热区已经改变，请重新选择并确认',409);
          if([...b.direction.entry_edges,...b.direction.exit_edges].some(e=>e>=row.document.points.length))throw new AlarmConfigError('invalid_direction','方向引用了热区不存在的边');
          zone={zone_id:row.document.zone_id,name:row.document.name,points:row.document.points,version:row.version};
        }
        // Freeze source and zone so a later edit cannot move an enabled trigger.
        const source=catalog.stream_fingerprint&&catalog.width&&catalog.height&&catalog.observed_at?{stream_fingerprint:catalog.stream_fingerprint,width:catalog.width,height:catalog.height,
          not_before:catalog.observed_at,input_stream_id:catalog.input_stream_id,label_map_version:catalog.label_map_version,geometry_revision:catalog.geometry_revision}:null;
        bindings.push({...b,input_stream_id:catalog.input_stream_id,source_binding:source,zone_snapshot:zone});
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`alarm-trigger:${trigger.trigger_id}`]);
      const current=await client.query('SELECT version FROM alarm_triggers WHERE trigger_id=$1 FOR UPDATE',[trigger.trigger_id]);
      if((current.rows[0]?.version??0)!==expected)throw new AlarmConfigError('version_conflict','触发器已修改，请重新载入',409);
      const document={...trigger,bindings},version=expected+1;
      await this.write(client,trigger.trigger_id,version,document,actor);
      const response={trigger:{...document,version},saved:true,application:{state:'pending',desired_revision:await this.bump(client)}};
      await client.query('INSERT INTO alarm_config_operations(actor,operation_key,request_hash,response) VALUES($1,$2,$3,$4)',[actor,key,hash,JSON.stringify(response)]);
      await client.query('COMMIT');return response;
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
    finally{client.release();}
  }
  async setState(triggerId:string,state:unknown,expected:number,actor:string,key:string){
    if(!id.safeParse(triggerId).success||!['paused','archived'].includes(String(state))||typeof state!=='string'||
       !Number.isInteger(expected)||expected<1||expected>=2147483647||!id.safeParse(actor).success||!id.safeParse(key).success)
      throw new AlarmConfigError('invalid_operation','状态、版本或操作编号无效');
    const hash=createHash('sha256').update(JSON.stringify(['trigger-state',triggerId,state,expected])).digest('hex');
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`alarm-operation:${actor}:${key}`]);
      const prior=await client.query('SELECT request_hash,response FROM alarm_config_operations WHERE actor=$1 AND operation_key=$2',[actor,key]);
      if(prior.rows.length){
        if(prior.rows[0].request_hash!==hash)throw new AlarmConfigError('idempotency_conflict','操作编号已用于其他内容',409);
        await client.query('COMMIT');return prior.rows[0].response;
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`alarm-trigger:${triggerId}`]);
      const current=(await client.query('SELECT document,version FROM alarm_triggers WHERE trigger_id=$1 FOR UPDATE',[triggerId])).rows[0];
      if(!current)throw new AlarmConfigError('not_found','触发器不存在',404);
      if(current.version!==expected)throw new AlarmConfigError('version_conflict','触发器已修改，请重新载入',409);
      if(current.document.state==='archived'&&state!=='archived')throw new AlarmConfigError('archived_trigger','已归档的触发器需要重新编辑确认',409);
      const document={...current.document,state},version=expected+1;
      await this.write(client,triggerId,version,document,actor);
      const response={trigger:{...document,version},saved:true,application:{state:'pending',desired_revision:await this.bump(client)}};
      await client.query('INSERT INTO alarm_config_operations(actor,operation_key,request_hash,response) VALUES($1,$2,$3,$4)',[actor,key,hash,JSON.stringify(response)]);
      await client.query('COMMIT');return response;
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
    finally{client.release();}
  }
  private async write(client:{query:Pool['query']},triggerId:string,version:number,document:unknown,actor:string){
    await client.query('INSERT INTO alarm_triggers(trigger_id,version,document) VALUES($1,$2,$3) ON CONFLICT(trigger_id) DO UPDATE SET version=EXCLUDED.version,document=EXCLUDED.document,updated_at=now()',[triggerId,version,JSON.stringify(document)]);
    await client.query('INSERT INTO alarm_trigger_versions(trigger_id,version,document,actor) VALUES($1,$2,$3,$4)',[triggerId,version,JSON.stringify(document),actor]);
  }
  private async bump(client:{query:Pool['query']}){
    return (await client.query('UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton=TRUE RETURNING revision::text')).rows[0].revision as string;
  }
  /** One execution rule per enabled trigger and bound channel. */
  async snapshot(){
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const revision=await client.query('SELECT revision::text FROM alarm_configuration_revision WHERE singleton=TRUE');
      const rows=await client.query("SELECT document,version FROM alarm_triggers WHERE document->>'state'='enabled' ORDER BY trigger_id LIMIT 1001");
      if(rows.rows.length>1000)throw new AlarmConfigError('trigger_capacity','触发器数量超过上限',503);
      const rules=rows.rows.flatMap(({document:t,version})=>t.bindings.map((b:Record<string,any>)=>({
        id:`${t.trigger_id}@${b.channel_id}`,trigger_id:t.trigger_id,version,name:t.name,channel_id:b.channel_id,input_stream_id:b.input_stream_id,state:'enabled',
        label_ids:t.labels.map((l:{label_id:string})=>l.label_id),label_map_version:b.label_map_version,geometry_revision:b.geometry_revision,
        zone_id:b.zone_id,zone_version:b.zone_version,points:b.zone_snapshot?.points,behavior:t.behavior,source_binding:b.source_binding??null,
        duration_ms:t.duration_ms,entry_edges:b.direction.entry_edges,exit_edges:b.direction.exit_edges,
        ...(b.approach_px!==undefined?{approach_px:b.approach_px}:{}),
        alarm_enabled:t.alarm_enabled,review:{enabled:false},schedule:t.schedule??{mode:'always'},
      })));
      await client.query('COMMIT');
      return {schema_version:'1.0',revision:revision.rows[0].revision,rules};
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
    finally{client.release();}
  }
}
