#!/usr/bin/env python3
"""Read-only production backup; verify alarm refactor migrations through 008 and the runtime legacy import in an isolated PG.
No production SQL changes, service restart or model access; restore listens only on loopback.
The encrypted configuration dump remains private on SSD for a later rollout.
"""
import argparse,hashlib,json,os,pathlib,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--candidate',required=True,type=pathlib.Path);a=parser.parse_args()
 candidate=a.candidate.resolve()
 if candidate!=a.candidate or not candidate.is_relative_to('/mnt/ainvr-ssd'):raise SystemExit('Canonical SSD candidate required')
 built=json.loads((candidate/'status.json').read_text())
 if built.get('phase')!='passed' or built.get('deployment_performed') is not False:raise SystemExit('Undeployed verified candidate required')
 backend=candidate/'source/srs-web-console/backend'
 out=pathlib.Path('/mnt/ainvr-ssd')/('ainvr-alarm-refactor-backup-'+time.strftime('%Y%m%d-%H%M%S'))
 if not pathlib.Path('/mnt/ainvr-ssd').is_mount():raise SystemExit('Mounted SSD required')
 out.mkdir(mode=0o700);container=None
 report={'started_at':time.time(),'production_changed':False,'backup_directory':str(out),'phase':'backup','candidate':str(candidate)}
 def save(phase,**fields):
  report.update(phase=phase,updated_at=time.time(),**fields);(out/'status.json').write_text(json.dumps(report,indent=2)+'\n')
 def run(args,**kwargs):
  r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120,**kwargs)
  if r.returncode:
   error=out/'failure.stderr';error.write_bytes(r.stderr);os.chmod(error,0o600)
   raise RuntimeError('Command failed: '+args[0])
  return r.stdout
 def sql(query):return run(['docker','exec','-i',container,'psql','-h','127.0.0.1','-p','25440','-U','alarm_restore','-d','alarm_restore','-A','-t','-v','ON_ERROR_STOP=1'],input=query.encode()).decode().strip()
 try:
  pid=int(run(['systemctl','show','ainvr-backend.service','--property=MainPID','--value']).decode().strip())
  env=dict(item.split(b'=',1) for item in pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in item)
  database=env[b'CONFIG_PG_DATABASE'].decode()
  dump=out/'configuration-before-alarm.dump'
  with dump.open('xb') as output:
   os.chmod(dump,0o600)
   r=subprocess.run(['docker','exec','ainvr-postgres','sh','-c','pg_dump -U "$POSTGRES_USER" -d "$1" --format=custom','pg-backup',database],stdout=output,stderr=subprocess.PIPE,timeout=120)
  if r.returncode or dump.stat().st_size<100:raise RuntimeError('Production backup failed')
  sha=hashlib.sha256(dump.read_bytes()).hexdigest();save('starting-isolated-restore',backup_sha256=sha,backup_bytes=dump.stat().st_size)
  container=run(['docker','run','-d','--rm','--name','ainvr-alarm-refactor-restore-test','--network','host','--memory=512m','--cpus=1','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_USER=alarm_restore','-e','POSTGRES_DB=alarm_restore','postgres:16-alpine','postgres','-c','listen_addresses=127.0.0.1','-p','25440']).decode().strip()
  for _ in range(30):
   r=subprocess.run(['docker','exec',container,'pg_isready','-h','127.0.0.1','-p','25440','-U','alarm_restore','-d','alarm_restore'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
   if r.returncode==0:break
   time.sleep(1)
  else:raise RuntimeError('Restore database not ready')
  with dump.open('rb') as source:run(['docker','exec','-i',container,'pg_restore','-h','127.0.0.1','-p','25440','--exit-on-error','--no-owner','--no-privileges','-U','alarm_restore','-d','alarm_restore'],stdin=source)
  tables=['config_documents','config_versions','config_snapshots','config_service_states','config_secrets','config_audit_log']
  # Record only counts, not configuration contents or credentials.
  existing=set(sql("SELECT tablename FROM pg_tables WHERE schemaname='public'").splitlines())
  # Compare contents, not only row counts: channel/service settings must not drift.
  protected=sorted(t for t in existing if not t.startswith('alarm_') and t!='schema_migrations')
  def fingerprint(t):
   quoted='"'+t.replace('"','""')+'"'
   return sql("SELECT md5(coalesce(string_agg(row_data, E'\\n' ORDER BY row_data),'')) FROM (SELECT row_to_json(t)::text AS row_data FROM "+quoted+" t) rows")
  before_hashes={t:fingerprint(t) for t in protected}
  counts={t:int(sql('SELECT count(*) FROM '+t)) for t in tables if t in existing}
  applied=set(sql('SELECT version FROM schema_migrations').splitlines());migrations=[]
  for name in ['003_alarm_zones.sql','004_alarm_monitors.sql','005_alarm_triggers.sql','006_alarm_migration_review.sql','007_alarm_arming_storage.sql','008_alarm_legacy_imports.sql']:
   path=backend/'src/store/migrations'/name;data=path.read_bytes();version=str(int(name[:3]))
   if version not in applied:
    sql('BEGIN;\n'+data.decode()+f"\nINSERT INTO schema_migrations(version,name) VALUES({version},'{name[4:-4]}');\nCOMMIT;")
   migrations.append({'name':name,'sha256':hashlib.sha256(data).hexdigest(),'was_already_applied':version in applied})
  # Execute the exact candidate runtime import, without starting the application.
  runtime=r"""
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=process.argv[1];
const {Pool}=createRequire(root+'/package.json')('pg');
const {migrateLegacyAlarms}=await import(pathToFileURL(root+'/dist/store/alarmLegacyMigration.js'));
const pool=new Pool({host:'127.0.0.1',port:25440,user:'alarm_restore',database:'alarm_restore'});
try{
 const helper=process.argv[2],guardFile=process.argv[3];
 const env={...process.env,CONFIG_PG_HOST:'127.0.0.1',CONFIG_PG_PORT:'25440',CONFIG_PG_USER:'alarm_restore',CONFIG_PG_PASSWORD:'',CONFIG_PG_DATABASE:'alarm_restore'};
 const invoke=mode=>JSON.parse(execFileSync(process.execPath,[helper,mode,root,guardFile],{env,encoding:'utf8',timeout:120000}));
 const snapshot=async()=>JSON.stringify((await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'alarm_%' ORDER BY tablename`)).rows);
 const beforeTables=await snapshot();
 const tableNames=JSON.parse(beforeTables).map(r=>r.tablename);
 const contents=async()=>JSON.stringify(await Promise.all(tableNames.map(async name=>(await pool.query('SELECT row_to_json(t) AS row FROM '+name+' t ORDER BY row_to_json(t)::text')).rows)));
 const beforeContents=await contents();
 const checkpoint=invoke('prepare'),first=checkpoint.legacy,second=await migrateLegacyAlarms(pool);
 if(second.converted!==0||second.review!==0)throw Error('Legacy import is not idempotent');
 const guard=checkpoint.guard,rollback=invoke('rollback');
 if(checkpoint.migration_changed&&(rollback.restored!==first.converted||rollback.paused!==first.review))throw Error('Rollback counts differ from migration');
 const mismatch=await pool.query(`SELECT count(*)::int n FROM alarm_trigger_legacy_imports i JOIN alarm_triggers t USING(trigger_id)
 WHERE (i.outcome='converted' AND t.document<>i.original_document)
 OR (i.outcome='review' AND t.document->>'state' NOT IN ('paused','archived'))`);
 if(checkpoint.migration_changed&&mismatch.rows[0].n)throw Error('Recovered legacy semantics differ');
 if(!checkpoint.migration_changed&&(!rollback.unchanged||beforeTables!==await snapshot()||beforeContents!==await contents()))throw Error('Already migrated recovery must be a no-op');
 if(checkpoint.migration_changed&&(await pool.query('SELECT count(*)::int n FROM alarm_trigger_assignments WHERE active=TRUE')).rows[0].n)throw Error('New assignments still active');
 console.log(JSON.stringify({first,second,rollback,guard,recovered_legacy_verified:true}));
}finally{await pool.end();}
"""
  imported=json.loads(run(['node','--input-type=module','--eval',runtime,str(backend),str(ROOT/'test/ai_port/alarm_offline_migration.mjs'),str(out/'migration-checkpoint.json')]).decode())
  after={t:int(sql('SELECT count(*) FROM '+t)) for t in counts}
  if counts!=after:raise RuntimeError('Existing configuration row counts changed')
  if before_hashes!={t:fingerprint(t) for t in protected}:raise RuntimeError('Existing non-alarm data changed')
  if int(sql('SELECT max(version) FROM schema_migrations'))!=8:raise RuntimeError('Expected migration version 8')
  added=set(sql("SELECT tablename FROM pg_tables WHERE schemaname='public'").splitlines())-existing
  save('passed',runtime_import=imported,migrations=migrations,existing_row_counts=counts,existing_row_counts_unchanged=True,protected_tables=protected,protected_content_unchanged=True,added_tables=sorted(added),restored_schema_version=int(sql('SELECT max(version) FROM schema_migrations')))
  (ROOT/'test/results/alarm-refactor-backup-20261020.json').write_text(json.dumps(report,indent=2)+'\n')
 except Exception as error:
  save('failed',error_type=type(error).__name__);raise
 finally:
  if container:subprocess.run(['docker','stop','--time','10',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
if __name__=='__main__':main()
