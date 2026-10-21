#!/usr/bin/env python3
"""Read-only production backup; verify additive alarm migrations in an isolated PG.
No production SQL changes, service restart, model access or network test listener.
The encrypted configuration dump remains private on SSD for a later rollout.
"""
import hashlib,json,os,pathlib,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
def main():
 out=pathlib.Path('/mnt/ainvr-ssd')/('ainvr-alarm-migration-backup-'+time.strftime('%Y%m%d-%H%M%S'))
 if not pathlib.Path('/mnt/ainvr-ssd').is_mount():raise SystemExit('Mounted SSD required')
 out.mkdir(mode=0o700);container=None
 report={'started_at':time.time(),'production_changed':False,'backup_directory':str(out),'phase':'backup'}
 def save(phase,**fields):
  report.update(phase=phase,updated_at=time.time(),**fields);(out/'status.json').write_text(json.dumps(report,indent=2)+'\n')
 def run(args,**kwargs):
  r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120,**kwargs)
  if r.returncode:
   error=out/'failure.stderr';error.write_bytes(r.stderr);os.chmod(error,0o600)
   raise RuntimeError('Command failed: '+args[0])
  return r.stdout
 def sql(query):return run(['docker','exec','-i',container,'psql','-U','alarm_restore','-d','alarm_restore','-A','-t','-v','ON_ERROR_STOP=1'],input=query.encode()).decode().strip()
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
  container=run(['docker','run','-d','--rm','--name','ainvr-alarm-migration-restore-test','--network','none','--memory=512m','--cpus=1','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_USER=alarm_restore','-e','POSTGRES_DB=alarm_restore','postgres:16-alpine']).decode().strip()
  for _ in range(30):
   r=subprocess.run(['docker','exec',container,'pg_isready','-h','127.0.0.1','-U','alarm_restore','-d','alarm_restore'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
   if r.returncode==0:break
   time.sleep(1)
  else:raise RuntimeError('Restore database not ready')
  with dump.open('rb') as source:run(['docker','exec','-i',container,'pg_restore','--exit-on-error','--no-owner','--no-privileges','-U','alarm_restore','-d','alarm_restore'],stdin=source)
  tables=['config_documents','config_versions','config_snapshots','config_service_states','config_secrets','config_audit_log']
  # Record only counts, not configuration contents or credentials.
  existing=set(sql("SELECT tablename FROM pg_tables WHERE schemaname='public'").splitlines())
  counts={t:int(sql('SELECT count(*) FROM '+t)) for t in tables if t in existing}
  applied=set(sql('SELECT version FROM schema_migrations').splitlines());migrations=[]
  for name in ['003_alarm_zones.sql','004_alarm_monitors.sql']:
   path=ROOT/'srs-web-console/backend/src/store/migrations'/name;data=path.read_bytes();version=str(int(name[:3]))
   if version not in applied:
    sql('BEGIN;\n'+data.decode()+f"\nINSERT INTO schema_migrations(version,name) VALUES({version},'{name[4:-4]}');\nCOMMIT;")
   migrations.append({'name':name,'sha256':hashlib.sha256(data).hexdigest(),'was_already_applied':version in applied})
  after={t:int(sql('SELECT count(*) FROM '+t)) for t in counts}
  if counts!=after:raise RuntimeError('Existing configuration row counts changed')
  added=set(sql("SELECT tablename FROM pg_tables WHERE schemaname='public'").splitlines())-existing
  save('passed',migrations=migrations,existing_row_counts=counts,existing_row_counts_unchanged=True,added_tables=sorted(added),restored_schema_version=int(sql('SELECT max(version) FROM schema_migrations')))
  (ROOT/'test/results/alarm-migration-backup-20261019.json').write_text(json.dumps(report,indent=2)+'\n')
 except Exception as error:
  save('failed',error_type=type(error).__name__);raise
 finally:
  if container:subprocess.run(['docker','stop','--time','10',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
if __name__=='__main__':main()
