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
it.skipIf(!enabled)('PG 迁移保留可等价执行，暂停未知证据，原配置可审计，重复执行无副作用',async()=>isolated(async p=>{
 await seed(p,'good');await seed(p,'needs-review',false);
 expect(await migrateLegacyAlarms(p)).toEqual({converted:1,review:1});
 const store=new AlarmArmingStore(p),list=await store.listDefinitions();
 expect(list.find(t=>t.trigger_id==='good')).toMatchObject({state:'enabled',version:2});
 expect(list.find(t=>t.trigger_id==='needs-review')).toMatchObject({state:'paused',migration_review:{required:true}});
 expect((await store.snapshot()).rules).toHaveLength(1);
 expect((await p.query("SELECT count(*)::int n FROM alarm_triggers WHERE document->>'state'='enabled'")).rows[0].n).toBe(0);
 expect((await p.query("SELECT original_document FROM alarm_trigger_legacy_imports WHERE trigger_id='good'")).rows[0].original_document).toEqual(original('good'));
 const before=(await p.query('SELECT revision FROM alarm_configuration_revision')).rows[0].revision;
 expect(await migrateLegacyAlarms(p)).toEqual({converted:0,review:0});
 expect((await p.query('SELECT revision FROM alarm_configuration_revision')).rows[0].revision).toBe(before);
}));
it.skipIf(!enabled)('PG 编号冲突整批回滚，不留下半迁移或同时启用',async()=>isolated(async p=>{
 await seed(p,'a');await seed(p,'z');
 await p.query("INSERT INTO alarm_trigger_definitions(trigger_id,version,document) VALUES('z',1,'{}')");
 await expect(migrateLegacyAlarms(p)).rejects.toThrow('identity conflict');
 expect((await p.query('SELECT count(*)::int n FROM alarm_trigger_legacy_imports')).rows[0].n).toBe(0);
 expect((await p.query("SELECT count(*)::int n FROM alarm_trigger_definitions WHERE trigger_id='a'")).rows[0].n).toBe(0);
 expect((await p.query("SELECT document->>'state' state FROM alarm_triggers WHERE trigger_id='a'")).rows[0].state).toBe('enabled');
}));
