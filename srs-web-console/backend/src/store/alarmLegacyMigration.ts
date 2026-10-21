import type {Pool} from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {convertLegacyTrigger} from './alarmLegacyConversion.js';
const actor='migration-008-assignments';
/** Run after schema migrations, before configuration routes or synchronization.
 * No device I/O: conversion uses frozen provenance or explicitly requires review. */
export async function migrateLegacyAlarms(pool:Pool){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('alarm-arming-configuration',0))");
  await c.query('LOCK TABLE alarm_triggers IN SHARE ROW EXCLUSIVE MODE');
  const old=(await c.query(`SELECT t.* FROM alarm_triggers t
   LEFT JOIN alarm_trigger_legacy_imports i ON i.trigger_id=t.trigger_id
   WHERE i.trigger_id IS NULL ORDER BY t.trigger_id`)).rows;
  const zones=(await c.query('SELECT document,version,channel_id FROM alarm_zones')).rows.map(r=>({...r.document,version:r.version,channel_id:r.channel_id}));
  let converted=0,review=0;
  for(const row of old){
   const exists=(await c.query('SELECT 1 FROM alarm_trigger_definitions WHERE trigger_id=$1',[row.trigger_id])).rowCount;
   if(exists)throw Error(`Legacy definition identity conflict: ${row.trigger_id}`);
   if(!Number.isSafeInteger(row.version)||row.version>=2147483646)throw Error('Legacy version cannot be advanced');
   const version=row.version+1;
   let plan=convertLegacyTrigger(row.document,version,zones);
   // Validate all source merges before writing any of this trigger.
   const merges=new Map<string,{document:any;revision:number}>();
   if(plan.status==='converted'&&plan.definition.state!=='archived'){
    const conversion=plan;
    for(const item of conversion.assignments){
     const a=item.document;
     let merge=merges.get(a.input_stream_id);
     if(!merge){
      const existing=(await c.query('SELECT document,revision FROM alarm_arming_sources WHERE source_id=$1',[a.input_stream_id])).rows[0];
      merge=existing?{document:structuredClone(existing.document),revision:existing.revision+1}:
       {document:{source_id:a.input_stream_id,geometry_revision:a.geometry_revision,zones:[],assignments:[]},revision:1};
      merges.set(a.input_stream_id,merge);
     }
     if(merge.document.geometry_revision!==a.geometry_revision){
      plan={status:'review',reason:'同一来源保存了不同画面规格，请重新确认热区与选用。'};break;
     }
     const z=conversion.zones.find(z=>z.zone_id===a.zone_id);
     if(z){
      const existing=merge.document.zones.find((x:any)=>x.zone_id===z.zone_id);
      if(existing&&!isDeepStrictEqual(existing,z)||merge.document.zones.some((x:any)=>x.zone_id!==z.zone_id&&x.name===z.name)){
       plan={status:'review',reason:'同一来源的热区版本或名称冲突，请重新确认。'};break;
      }
      if(!existing)merge.document.zones.push(z);
     }
     merge.document.assignments.push(a);
    }
   }
   const {bindings:_,migration_review:__,...originalDefinition}=row.document;
   const definition=plan.status==='converted'?plan.definition:{
    ...originalDefinition,state:row.document.state==='archived'?'archived':'paused',
    migration_review:{required:true,reason:plan.reason,from:'legacy-bindings'},
   };
   await c.query('INSERT INTO alarm_trigger_definitions(trigger_id,version,document) VALUES($1,$2,$3)',[row.trigger_id,version,JSON.stringify(definition)]);
   await c.query('INSERT INTO alarm_trigger_definition_versions(trigger_id,version,document,actor) VALUES($1,$2,$3,$4)',[row.trigger_id,version,JSON.stringify(definition),actor]);
   if(plan.status==='converted'&&plan.definition.state!=='archived'){
    for(const [sourceId,merge] of merges){
     await c.query(`INSERT INTO alarm_arming_sources(source_id,revision,document) VALUES($1,$2,$3)
      ON CONFLICT(source_id) DO UPDATE SET revision=EXCLUDED.revision,document=EXCLUDED.document,updated_at=now()`,
      [sourceId,merge.revision,JSON.stringify(merge.document)]);
     await c.query('INSERT INTO alarm_arming_versions(source_id,revision,document,actor) VALUES($1,$2,$3,$4)',
      [sourceId,merge.revision,JSON.stringify(merge.document),actor]);
    }
    for(const item of plan.assignments)await c.query(`INSERT INTO alarm_trigger_assignments
     (assignment_id,source_id,trigger_id,execution_version,document,compiled_rule,active) VALUES($1,$2,$3,1,$4,$5,TRUE)`,
     [item.document.assignment_id,item.document.input_stream_id,row.trigger_id,JSON.stringify(item.document),item.rule?JSON.stringify(item.rule):null]);
   }
   // Deactivate the legacy execution in the SAME transaction as the new rule.
   const legacyDocument={...row.document,state:row.document.state==='archived'?'archived':'paused',
    migrated_to:'assignment-storage',migration_review:plan.status==='review'?{required:true,reason:plan.reason}:undefined};
   await c.query('UPDATE alarm_triggers SET version=$2,document=$3,updated_at=now() WHERE trigger_id=$1',
    [row.trigger_id,version,JSON.stringify(legacyDocument)]);
   await c.query('INSERT INTO alarm_trigger_versions(trigger_id,version,document,actor) VALUES($1,$2,$3,$4)',
    [row.trigger_id,version,JSON.stringify(legacyDocument),actor]);
   await c.query('INSERT INTO alarm_trigger_legacy_imports(trigger_id,source_version,original_document,outcome,reason) VALUES($1,$2,$3,$4,$5)',
    [row.trigger_id,row.version,JSON.stringify(row.document),plan.status,plan.status==='review'?plan.reason:null]);
   if(plan.status==='converted')converted++;else review++;
  }
  if(old.length)await c.query('UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton=TRUE');
  await c.query('COMMIT');return {converted,review};
 }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
}
