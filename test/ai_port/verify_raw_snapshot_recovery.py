#!/usr/bin/env python3
"""AINVR real GPU/JPU snapshot preparation recovery, isolated synthetic frames."""
import datetime,json,os,pathlib,pwd,subprocess
root=pathlib.Path(__file__).resolve().parents[2]
out=root/'test/results'/('raw-snapshot-recovery-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
out.mkdir(mode=0o700)
account=pwd.getpwnam('sunrise');os.chown(out,account.pw_uid,account.pw_gid)
report={'scope':'Synthetic 4K frame, real renderer/JPEG, two abrupt process exits; production API not enabled','modes':{}}
for projection in ('none','erp_equirect'):
 directory=out/projection;directory.mkdir(mode=0o700);os.chown(directory,account.pw_uid,account.pw_gid)
 with (directory/'probe.log').open('w') as log:
  subprocess.run(['runuser','-u','sunrise','--',str(root/'out/build/ai-api-compat/ainvr_raw_snapshot_recovery_probe'),str(directory),projection],stdout=log,stderr=log,check=True,timeout=45)
 for i in range(2):
  subprocess.run(['/usr/bin/ffmpeg','-v','error','-i',str(directory/f'recovered-{i}.jpg'),'-frames:v','1','-f','null','-'],check=True,timeout=15)
 report['modes'][projection]={'passed':True,'decoded_jpegs':2,'raw_pending':len(list((directory/'raw').glob('*.pending'))),'prepared_pending':len(list((directory/'prepared').glob('*.pending')))}
 assert report['modes'][projection]['raw_pending']==report['modes'][projection]['prepared_pending']==0
report['passed']=True
(out/'summary.json').write_text(json.dumps(report,indent=2))
print(out/'summary.json')
