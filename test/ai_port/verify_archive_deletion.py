#!/usr/bin/env python3
from pathlib import Path
import datetime,json,os,subprocess,urllib.parse
ROOT=Path(__file__).resolve().parents[2]
stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f');out=ROOT/'test/results'/('archive-deletion-'+stamp);out.mkdir()
build=ROOT/'out/build/ai-s100p'
flags=subprocess.check_output(['pkg-config','--cflags','--libs','libmongoc-1.0'],text=True).split()
with (out/'build.log').open('w') as log:
    subprocess.run(['c++','-std=c++17','-O2','-I'+str(ROOT/'ai-service/src'),str(ROOT/'test/ai_port/archive_deletion_probe.cpp'),str(build/'libainvr_archive_spool.a'),str(build/'libainvr_archive_mongo.a'),*flags,'-lcrypto','-o',str(out/'probe')],check=True,timeout=60,stdout=log,stderr=subprocess.STDOUT)
password=(ROOT/'deploy/infra/secrets/mongo_app_password').read_text().strip()
env=dict(os.environ,AINVR_TEST_MONGO_URI='mongodb://ainvr_ai:'+urllib.parse.quote(password,safe='')+'@127.0.0.1:27017/ainvr_snapshots?authSource=ainvr_snapshots')
name='test_delete_'+stamp;stages=[]
for mode in ['setup','replay','clear_intent','verify_clear']:
    run=subprocess.run([str(out/'probe'),mode,name,str(out/'state')],env=env,capture_output=True,text=True,timeout=30)
    log=out/(mode+'.log');log.write_text(run.stderr);log.chmod(0o600)
    assert run.returncode==0,(mode,'see private stage log')
    stages.append(json.loads(run.stdout.strip().splitlines()[-1]))
(out/'summary.json').write_text(json.dumps(dict(passed=True,collection=name,stages=stages,scope='Single-owner deletion journal, Mongo deletion and pending replay across separate processes; channel integration remains pending'),indent=2));print(out/'summary.json')
