#!/usr/bin/env python3
"""Exercise unavailable delivery and process exit after acknowledged Mongo commit."""
from pathlib import Path
import datetime,json,os,subprocess,urllib.parse
ROOT=Path(__file__).resolve().parents[2]
stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
out=ROOT/'test/results'/('archive-replay-'+stamp);out.mkdir()
build=ROOT/'out/build/ai-s100p'
flags=subprocess.check_output(['pkg-config','--cflags','--libs','libmongoc-1.0'],text=True).split()
with (out/'build.log').open('w') as log:
    subprocess.run(['c++','-std=c++17','-O2','-I'+str(ROOT/'ai-service/src'),str(ROOT/'test/ai_port/archive_replay_probe.cpp'),*[str(build/f'libainvr_archive_{lib}.a') for lib in ['spool','mongo','document']],*flags,'-lcrypto','-o',str(out/'probe')],check=True,timeout=60,stdout=log,stderr=subprocess.STDOUT)
images=sorted((ROOT/'test/results').glob('pipeline-snapshots-*/none-images/0-0.jpg'));assert images,'Run verify_pipeline_snapshots.py first'
image=images[-1]
meta=json.loads(subprocess.check_output(['/usr/bin/ffprobe','-v','error','-show_entries','stream=width,height','-of','json',str(image)],text=True,timeout=15))['streams'][0]
password=(ROOT/'deploy/infra/secrets/mongo_app_password').read_text().strip()
env=dict(os.environ,AINVR_TEST_MONGO_URI='mongodb://ainvr_ai:'+urllib.parse.quote(password,safe='')+'@127.0.0.1:27017/ainvr_snapshots?authSource=ainvr_snapshots')
collection='test_replay_'+stamp;stages=[]
for mode,expected in [('stage_offline',0),('commit_exit',23),('replay',0),('verify_empty',0)]:
    run=subprocess.run([str(out/'probe'),mode,collection,str(out/'spool'),str(image),str(meta['width']),str(meta['height'])],env=env,capture_output=True,text=True,timeout=45)
    log=out/(mode+'.log');log.write_text(run.stderr);log.chmod(0o600)
    assert run.returncode==expected,(mode,run.returncode,'see private stage log')
    stages.append(dict(mode=mode,exit_code=run.returncode,result=json.loads(run.stdout.strip().splitlines()[-1]) if run.stdout.strip() else None))
    pending=list((out/'spool').glob('*.pending'))
    assert len(pending)==(1 if mode in ('stage_offline','commit_exit') else 0),(mode,pending)
report=dict(passed=True,collection=collection,stages=stages,source_jpeg=str(image),scope='Prepared-record recovery across unavailable delivery and process exit after acknowledged Mongo commit; not channel/pre-encoding/power-loss recovery')
(out/'summary.json').write_text(json.dumps(report,indent=2));print(out/'summary.json')
