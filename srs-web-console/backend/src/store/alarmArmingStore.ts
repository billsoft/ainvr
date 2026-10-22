import {compileBinding,parseCounterDefinition,validateBindingSet,type BindingVersion,type CounterBinding,type CounterDefinition} from './flowCounters.js';
import {unwrapErp} from './erpGeometry.js';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {AlarmConfigError} from './alarmZones.js';
import {compileAssignment,parseTriggerDefinition,validateAssignmentSet,type AssignmentSource,type AssignmentZone,type TriggerAssignment} from './alarmTriggerDefinition.js';

const identifier=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const point=z.tuple([z.number().finite().min(0).max(1),z.number().finite().min(0).max(1)]);
const zoneSchema=z.object({
  zone_id:identifier,channel_id:identifier,geometry_revision:identifier,
  version:z.number().int().positive(),state:z.literal('active'),
  erp_wrap:z.boolean().optional(),name:z.string().trim().min(1).max(128),points:z.array(point).min(3).max(32),edge_ids:z.array(identifier).min(3).max(32),
}).strict();
const armingSchema=z.object({
  coordinate_space:z.enum(['planar','erp']).optional(),source_id:identifier,geometry_revision:identifier,zones:z.array(zoneSchema).max(1000),assignments:z.array(z.unknown()).max(1000),
  counter_bindings:z.array(z.unknown()).max(1000).optional(),
}).strict();
type Zone=z.infer<typeof zoneSchema>;
type Arming={coordinate_space?:'planar'|'erp';source_id:string;geometry_revision:string;zones:Zone[];assignments:TriggerAssignment[];counter_bindings:CounterBinding[]};
type Lookup=(processorId:string)=>Promise<AssignmentSource|null>;
function fail(code:string,message:string):never{
  const status=code==='source_unavailable'?503:
    ['version_conflict','idempotency_conflict','source_changed','assignment_identity','binding_identity','archived_trigger','counter_deleting'].includes(code)?409:code==='not_found'?404:422;
  throw new AlarmConfigError(code,message,status);
}
function geometry(points:[number,number][]){
  const cross=(a:number[],b:number[],c:number[])=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const on=(a:number[],b:number[],p:number[])=>Math.abs(cross(a,b,p))<1e-10&&p[0]>=Math.min(a[0],b[0])-1e-10&&p[0]<=Math.max(a[0],b[0])+1e-10&&p[1]>=Math.min(a[1],b[1])-1e-10&&p[1]<=Math.max(a[1],b[1])+1e-10;
  let area=0;
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length];
    if(Math.hypot(a[0]-b[0],a[1]-b[1])<1e-8)fail('invalid_geometry','顶点不能重合');
    area+=a[0]*b[1]-b[0]*a[1];
    for(let j=i+1;j<points.length;j++){
      if(j===i+1||i===0&&j===points.length-1)continue;
      const c=points[j],d=points[(j+1)%points.length];
      if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b))fail('invalid_geometry','区域边界不能交叉');
    }
  }
  if(Math.abs(area)<1e-8)fail('invalid_geometry','区域面积不能为零');
}
export class AlarmArmingStore {
  constructor(private pool:Pool){}
  async listDefinitions(){
    const rows=await this.pool.query(`SELECT d.document,d.version,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'assignment_id',a.assignment_id,'source_id',a.source_id,'processor_id',a.document->>'processor_id',
        'zone_name',(SELECT z->>'name' FROM jsonb_array_elements(s.document->'zones') z
          WHERE z->>'zone_id'=a.document->>'zone_id')
      ) ORDER BY a.assignment_id) FROM alarm_trigger_assignments a
      JOIN alarm_arming_sources s ON s.source_id=a.source_id
      WHERE a.trigger_id=d.trigger_id AND a.active=TRUE),'[]'::jsonb) AS usages
      FROM alarm_trigger_definitions d ORDER BY d.trigger_id LIMIT 1001`);
    if(rows.rows.length>1000)fail('capacity','触发器数量超过上限');
    return rows.rows.map(r=>({...r.document,version:r.version,usages:r.usages}));
  }
  async readArming(sourceId:string){
    if(!identifier.safeParse(sourceId).success)fail('invalid_source','来源编号无效');
    const row=(await this.pool.query('SELECT document,revision FROM alarm_arming_sources WHERE source_id=$1',[sourceId])).rows[0];
    return row?{counter_bindings:[],...row.document,revision:row.revision}:null;
  }
  private async operation<T>(kind:string,input:unknown,expected:number,actor:string,key:string,run:(c:PoolClient)=>Promise<T>):Promise<T>{
    if(!Number.isInteger(expected)||expected<0||expected>=2147483646||!identifier.safeParse(actor).success||!identifier.safeParse(key).success)fail('invalid_operation','操作身份、版本或编号无效');
    const hash=createHash('sha256').update(JSON.stringify([kind,input,expected])).digest('hex'),c=await this.pool.connect();
    try{
      await c.query('BEGIN');
      // Shared lock covers definitions, sources and assignments; snapshots see an
      // atomic configuration. No external calls to the alarm service occur here.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('alarm-arming-configuration',0))");
      const old=(await c.query('SELECT request_hash,response FROM alarm_config_operations WHERE actor=$1 AND operation_key=$2',[actor,key])).rows[0];
      if(old){
        if(old.request_hash!==hash)fail('idempotency_conflict','操作编号已用于其他内容');
        await c.query('COMMIT');return old.response;
      }
      const result=await run(c);
      await c.query('INSERT INTO alarm_config_operations(actor,operation_key,request_hash,response) VALUES($1,$2,$3,$4)',[actor,key,hash,JSON.stringify(result)]);
      await c.query('COMMIT');return result;
    }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}
    finally{c.release();}
  }
  private async bump(c:PoolClient){
    return (await c.query('UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton=TRUE RETURNING revision::text')).rows[0].revision as string;
  }
  private async writeSource(c:PoolClient,document:Arming,revision:number,actor:string){
    await c.query('INSERT INTO alarm_arming_sources(source_id,revision,document) VALUES($1,$2,$3) ON CONFLICT(source_id) DO UPDATE SET revision=EXCLUDED.revision,document=EXCLUDED.document,updated_at=now()',[document.source_id,revision,JSON.stringify(document)]);
    await c.query('INSERT INTO alarm_arming_versions(source_id,revision,document,actor) VALUES($1,$2,$3,$4)',[document.source_id,revision,JSON.stringify(document),actor]);
  }
  async saveDefinition(input:unknown,expected:number,actor:string,key:string,lookup:Lookup){
    const definition=parseTriggerDefinition(input);
    return this.operation('definition',definition,expected,actor,key,async c=>{
      const old=(await c.query('SELECT document,version FROM alarm_trigger_definitions WHERE trigger_id=$1',[definition.trigger_id])).rows[0];
      if((old?.version??0)!==expected)fail('version_conflict','触发器已变化，请重新读取');
      if(old?.document.state==='archived')fail('archived_trigger','已归档触发器不能直接修改');
      const version=expected+1;
      await c.query('INSERT INTO alarm_trigger_definitions(trigger_id,version,document) VALUES($1,$2,$3) ON CONFLICT(trigger_id) DO UPDATE SET version=EXCLUDED.version,document=EXCLUDED.document,updated_at=now()',[definition.trigger_id,version,JSON.stringify(definition)]);
      await c.query('INSERT INTO alarm_trigger_definition_versions(trigger_id,version,document,actor) VALUES($1,$2,$3,$4)',[definition.trigger_id,version,JSON.stringify(definition),actor]);
      const rows=(await c.query('SELECT * FROM alarm_trigger_assignments WHERE trigger_id=$1 AND active=TRUE',[definition.trigger_id])).rows;
      for(const row of rows){
        const assignment=row.document as TriggerAssignment;
        const sourceDoc=(await c.query('SELECT document FROM alarm_arming_sources WHERE source_id=$1',[row.source_id])).rows[0].document as Arming;
        let rule=null;
        if(definition.state==='enabled'){
          const source=await lookup(assignment.processor_id);
          if(!source)fail('source_unavailable','来源暂不可用，请保留草稿');
          rule=compileAssignment(definition,version,assignment,source,sourceDoc.zones.find(z=>z.zone_id===assignment.zone_id)??null,row.execution_version+1);
        }
        await c.query('UPDATE alarm_trigger_assignments SET compiled_rule=$2,execution_version=execution_version+1,active=$3,updated_at=now() WHERE assignment_id=$1',[assignment.assignment_id,rule?JSON.stringify(rule):null,definition.state!=='archived']);
      }
      if(definition.state==='archived'){
        for(const sourceId of new Set(rows.map(r=>r.source_id))){
          const row=(await c.query('SELECT document,revision FROM alarm_arming_sources WHERE source_id=$1',[sourceId])).rows[0];
          const doc=row.document as Arming;doc.assignments=doc.assignments.filter(a=>a.trigger_id!==definition.trigger_id);
          await this.writeSource(c,doc,row.revision+1,actor);
        }
      }
      return {saved:true as const,trigger:{...definition,version},application:{state:'pending' as const,desired_revision:await this.bump(c)}};
    });
  }
  /** Compile one binding; an unchanged rule keeps its version so counting state is not reset. */
  private async writeBinding(c:PoolClient,sourceId:string,b:CounterBinding,definition:CounterDefinition,definitionVersion:number,source:AssignmentSource,zone:Zone|null,previous:{execution_version:number;compiled_rule:any;active:boolean}|undefined){
    let version=(previous?.execution_version??0)+1;
    let rule:any=compileBinding({...definition,state:'enabled'},definitionVersion,b,source,zone,version);
    if(previous?.active&&previous.compiled_rule&&definition.state==='enabled'){
      const unchanged=JSON.parse(JSON.stringify({...rule,version:previous.execution_version,source_binding:{...rule.source_binding,not_before:previous.compiled_rule.source_binding?.not_before}}));
      if(isDeepStrictEqual(unchanged,previous.compiled_rule)){version=previous.execution_version;rule=previous.compiled_rule;}
    }
    await c.query(`INSERT INTO flow_counter_bindings(binding_id,source_id,counter_id,execution_version,document,compiled_rule,active)
      VALUES($1,$2,$3,$4,$5,$6,TRUE) ON CONFLICT(binding_id) DO UPDATE SET execution_version=EXCLUDED.execution_version,
      document=EXCLUDED.document,compiled_rule=EXCLUDED.compiled_rule,active=TRUE,updated_at=now()`,
      [b.binding_id,sourceId,b.counter_id,version,JSON.stringify(b),definition.state==='enabled'?JSON.stringify(rule):null]);
  }
  /** A new counting line applies from now; earlier passages keep their meaning unless recounted explicitly. */
  private async recordLine(c:PoolClient,b:CounterBinding,recount:boolean,actor:string){
    const last=(await c.query('SELECT seq,direction FROM flow_counter_binding_versions WHERE binding_id=$1 ORDER BY seq DESC LIMIT 1',[b.binding_id])).rows[0];
    if(last&&isDeepStrictEqual(last.direction,b.direction))return;
    await c.query('INSERT INTO flow_counter_binding_versions(binding_id,seq,direction,reclassify,actor,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp())',
      [b.binding_id,(last?.seq??0)+1,JSON.stringify(b.direction),!!last&&recount,actor]);
  }
  async listCounters(){
    const rows=await this.pool.query(`SELECT d.document,d.version,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('binding_id',b.binding_id,'source_id',b.source_id,'processor_id',b.document->>'processor_id',
        'zone_id',b.document->>'zone_id','active',b.active,'counting',b.compiled_rule IS NOT NULL,'direction',b.document->'direction',
        'zone_name',(SELECT z->>'name' FROM alarm_arming_sources s,jsonb_array_elements(s.document->'zones') z WHERE s.source_id=b.source_id AND z->>'zone_id'=b.document->>'zone_id')
      ) ORDER BY b.created_at,b.binding_id) FROM flow_counter_bindings b WHERE b.counter_id=d.counter_id AND b.active),'[]'::jsonb) AS bindings
      FROM flow_counter_definitions d ORDER BY d.counter_id LIMIT 1001`);
    if(rows.rows.length>1000)fail('capacity','计数器数量超过上限');
    return rows.rows.map(r=>({...r.document,version:r.version,bindings:r.bindings}));
  }
  async saveCounter(input:unknown,expected:number,actor:string,key:string,lookup:Lookup){
    const definition=parseCounterDefinition(input);
    return this.operation('counter',definition,expected,actor,key,async c=>{
      const old=(await c.query('SELECT document,version FROM flow_counter_definitions WHERE counter_id=$1',[definition.counter_id])).rows[0];
      if((old?.version??0)!==expected)fail('version_conflict','计数器已变化，请重新读取');
      if(old?.document.deleting)fail('counter_deleting','计数器正在删除，不能修改');
      if(old&&old.document.method!==definition.method)fail('invalid_counter','已有计数器不能更改计数方式，请新建计数器');
      const version=expected+1;
      await c.query('INSERT INTO flow_counter_definitions(counter_id,version,document) VALUES($1,$2,$3) ON CONFLICT(counter_id) DO UPDATE SET version=EXCLUDED.version,document=EXCLUDED.document,updated_at=now()',[definition.counter_id,version,JSON.stringify(definition)]);
      await c.query('INSERT INTO flow_counter_definition_versions(counter_id,version,document,actor) VALUES($1,$2,$3,$4)',[definition.counter_id,version,JSON.stringify(definition),actor]);
      const rows=(await c.query('SELECT * FROM flow_counter_bindings WHERE counter_id=$1 AND active=TRUE',[definition.counter_id])).rows;
      const sameLabels=!!old&&JSON.stringify(old.document.labels.map((l:{label_id:string})=>l.label_id))===JSON.stringify(definition.labels.map(l=>l.label_id));
      for(const row of rows){
        let rule=null;
        if(definition.state==='enabled'){
          const sourceDoc=(await c.query('SELECT document FROM alarm_arming_sources WHERE source_id=$1',[row.source_id])).rows[0].document as Arming;
          const zone=sourceDoc.zones.find(z=>z.zone_id===row.document.zone_id)??null;
          const frozen=row.compiled_rule?.source_binding;
          // Name or gap edits reuse the frozen source evidence, so an offline camera cannot block them.
          const source:AssignmentSource|null=sameLabels&&frozen?{channel_id:row.document.processor_id,input_stream_id:frozen.input_stream_id,geometry_revision:frozen.geometry_revision,
            label_map_version:frozen.label_map_version,tracking_available:true,labels:definition.labels.map(l=>({label_id:l.label_id})),width:frozen.width,height:frozen.height,
            stream_fingerprint:frozen.stream_fingerprint,observed_at:frozen.not_before}:await lookup(row.document.processor_id);
          if(!source)fail('source_unavailable','来源暂不可用，请稍后重试');
          rule=compileBinding(definition,version,row.document,source!,zone,row.execution_version+1);
        }
        // A name change does not alter the judgement: keep the execution version so passages in progress still count.
        const same=(a:any,b:any)=>!!a&&!!b&&isDeepStrictEqual({...a,name:0,trigger_version:0,version:0,source_binding:{...a.source_binding,not_before:0}},{...b,name:0,trigger_version:0,version:0,source_binding:{...b.source_binding,not_before:0}});
        const keep=rule&&same(rule,row.compiled_rule);
        if(keep)rule={...rule,version:row.execution_version,source_binding:row.compiled_rule.source_binding};
        await c.query('UPDATE flow_counter_bindings SET compiled_rule=$2,execution_version=$3,updated_at=now() WHERE binding_id=$1',[row.binding_id,rule?JSON.stringify(rule):null,keep?row.execution_version:row.execution_version+1]);
      }
      return {saved:true as const,counter:{...definition,version},application:{state:'pending' as const,desired_revision:await this.bump(c)}};
    });
  }
  /** Deleting, step 1: stop counting everywhere and mark the counter. A retry of an
   * unfinished delete is accepted at any version. Returns every binding whose records must go. */
  async beginDeleteCounter(counterId:string,expected:number,actor:string,key:string){
    return this.operation('delete-counter',{counterId},expected,actor,key,async c=>{
      const old=(await c.query('SELECT document,version FROM flow_counter_definitions WHERE counter_id=$1',[counterId])).rows[0];
      if(!old)fail('not_found','计数器不存在');
      const rows=(await c.query('SELECT binding_id,source_id,active FROM flow_counter_bindings WHERE counter_id=$1 ORDER BY binding_id',[counterId])).rows;
      if(!old.document.deleting){
        if(old.version!==expected)fail('version_conflict','计数器已变化，请重新读取');
        for(const sourceId of new Set(rows.filter(r=>r.active).map(r=>r.source_id))){
          const row=(await c.query('SELECT document,revision FROM alarm_arming_sources WHERE source_id=$1',[sourceId])).rows[0];
          const doc=row.document as Arming;doc.counter_bindings=(doc.counter_bindings??[]).filter(b=>b.counter_id!==counterId);
          await this.writeSource(c,doc,row.revision+1,actor);
        }
        await c.query('UPDATE flow_counter_bindings SET active=FALSE,compiled_rule=NULL,updated_at=now() WHERE counter_id=$1',[counterId]);
        const document={...old.document,deleting:true};
        await c.query('UPDATE flow_counter_definitions SET version=$2,document=$3,updated_at=now() WHERE counter_id=$1',[counterId,old.version+1,JSON.stringify(document)]);
        await c.query('INSERT INTO flow_counter_definition_versions(counter_id,version,document,actor) VALUES($1,$2,$3,$4)',[counterId,old.version+1,JSON.stringify(document),actor]);
        await this.bump(c);
      }
      return {binding_ids:rows.map(r=>r.binding_id as string)};
    });
  }
  /** Deleting, step 2 (after the records are purged): remove the definition and its history. */
  async finishDeleteCounter(counterId:string){
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('alarm-arming-configuration',0))");
      const old=(await c.query('SELECT document FROM flow_counter_definitions WHERE counter_id=$1',[counterId])).rows[0];
      // A successful delete can be replayed after its response was lost.
      if(!old){await c.query('COMMIT');return;}
      if(!old.document.deleting)fail('invalid_counter','计数器未在删除中');
      await c.query('DELETE FROM flow_counter_binding_versions WHERE binding_id IN (SELECT binding_id FROM flow_counter_bindings WHERE counter_id=$1)',[counterId]);
      await c.query('DELETE FROM flow_counter_bindings WHERE counter_id=$1',[counterId]);
      await c.query('DELETE FROM flow_counter_definition_versions WHERE counter_id=$1',[counterId]);
      await c.query('DELETE FROM flow_counter_definitions WHERE counter_id=$1',[counterId]);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
  }
  /** All binding rows of the given counters, removed ones included, for history queries. */
  async counterBindings(counterIds:string[]){
    return (await this.pool.query(`SELECT b.binding_id,b.source_id,b.counter_id,b.document,b.active,b.compiled_rule IS NOT NULL AS counting,b.created_at,b.updated_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('seq',v.seq,'direction',v.direction,'reclassify',v.reclassify,'effective_from',v.effective_from) ORDER BY v.seq)
        FROM flow_counter_binding_versions v WHERE v.binding_id=b.binding_id),'[]'::jsonb) AS versions,
      (SELECT z->>'name' FROM alarm_arming_sources s,jsonb_array_elements(s.document->'zones') z WHERE s.source_id=b.source_id AND z->>'zone_id'=b.document->>'zone_id') AS zone_name
      FROM flow_counter_bindings b WHERE b.counter_id=ANY($1::text[]) ORDER BY b.created_at,b.binding_id`,[counterIds])).rows as {binding_id:string;source_id:string;counter_id:string;document:CounterBinding;active:boolean;counting:boolean;zone_name:string|null;created_at:Date;updated_at:Date;versions:BindingVersion[]}[];
  }
  /** Target lists per definition version, for history queries. */
  async definitionHistory(counterIds:string[]){
    return (await this.pool.query('SELECT counter_id,document->\'labels\' AS labels,created_at FROM flow_counter_definition_versions WHERE counter_id=ANY($1::text[]) ORDER BY created_at',[counterIds])).rows as {counter_id:string;labels:{label_id:string}[];created_at:Date}[];
  }
  async saveArming(input:unknown,expected:number,actor:string,key:string,lookup:Lookup,sourceGeometry:(id:string)=>Promise<string|null>){
    const parsed=armingSchema.safeParse(input);
    if(!parsed.success)fail('invalid_arming','布防参数无效');
    const bindingInputs=validateBindingSet(parsed.data.counter_bindings??[]);
    // "Recount history" is an instruction for this save only; the stored selection never carries it.
    const recount=new Set(bindingInputs.filter(b=>b.reclassify_history).map(b=>b.binding_id));
    const doc:Arming={...parsed.data,assignments:validateAssignmentSet(parsed.data.assignments),counter_bindings:bindingInputs.map(({reclassify_history:_,...b})=>b)};
    const zoneIds=new Set<string>(),names=new Set<string>();
    for(const z of doc.zones){
      if(z.erp_wrap&&doc.coordinate_space!=='erp')fail('panorama_confirmation_required','请先明确确认来源画面是全景画面，普通相机不能使用全景环绕区域');
      if(z.channel_id!==doc.source_id||z.geometry_revision!==doc.geometry_revision)fail('source_changed','区域来源不匹配');
      if(zoneIds.has(z.zone_id)||names.has(z.name))fail('invalid_zone','区域编号或名称重复');
      zoneIds.add(z.zone_id);names.add(z.name);try { geometry(z.erp_wrap?unwrapErp(z.points):z.points); } catch(error) { if(error instanceof AlarmConfigError)throw error; fail('invalid_geometry','全景区域边界不明确，请拆分为较小区域后重试'); }
      if(z.edge_ids.length!==z.points.length||new Set(z.edge_ids).size!==z.edge_ids.length)fail('invalid_direction','边编号无效');
    }
    for(const a of doc.assignments){
      if(a.input_stream_id!==doc.source_id||a.geometry_revision!==doc.geometry_revision)fail('source_changed','选用来源不匹配');
      if(a.zone_id!==null&&!zoneIds.has(a.zone_id))fail('zone_required','删除区域时必须解除选用');
    }
    for(const b of doc.counter_bindings){
      if(b.input_stream_id!==doc.source_id||b.geometry_revision!==doc.geometry_revision)fail('source_changed','计数选用来源不匹配');
      if(!zoneIds.has(b.zone_id))fail('zone_required','删除区域时必须解除计数选用');
    }
    return this.operation('arming',doc,expected,actor,key,async c=>{
      const current=await sourceGeometry(doc.source_id);
      if(current===null)fail('source_unavailable','来源暂不可用，请保留草稿');
      if(current!==doc.geometry_revision)fail('source_changed','画面规格已变化，请重新读取');
      const old=(await c.query('SELECT revision,document FROM alarm_arming_sources WHERE source_id=$1',[doc.source_id])).rows[0];
      if((old?.revision??0)!==expected)fail('version_conflict','布防已修改，请重新读取');
      for(const z of doc.zones){
        const previous=(old?.document.zones as Zone[]|undefined)?.find(p=>p.zone_id===z.zone_id);
        const changed=previous&&!isDeepStrictEqual({...previous,version:0},{...z,version:0});
        const required=previous?previous.version+(changed?1:0):1;
        if(z.version!==required)fail('version_conflict','区域版本无效');
      }
      await this.writeSource(c,doc,expected+1,actor);
      for(const a of doc.assignments){
        const previous=(await c.query('SELECT source_id,trigger_id,execution_version,compiled_rule,active FROM alarm_trigger_assignments WHERE assignment_id=$1',[a.assignment_id])).rows[0];
        if(previous&&(previous.source_id!==doc.source_id||previous.trigger_id!==a.trigger_id))fail('assignment_identity','选用编号不能迁移到其他来源或触发器');
        const trigger=(await c.query('SELECT document,version FROM alarm_trigger_definitions WHERE trigger_id=$1',[a.trigger_id])).rows[0];
        if(!trigger||trigger.document.state==='archived')fail('trigger_unavailable','触发器不存在或已归档');
        const source=await lookup(a.processor_id);
        if(!source)fail('source_unavailable','来源暂不可用，请保留草稿');
        // Validate all assignments even when the definition is paused. Only the
        // persisted rule is disabled, not the compatibility checks.
        let version=(previous?.execution_version??0)+1;
        let rule=compileAssignment({...trigger.document,state:'enabled'},trigger.version,a,source,doc.zones.find(z=>z.zone_id===a.zone_id)??null,version);
        if(rule&&previous?.active&&previous.compiled_rule&&trigger.document.state==='enabled'){
          // A full arming snapshot also contains untouched assignments. Do not
          // reset their activities merely because another zone was edited or a
          // fresh catalog observation has a later timestamp.
          const unchangedCandidate=JSON.parse(JSON.stringify({...rule,
            version:previous.execution_version,
            source_binding:{...rule.source_binding,not_before:previous.compiled_rule.source_binding?.not_before},
          }));
          if(isDeepStrictEqual(unchangedCandidate,previous.compiled_rule)){
            version=previous.execution_version;
            rule=previous.compiled_rule;
          }
        }
        await c.query(`INSERT INTO alarm_trigger_assignments(assignment_id,source_id,trigger_id,execution_version,document,compiled_rule,active)
          VALUES($1,$2,$3,$4,$5,$6,TRUE) ON CONFLICT(assignment_id) DO UPDATE SET execution_version=EXCLUDED.execution_version,
          document=EXCLUDED.document,compiled_rule=EXCLUDED.compiled_rule,active=TRUE,updated_at=now()`,
          [a.assignment_id,doc.source_id,a.trigger_id,version,JSON.stringify(a),trigger.document.state==='enabled'?JSON.stringify(rule):null]);
      }
      await c.query('UPDATE alarm_trigger_assignments SET active=FALSE,compiled_rule=NULL,updated_at=now() WHERE source_id=$1 AND NOT (assignment_id=ANY($2::text[]))',[doc.source_id,doc.assignments.map(a=>a.assignment_id)]);
      for(const b of doc.counter_bindings){
        const previous=(await c.query('SELECT source_id,counter_id,execution_version,compiled_rule,active FROM flow_counter_bindings WHERE binding_id=$1',[b.binding_id])).rows[0];
        if(previous&&(previous.source_id!==doc.source_id||previous.counter_id!==b.counter_id))fail('binding_identity','计数选用编号不能迁移到其他来源或计数器');
        const counter=(await c.query('SELECT document,version FROM flow_counter_definitions WHERE counter_id=$1',[b.counter_id])).rows[0];
        if(!counter||counter.document.deleting)fail('counter_unavailable','计数器不存在或正在删除');
        const source=await lookup(b.processor_id);
        if(!source)fail('source_unavailable','来源暂不可用，请保留草稿');
        await this.writeBinding(c,doc.source_id,b,counter.document,counter.version,source,doc.zones.find(z=>z.zone_id===b.zone_id)??null,previous);
        await this.recordLine(c,b,recount.has(b.binding_id),actor);
      }
      await c.query('UPDATE flow_counter_bindings SET active=FALSE,compiled_rule=NULL,updated_at=now() WHERE source_id=$1 AND NOT (binding_id=ANY($2::text[]))',[doc.source_id,doc.counter_bindings.map(b=>b.binding_id)]);
      return {saved:true as const,sourceId:doc.source_id,revision:expected+1,application:{state:'pending' as const,desired_revision:await this.bump(c)}};
    });
  }
  async snapshot(){
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const revision=(await c.query('SELECT revision::text FROM alarm_configuration_revision WHERE singleton=TRUE')).rows[0].revision as string;
      const rules=(await c.query(`SELECT compiled_rule FROM alarm_trigger_assignments WHERE active=TRUE AND compiled_rule IS NOT NULL
        UNION ALL SELECT compiled_rule FROM flow_counter_bindings WHERE active=TRUE AND compiled_rule IS NOT NULL`)).rows.map(r=>r.compiled_rule)
        .sort((a,b)=>String(a.id).localeCompare(String(b.id)));
      await c.query('COMMIT');return {schema_version:'1.0',revision,rules};
    }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
  }
}
