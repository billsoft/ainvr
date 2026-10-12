#!/usr/bin/env python3
"""Use application credentials without logging them; retain one isolated test record."""
from pathlib import Path
import datetime,json,os,subprocess,urllib.parse
ROOT=Path(__file__).resolve().parents[2]
stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
out=ROOT/'test/results'/('archive-mongo-'+stamp);out.mkdir()
build=ROOT/'out/build/ai-s100p'
flags=subprocess.check_output(['pkg-config','--cflags','--libs','libmongoc-1.0'],text=True).split()
with (out/'build.log').open('w') as log:
    subprocess.run(['c++','-std=c++17','-O2','-I'+str(ROOT/'ai-service/src'),str(ROOT/'test/ai_port/archive_mongo_probe.cpp'),str(build/'libainvr_archive_mongo.a'),str(build/'libainvr_archive_document.a'),*flags,'-o',str(out/'probe')],check=True,timeout=60,stdout=log,stderr=subprocess.STDOUT)
images=sorted((ROOT/'test/results').glob('pipeline-snapshots-*/none-images/0-0.jpg'));assert images,'Run verify_pipeline_snapshots.py first'
image=images[-1]
meta=json.loads(subprocess.check_output(['/usr/bin/ffprobe','-v','error','-show_entries','stream=width,height','-of','json',str(image)],text=True))['streams'][0]
secret=(ROOT/'deploy/infra/secrets/mongo_app_password').read_text().strip()
env=dict(os.environ,AINVR_TEST_MONGO_URI='mongodb://ainvr_ai:'+urllib.parse.quote(secret,safe='')+'@127.0.0.1:27017/ainvr_snapshots?authSource=ainvr_snapshots')
run=subprocess.run([str(out/'probe'),'test_archive_'+stamp,str(image),str(meta['width']),str(meta['height'])],env=env,capture_output=True,text=True,timeout=45)
# Probe error messages never include the URI. Driver logs are retained privately.
(out/'probe.log').write_text(run.stderr);(out/'probe.log').chmod(0o600)
assert run.returncode==0,'Mongo integration failed; see private probe.log'
report=json.loads(run.stdout.strip().splitlines()[-1]);report['source_jpeg']=str(image)
report['scope']='Journaled Mongo write/read, exact BSON fields/binaries, retry identity; no local durable spool or process-crash recovery claim'
(out/'summary.json').write_text(json.dumps(report,indent=2));print(out/'summary.json')
