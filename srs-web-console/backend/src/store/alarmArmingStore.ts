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
}).strict();
type Zone=z.infer<typeof zoneSchema>;
type Arming={coordinate_space?:'planar'|'erp';source_id:string;geometry_revision:string;zones:Zone[];assignments:TriggerAssignment[]};
type Lookup=(processorId:string)=>Promise<AssignmentSource|null>;
function fail(code:string,message:string):never{
  const status=code==='source_unavailable'?503:
    ['version_conflict','idempotency_conflict','source_changed','assignment_identity','archived_trigger'].includes(code)?409:422;
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
    return row?{...row.document,revision:row.revision}:null;
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
  async saveArming(input:unknown,expected:number,actor:string,key:string,lookup:Lookup,sourceGeometry:(id:string)=>Promise<string|null>){
    const parsed=armingSchema.safeParse(input);
    if(!parsed.success)fail('invalid_arming','布防参数无效');
    const doc:Arming={...parsed.data,assignments:validateAssignmentSet(parsed.data.assignments)};
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
      return {saved:true as const,sourceId:doc.source_id,revision:expected+1,application:{state:'pending' as const,desired_revision:await this.bump(c)}};
    });
  }
  async snapshot(){
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const revision=(await c.query('SELECT revision::text FROM alarm_configuration_revision WHERE singleton=TRUE')).rows[0].revision as string;
      const rules=(await c.query('SELECT compiled_rule FROM alarm_trigger_assignments WHERE active=TRUE AND compiled_rule IS NOT NULL ORDER BY assignment_id')).rows.map(r=>r.compiled_rule);
      await c.query('COMMIT');return {schema_version:'1.0',revision,rules};
    }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
  }
}
