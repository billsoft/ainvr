#!/usr/bin/env python3
"""AINVR: offline, checksum-verified SSD migration; retain original data for rollback."""
import hashlib,json,os,pathlib,shutil,subprocess,time
R=pathlib.Path('/home/sunrise/ainvr'); S=pathlib.Path('/mnt/ainvr-ssd')
def run(*a): return subprocess.check_output(a,text=True).strip()
assert os.geteuid()==0
assert run('findmnt','-n','-o','UUID','--target',str(S))=='64a5b078-4c84-4766-9bc6-68c247294079'
assert run('findmnt','-n','-o','TARGET','--target',str(S))==str(S)
compose=R/'deploy/infra/compose.yaml'; original=compose.read_bytes()
assert hashlib.sha256(original).hexdigest()=='54ae16b16b4d8cf98cb5f7c4fd4749a6738401cef3657030cc1caea009995cd1'
tag=time.strftime('%Y%m%d-%H%M%S'); backup=S/'migration-backups'/tag
backup.mkdir(parents=True,mode=0o700);os.chmod(backup.parent,0o700)
shutil.copy2(compose,backup/'compose.yaml');shutil.copy2('/etc/fstab',backup/'fstab')
services=['ainvr-ai','ainvr-backend','ainvr-recorder','ainvr-ingest']
active=[s for s in services if subprocess.run(['systemctl','is-active','--quiet',s]).returncode==0]
run('systemctl','stop',*active)
run('docker','stop','--time','60','ainvr-mongo','ainvr-postgres')
d=json.loads(run('docker','inspect','ainvr-mongo'))[0]
configdb=next(m['Source'] for m in d['Mounts'] if m['Destination']=='/data/configdb')
pairs=[(R/'deploy/infra/data/mongo',S/'databases/mongo'),(R/'deploy/infra/data/postgres',S/'databases/postgres'),(pathlib.Path(configdb),S/'databases/mongo-config'),(R/'data/ai',S/'ai')]
report={'backup':str(backup),'copies':[],'original_data_retained':True}
for src,dst in pairs:
 assert not dst.exists(),str(dst)
 dst.mkdir(parents=True,mode=0o700)
 run('rsync','-aHAX','--numeric-ids',str(src)+'/',str(dst)+'/')
 diff=run('rsync','-aHAXnc','--delete','--numeric-ids','--itemize-changes',str(src)+'/',str(dst)+'/')
 assert not diff,'Checksum mismatch: '+diff
 report['copies'].append({'source':str(src),'target':str(dst),'checksum_verified':True})
text=original.decode()
for old,new,dest in [('./data/mongo','/mnt/ainvr-ssd/databases/mongo','/data/db'),('./data/postgres','/mnt/ainvr-ssd/databases/postgres','/var/lib/postgresql/data')]:
 line='      - '+old+':'+dest
 assert text.count(line)==1
 text=text.replace(line,'      - type: bind\n        source: '+new+'\n        target: '+dest+'\n        bind:\n          create_host_path: false')
text=text.replace('      - ./init/mongo.js:', '      - type: bind\n        source: /mnt/ainvr-ssd/databases/mongo-config\n        target: /data/configdb\n        bind:\n          create_host_path: false\n      - ./init/mongo.js:')
assert compose.read_bytes()==original
compose.with_suffix('.yaml.ssd-tmp').write_text(text);os.replace(compose.with_suffix('.yaml.ssd-tmp'),compose)
fstab=pathlib.Path('/etc/fstab');line='/mnt/ainvr-ssd/ai /home/sunrise/ainvr/data/ai none bind,x-systemd.requires-mounts-for=/mnt/ainvr-ssd 0 0\n'
assert line not in fstab.read_text()
with fstab.open('a') as f:f.write('\n# AINVR persistent AI state on SSD\n'+line)
for service,content in [('docker','[Unit]\nRequiresMountsFor=/mnt/ainvr-ssd\n[Service]\nExecStartPre=/usr/bin/mountpoint -q /mnt/ainvr-ssd\n'),('ainvr-ai','[Unit]\nRequiresMountsFor=/home/sunrise/ainvr/data/ai\n[Service]\nExecStartPre=/usr/bin/mountpoint -q /mnt/ainvr-ssd\nExecStartPre=/usr/bin/mountpoint -q /home/sunrise/ainvr/data/ai\n')]:
 p=pathlib.Path('/etc/systemd/system')/(service+'.service.d')/'30-ainvr-ssd.conf'
 assert not p.exists();p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content)
run('systemctl','daemon-reload');run('mount',str(R/'data/ai'))
run('docker','compose','-f',str(compose),'up','-d','--no-deps','mongo','postgres')
for i in range(60):
 states={name:json.loads(run('docker','inspect',name))[0]['State']['Health']['Status'] for name in ['ainvr-mongo','ainvr-postgres']}
 if all(v=='healthy' for v in states.values()):break
 time.sleep(1)
assert all(v=='healthy' for v in states.values()),states
run('systemctl','start',*active)
report['health']=states;report['services']={s:run('systemctl','is-active',s) for s in active}
report['ai_mount']=run('findmnt','-n','-o','SOURCE,TARGET','--target',str(R/'data/ai'))
(R/'test/results/database-ssd-migration.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2),flush=True)
