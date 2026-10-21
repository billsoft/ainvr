import {it,expect} from 'vitest';
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const enabled=process.env.AINVR_ALARM_TEST_PG==='1';
const sql=(file:string)=>readFileSync(new URL(`../store/migrations/${file}`,import.meta.url),'utf8');
it.skipIf(!enabled)('隔离 PG：暂停未确认的旧迁移配置，保留历史，不改用户后续编辑',async()=>{
  const schema='migration_review_'+randomUUID().replaceAll('-','');
  const connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
  const admin=new Pool(connection);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({...connection,options:`-c search_path=${schema}`});
  try{
    for(const file of ['003_alarm_zones.sql','004_alarm_monitors.sql','005_alarm_triggers.sql'])await pool.query(sql(file));
    for(const [id,actor,state] of [['legacy','migration-005','enabled'],['edited','operator','enabled'],['archived','migration-005','archived']]){
      const doc={trigger_id:id,state,name:id,bindings:[{direction:{entry_edges:[],exit_edges:[]}}]};
      await pool.query('INSERT INTO alarm_triggers(trigger_id,version,document) VALUES($1,1,$2)',[id,JSON.stringify(doc)]);
      await pool.query('INSERT INTO alarm_trigger_versions(trigger_id,version,document,actor) VALUES($1,1,$2,$3)',[id,JSON.stringify(doc),actor]);
    }
    await pool.query(sql('006_alarm_migration_review.sql'));
    const rows=(await pool.query('SELECT trigger_id,version,document FROM alarm_triggers')).rows;
    expect(rows.find(r=>r.trigger_id==='legacy')).toMatchObject({version:2,document:{state:'paused',migration_review:{required:true}}});
    expect(rows.find(r=>r.trigger_id==='edited')).toMatchObject({version:1,document:{state:'enabled'}});
    expect(rows.find(r=>r.trigger_id==='archived')).toMatchObject({version:1,document:{state:'archived'}});
    const history=(await pool.query("SELECT document FROM alarm_trigger_versions WHERE trigger_id='legacy' AND version=1")).rows[0];
    expect(history.document.state).toBe('enabled');
    const revision=(await pool.query('SELECT revision FROM alarm_configuration_revision')).rows[0].revision;
    await pool.query(sql('006_alarm_migration_review.sql'));
    expect((await pool.query('SELECT revision FROM alarm_configuration_revision')).rows[0].revision).toBe(revision);
    expect((await pool.query("SELECT count(*)::int n FROM alarm_trigger_versions WHERE trigger_id='legacy'")).rows[0].n).toBe(2);
  }finally{
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
