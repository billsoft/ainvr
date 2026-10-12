#!/usr/bin/env python3
from pathlib import Path
import datetime,json,os,subprocess,time,urllib.parse
ROOT=Path(__file__).resolve().parents[2];stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
out=ROOT/'test/results'/('pipeline-archive-'+stamp);out.mkdir();build=ROOT/'out/build/ai-s100p'
videos=sorted((ROOT/'test/results').glob('pipeline-snapshots-*/source.mp4'));assert videos,'Run verify_pipeline_snapshots.py first'
classes=out/'classes.json';classes.write_text(json.dumps([str(i) for i in range(80)]));report=out/'frames.json'
env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib:'+str(ROOT/'out/deps/onnxruntime-1.23.2/lib'))
before=time.time()
with (out/'inference.log').open('w') as log:
    subprocess.run([str(build/'ainvr_pipeline_probe'),str(ROOT/'ai-service/models/yolo26m.onnx'),str(videos[-1]),'end2end','2',str(report),str(classes),str(out/'images'),'none',str(out/'spool')],env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=120)
frames=json.loads(report.read_text())['frames'];after=time.time()
for f in frames:
    assert before-1<=f['timestamp']<=after+1
    assert len(f['detections'])==len(f['snapshots'])>0
ids=[s['archive_id'] for f in frames for s in f['snapshots']]
assert len(ids)==len(set(ids))==len(list((out/'spool').glob('*.pending')))
flags=subprocess.check_output(['pkg-config','--cflags','--libs','libmongoc-1.0'],text=True).split()
with (out/'build.log').open('w') as log:
    subprocess.run(['c++','-std=c++17','-O2','-I'+str(ROOT/'ai-service/src'),str(ROOT/'test/ai_port/pipeline_archive_probe.cpp'),str(build/'libainvr_archive_spool.a'),str(build/'libainvr_archive_mongo.a'),*flags,'-lcrypto','-o',str(out/'probe')],check=True,timeout=60,stdout=log,stderr=subprocess.STDOUT)
password=(ROOT/'deploy/infra/secrets/mongo_app_password').read_text().strip()
env['AINVR_TEST_MONGO_URI']='mongodb://ainvr_ai:'+urllib.parse.quote(password,safe='')+'@127.0.0.1:27017/ainvr_snapshots?authSource=ainvr_snapshots'
run=subprocess.run([str(out/'probe'),str(report),str(out/'images'),str(out/'spool'),'test_pipeline_'+stamp],env=env,capture_output=True,text=True,timeout=60)
log=out/'replay.log';log.write_text(run.stderr);log.chmod(0o600);assert run.returncode==0,'Replay failed; see private replay.log'
result=json.loads(run.stdout.strip().splitlines()[-1]);result['scope']='Real CPU YOLO/VPU/snapshot/durable prepared spool/independent Mongo replay; not deployed channel or pre-encoding recovery'
(out/'summary.json').write_text(json.dumps(result,indent=2));print(out/'summary.json')
