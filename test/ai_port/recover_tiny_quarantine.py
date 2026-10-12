"""AINVR recover only audited tiny RGBA snapshots after the JPU canvas fix.

Original quarantined bytes remain in an SSD backup. Pending replay uses the
ordinary production recovery and deletion ledger; no Mongo documents are injected.
"""
import hashlib,json,os,pathlib,shutil,subprocess
import cbor2
root=pathlib.Path('/home/sunrise/ainvr')
pending=pathlib.Path('/mnt/ainvr-ssd/ai/data/snapshot-pending/2baec0a3-9941-47dc-b1bd-d3d284488097').resolve(strict=True)
assert pending.is_relative_to(pathlib.Path('/mnt/ainvr-ssd').resolve(strict=True))
inventory=json.loads((root/'test/results/tiny-quarantine-inventory-20261012.json').read_text())['items']
backup=pathlib.Path('/mnt/ainvr-ssd/migration-backups/tiny-quarantine-before-replay-20261012')
assert not backup.exists();backup.mkdir(mode=0o700)
assert len(inventory)==23
for item in inventory:
    file=pending/item['file'];assert file.parent==pending
    data=file.read_bytes();assert hashlib.sha256(data).hexdigest()==item['sha256']
    doc=cbor2.loads(data);assert doc['pending_version']==3 and doc['pixel_format']=='rgba8'
    assert doc['channel_id']==pending.name and 0<min(doc['image_width'],doc['image_height'])<17
    assert len(doc['rgba'])==doc['image_width']*doc['image_height']*4
    shutil.copy2(file,backup/file.name)
    assert hashlib.sha256((backup/file.name).read_bytes()).hexdigest()==item['sha256']
active=subprocess.run(['systemctl','is-active','--quiet','ainvr-ai.service']).returncode==0
report={'backup':str(backup),'files':inventory,'renamed':[],'direct_database_writes':False}
try:
    if active:subprocess.run(['systemctl','stop','ainvr-ai.service'],check=True,timeout=45)
    for item in inventory:
        source=pending/item['file'];dest=source.with_suffix('')
        assert dest.suffix=='.cbor' and not dest.exists()
        assert hashlib.sha256(source.read_bytes()).hexdigest()==item['sha256']
        os.rename(source,dest);report['renamed'].append(dest.name)
finally:
    if active:subprocess.run(['systemctl','start','ainvr-ai.service'],check=True,timeout=45)
    (root/'test/results/tiny-quarantine-replay-20261012.json').write_text(json.dumps(report,indent=2))
print('23 audited files queued for normal recovery; backup retained')
