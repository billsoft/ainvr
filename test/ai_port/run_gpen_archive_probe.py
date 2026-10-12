"""Run native GPEN snapshot/Mongo integration with private credentials and SSD scratch."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
from urllib.parse import quote

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--model',type=Path,required=True)
p.add_argument('--input',type=Path,required=True)
p.add_argument('--label',required=True)
a=p.parse_args();assert re.fullmatch(r'[A-Za-z0-9_-]+',a.label)
root=Path('/home/sunrise/ainvr');ssd=Path('/mnt/ainvr-ssd');assert ssd.is_mount()
scratch=ssd/'test-scratch'/('gpen-archive-'+a.label);scratch.mkdir()
user=subprocess.check_output(['systemctl','show','ainvr-ai','--property=User','--value'],text=True).strip() or 'root'
account=pwd.getpwnam(user);os.chown(scratch,account.pw_uid,account.pw_gid)
assert a.input.stat().st_size==96*96*4
shutil.copy2(a.input,scratch/'input-96.rgba')
env=os.environ.copy();secret=(root/'deploy/infra/secrets/mongo_admin_password').read_text().strip()
env['AI_SERVICE_TEST_MONGO_URI']='mongodb://ainvr_admin:'+quote(secret,safe='')+'@127.0.0.1:27017/?authSource=admin'
env['LD_LIBRARY_PATH']='/usr/hobot/lib';env['AINVR_DRM_RENDER_NODE']='/dev/dri/renderD128';env.pop('HW_WAYLAND_SOCKET',None)
command=[str(root/'out/build/ai-ffmpeg8/ainvr_gpen_archive_probe'),str(a.model.resolve(strict=True)),str(scratch/'input-96.rgba'),str(scratch),str(scratch/'report.json')]
if user!='root':command=['runuser','-u',user,'--']+command
with (scratch/'run.log').open('w') as log:
    result=subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=90)
if result.returncode:raise SystemExit('Probe failed; inspect '+str(scratch/'run.log'))
report=json.loads((scratch/'report.json').read_text());report['execution_user']=user
target=root/'test/results'/('gpen-archive-'+a.label+'.json');assert not target.exists()
target.write_text(json.dumps(report,indent=2))
print(json.dumps({k:report[k] for k in ['passed','records','timed_records','seconds','archive_fps']}))
print('Evidence:',target)
