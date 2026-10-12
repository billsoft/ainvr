#!/usr/bin/env python3
"""AINVR deletion/recovery integration with actual GPU/JPU and isolated Mongo."""
from pathlib import Path
import datetime,json,os,pwd,subprocess,urllib.parse
root=Path(__file__).resolve().parents[2];stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
out=root/'test/results'/('raw-snapshot-deletion-'+stamp);out.mkdir(mode=0o700)
account=pwd.getpwnam('sunrise');os.chown(out,account.pw_uid,account.pw_gid)
password=(root/'deploy/infra/secrets/mongo_app_password').read_text().strip()
env=dict(os.environ,AINVR_TEST_MONGO_URI='mongodb://ainvr_ai:'+urllib.parse.quote(password,safe='')+'@127.0.0.1:27017/ainvr_snapshots?authSource=ainvr_snapshots')
with (out/'probe.log').open('w') as log:
 subprocess.run(['runuser','-u','sunrise','--',str(root/'out/build/ai-api-compat/ainvr_raw_snapshot_deletion_probe'),str(out),'test_raw_delete_'+stamp],env=env,stdout=log,stderr=log,check=True,timeout=45)
(out/'summary.json').write_text(json.dumps({'passed':True,'scope':'Real renderer and Mongo with synthetic frames; API integration pending','log':(out/'probe.log').read_text()},indent=2))
print(out/'summary.json')
