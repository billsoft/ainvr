#!/usr/bin/env python3
"""AINVR isolated real live-stream screenshot/Mongo integration verification."""
from pathlib import Path
import argparse,datetime,json,os,pwd,subprocess,urllib.parse
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--projection",choices=["none","erp_equirect"],default="none");args=parser.parse_args()
ROOT=Path(__file__).resolve().parents[2]
stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
out=ROOT/'test/results'/('live-snapshot-archive-'+stamp);out.mkdir(mode=0o700)
account=pwd.getpwnam('sunrise');os.chown(out,account.pw_uid,account.pw_gid)
password=(ROOT/'deploy/infra/secrets/mongo_app_password').read_text().strip()
env=dict(os.environ,AINVR_TEST_MONGO_URI='mongodb://ainvr_ai:'+urllib.parse.quote(password,safe='')+'@127.0.0.1:27017/ainvr_snapshots?authSource=ainvr_snapshots')
with (out/'probe.log').open('w') as log:
 subprocess.run(['runuser','-u','sunrise','--',str(ROOT/'out/build/ai-api-compat/ainvr_live_snapshot_archive_probe'),str(ROOT/'ai-service/models/yolo26m.onnx'),'http://127.0.0.1:8080/live/xm.flv',str(out),'test_live_archive_'+stamp,args.projection],env=env,stdout=log,stderr=log,check=True,timeout=65)
report=json.loads((out/'summary.json').read_text());assert report['passed']
subprocess.run(['/usr/bin/ffmpeg','-v','error','-i',str(out/'sample.jpg'),'-frames:v','1','-f','null','-'],check=True,timeout=15)
report['stored_jpeg_decoded']=True;(out/'summary.json').write_text(json.dumps(report,indent=2));print(out/'summary.json')
