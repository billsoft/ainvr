#!/usr/bin/env python3
"""Run the migrated original store tests against an isolated Mongo database on SSD.
CUDA-only cases are excluded; no claim of JPU/GLES/BPU execution is made here.
"""
import json,os,pathlib,subprocess,tempfile,urllib.parse
R=pathlib.Path(__file__).resolve().parents[2]
os.umask(0o077)
ssd=pathlib.Path('/mnt/ainvr-ssd')
assert subprocess.check_output(['findmnt','-n','-o','UUID','--target',str(ssd)],text=True).strip()=='64a5b078-4c84-4766-9bc6-68c247294079'
root=ssd/'test';root.mkdir(exist_ok=True,mode=0o700)
password=(R/'deploy/infra/secrets/mongo_admin_password').read_text().strip()
env=dict(os.environ,AI_SERVICE_TEST_MONGO_URI='mongodb://ainvr_admin:'+urllib.parse.quote(password,safe='')+'@127.0.0.1:27017/ainvr_snapshot_reuse_tests?authSource=admin')
# TemporaryDirectory owns this test's recovery files only; never production paths.
with tempfile.TemporaryDirectory(prefix='original-store-',dir=root) as tmp:
 env['TMPDIR']=tmp
 output=R/'test/results/original-store-tests.json'
 with (R/'test/results/original-store-tests.log').open('w') as log:
  completed=subprocess.run([str(R/'out/build/ai-api-compat/reused_snapshot_store_test'),'--gtest_output=json:'+str(output)],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=240)
 report=json.loads(output.read_text())
 print(json.dumps({k:report.get(k) for k in ['tests','failures','disabled','errors','time']},indent=2))
 raise SystemExit(completed.returncode)
