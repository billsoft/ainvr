#!/usr/bin/env python3
"""AINVR isolated Mongo query integration check."""
from pathlib import Path
import datetime,json,os,subprocess,urllib.parse
root=Path(__file__).resolve().parents[2]
stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
out=root/'test/results'/('archive-query-'+stamp);out.mkdir(mode=0o700)
password=(root/'deploy/infra/secrets/mongo_app_password').read_text().strip()
env=dict(os.environ,AINVR_TEST_MONGO_URI='mongodb://ainvr_ai:'+urllib.parse.quote(password,safe='')+'@127.0.0.1:27017/ainvr_snapshots?authSource=ainvr_snapshots')
with (out/'probe.log').open('w') as log:
 subprocess.run([str(root/'out/build/ai-api-compat/ainvr_archive_query_probe'),'test_query_'+stamp],env=env,stdout=log,stderr=log,check=True,timeout=45)
(out/'summary.json').write_text(json.dumps({'passed':True,'scope':'Real Mongo isolated collections; production HTTP routes not yet enabled','log':(out/'probe.log').read_text()},indent=2))
print(out/'summary.json')
