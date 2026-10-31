from pathlib import Path
import datetime, hashlib, json, os, shutil
root=Path('/home/sunrise/ainvr').resolve()
source=root/'out/stats-analytics/frontend'
target=root/'srs-web-console/frontend/dist'
manifest=root/'test/results/stats-analytics-20261030/deployment.json'
data=json.loads(manifest.read_text())
assert (source/'index.html').is_file()
backup=Path(data['backups']['web'])
assert backup.is_relative_to(Path('/mnt/ainvr-ssd/ainvr-rollback/web')) and (backup/'dist/index.html').is_file()
assert os.stat(backup).st_dev != os.stat('/').st_dev
for path in sorted((p for p in source.rglob('*') if p.is_file()), key=lambda p:p.name=='index.html'):
 destination=target/path.relative_to(source)
 destination.parent.mkdir(parents=True,exist_ok=True)
 temp=destination.with_name(destination.name+'.analytics-publish')
 shutil.copyfile(path,temp);temp.chmod(0o644);os.replace(temp,destination)
data['frontend_prototype_restore_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
data['frontend_index_sha256']=hashlib.sha256((target/'index.html').read_bytes()).hexdigest()
data['phase']='prototype_visual_restored_with_independent_heat_layer'
temp=manifest.with_suffix('.json.analytics-publish');temp.write_text(json.dumps(data,indent=2)+'\n');os.replace(temp,manifest)
print(json.dumps({k:data[k] for k in ['phase','frontend_prototype_restore_at','frontend_index_sha256']}))
