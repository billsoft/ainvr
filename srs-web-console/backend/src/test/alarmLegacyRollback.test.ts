import {it,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {migrateLegacyAlarms} from '../store/alarmLegacyMigration.js';
import {AlarmArmingStore} from '../store/alarmArmingStore.js';
const enabled=process.env.AINVR_ALARM_TEST_PG==='1';
async function isolated(run:(p:Pool)=>Promise<void>){
 const schema='legacy_'+randomUUID().replaceAll('-','');
 const connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
 const admin=new Pool(connection);await admin.query(`CREATE SCHEMA ${schema}`);
 const p=new Pool({...connection,options:`-c search_path=${schema}`});
 try{
  for(const f of ['003_alarm_zones.sql','004_alarm_monitors.sql','005_alarm_triggers.sql','006_alarm_migration_review.sql','007_alarm_arming_storage.sql','008_alarm_legacy_imports.sql'])
   await p.query(readFileSync(new URL('../store/migrations/'+f,import.meta.url),'utf8'));
  await run(p);
 }finally{await p.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
const original=(id:string,valid=true)=>({trigger_id:id,name:id,behavior:'appearance',labels:[{label_id:'person',name:'人员'}],
 duration_ms:3000,alarm_enabled:true,state:'enabled',schedule:{mode:'always'},bindings:[{channel_id:'ai',input_stream_id:'camera',
 label_map_version:'lm',geometry_revision:'g',zone_id:null,zone_version:null,direction:{entry_edges:[],exit_edges:[]},zone_snapshot:null,
 source_binding:valid?{stream_fingerprint:'a'.repeat(64),width:1920,height:1080,not_before:'2026-10-20T00:00:00Z',
 input_stream_id:'camera',label_map_version:'lm',geometry_revision:'g'}:null}]});
async function seed(p:Pool,id:string,valid=true){
 await p.query('INSERT INTO alarm_triggers(trigger_id,version,document) VALUES($1,1,$2)',[id,JSON.stringify(original(id,valid))]);
 await p.query('INSERT INTO alarm_trigger_versions(trigger_id,version,document,actor) VALUES($1,1,$2,$3)',[id,JSON.stringify(original(id,valid)),'operator']);
}
async function recovery(){return import(new URL('../../../../test/ai_port/alarm_migration_rollback.mjs',import.meta.url).href);}
it.skipIf(!enabled)('PG 回退恢复可等价旧规则、保留待复核暂停和全部历史，不改变其他服务',async()=>isolated(async p=>{
 await seed(p,'good');await seed(p,'needs-review',false);await migrateLegacyAlarms(p);
 await p.query('CREATE TABLE unrelated_config(id TEXT PRIMARY KEY, value TEXT)');
 await p.query("INSERT INTO unrelated_config VALUES('channel','manual')");
 const {captureAlarmRollbackGuard,restoreLegacyAlarmConfiguration}=await recovery();
 const guard=await captureAlarmRollbackGuard(p);
 // A non-alarm user edit after the migration must survive rollback.
 await p.query("UPDATE unrelated_config SET value='new-manual'");
 expect(await restoreLegacyAlarmConfiguration(p,guard)).toMatchObject({restored:1,paused:1,history_preserved:true});
 expect((await p.query("SELECT document FROM alarm_triggers WHERE trigger_id='good'")).rows[0].document).toEqual(original('good'));
 expect((await p.query("SELECT document->>'state' state FROM alarm_triggers WHERE trigger_id='needs-review'")).rows[0].state).toBe('paused');
 expect((await new AlarmArmingStore(p).snapshot()).rules).toEqual([]);
 expect((await p.query('SELECT count(*)::int n FROM alarm_trigger_versions')).rows[0].n).toBe(6);
 expect((await p.query('SELECT value FROM unrelated_config')).rows[0].value).toBe('new-manual');
 await expect(restoreLegacyAlarmConfiguration(p,guard)).rejects.toThrow('configuration changed');
 expect(await migrateLegacyAlarms(p)).toEqual({converted:0,review:0});
}));
it.skipIf(!enabled)('PG 回退拒绝覆盖迁移后的告警编辑，事务不产生部分恢复',async()=>isolated(async p=>{
 await seed(p,'good');await migrateLegacyAlarms(p);
 const {captureAlarmRollbackGuard,restoreLegacyAlarmConfiguration}=await recovery();
 const guard=await captureAlarmRollbackGuard(p);
 await p.query("UPDATE alarm_arming_sources SET document=jsonb_set(document,'{user_note}','\"edited\"')");
 const before=(await p.query('SELECT document,version FROM alarm_triggers')).rows;
 await expect(restoreLegacyAlarmConfiguration(p,guard)).rejects.toThrow('configuration changed');
 expect((await p.query('SELECT document,version FROM alarm_triggers')).rows).toEqual(before);
 expect((await p.query('SELECT count(*)::int n FROM alarm_trigger_versions')).rows[0].n).toBe(2);
}));