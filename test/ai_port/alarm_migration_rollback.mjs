// Deployment recovery only. Caller must stop rule publishers before applying.
// Restores equivalent legacy definitions without dropping schemas/history or touching other services.
import {createHash} from 'node:crypto';
const tables=['alarm_configuration_revision','alarm_triggers','alarm_trigger_versions','alarm_trigger_definitions','alarm_trigger_definition_versions','alarm_arming_sources','alarm_arming_versions','alarm_trigger_assignments','alarm_trigger_legacy_imports','alarm_zones','alarm_zone_versions','alarm_monitors','alarm_monitor_versions','alarm_config_operations'];
async function lock(c){
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('alarm-arming-configuration',0))");
 for(const t of tables)await c.query(`LOCK TABLE ${t} IN SHARE ROW EXCLUSIVE MODE`);
}
async function fingerprint(c){
 const result=[];
 for(const t of tables){const r=await c.query(`SELECT COALESCE(jsonb_agg(doc ORDER BY doc::text),'[]'::jsonb)::text data FROM (SELECT to_jsonb(t) doc FROM ${t} t) rows`);result.push([t,r.rows[0].data]);}
 return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}
export async function captureAlarmRollbackGuard(pool){
 const c=await pool.connect();try{await c.query('BEGIN');await lock(c);const guard=await fingerprint(c);await c.query('COMMIT');return guard;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function restoreLegacyAlarmConfiguration(pool,expectedGuard){
 if(!/^[a-f0-9]{64}$/.test(expectedGuard))throw Error('Verified migration guard required');
 const c=await pool.connect();try{
  await c.query('BEGIN');await lock(c);
  if(await fingerprint(c)!==expectedGuard)throw Error('Alarm configuration changed; automatic rollback refused');
  const imported=(await c.query('SELECT * FROM alarm_trigger_legacy_imports ORDER BY trigger_id')).rows;
  const definitions=(await c.query('SELECT * FROM alarm_trigger_definitions ORDER BY trigger_id')).rows;
  if(definitions.length!==imported.length)throw Error('Non-migration definitions require manual recovery');
  for(const d of definitions){
   const i=imported.find(i=>i.trigger_id===d.trigger_id);
   const v=(await c.query('SELECT actor FROM alarm_trigger_definition_versions WHERE trigger_id=$1 AND version=$2',[d.trigger_id,d.version])).rows[0];
   if(!i||d.version!==i.source_version+1||v?.actor!=='migration-008-assignments')throw Error('Edited definition requires manual recovery');
  }
  const actor='rollback-008-assignments';let restored=0,paused=0;
  for(const i of imported){
   const old=(await c.query('SELECT * FROM alarm_triggers WHERE trigger_id=$1',[i.trigger_id])).rows[0];
   if(!old||old.version!==i.source_version+1||old.version>=2147483646)throw Error('Legacy configuration changed');
   const document=i.outcome==='converted'?i.original_document:{...old.document,state:old.document.state==='archived'?'archived':'paused'};
   await c.query('UPDATE alarm_triggers SET version=$2,document=$3,updated_at=now() WHERE trigger_id=$1',[i.trigger_id,old.version+1,JSON.stringify(document)]);
   await c.query('INSERT INTO alarm_trigger_versions(trigger_id,version,document,actor) VALUES($1,$2,$3,$4)',[i.trigger_id,old.version+1,JSON.stringify(document),actor]);
   const d=definitions.find(d=>d.trigger_id===i.trigger_id);
   const stopped={...d.document,state:d.document.state==='archived'?'archived':'paused'};
   await c.query('UPDATE alarm_trigger_definitions SET version=$2,document=$3,updated_at=now() WHERE trigger_id=$1',[d.trigger_id,d.version+1,JSON.stringify(stopped)]);
   await c.query('INSERT INTO alarm_trigger_definition_versions(trigger_id,version,document,actor) VALUES($1,$2,$3,$4)',[d.trigger_id,d.version+1,JSON.stringify(stopped),actor]);
   if(i.outcome==='converted')restored++;else paused++;
  }
  await c.query('UPDATE alarm_trigger_assignments SET active=FALSE,updated_at=now() WHERE active=TRUE');
  if(imported.length)await c.query('UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton=TRUE');
  const revision=String((await c.query('SELECT revision FROM alarm_configuration_revision WHERE singleton=TRUE')).rows[0].revision);
  await c.query('COMMIT');return {restored,paused,revision,history_preserved:true,non_alarm_tables_changed:false};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
