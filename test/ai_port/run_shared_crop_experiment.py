#!/usr/bin/env python3
"""Identical eight-target 4K NV12 shared-crop A/B; two source frames unchanged."""
import hashlib,json,os,pwd,subprocess,tempfile,time
from pathlib import Path
from urllib.parse import quote
import xml.etree.ElementTree as ET
from run_hardware_archive_validation import MongoProxy
ROOT=Path('/home/sunrise/ainvr')
def main():
 assert Path.cwd().resolve()==ROOT and os.geteuid()==0
 assert 'AINVR_ARCHIVE_SHARED_CROP' in (ROOT/'ai-service/src/output/snapshot_processing.cpp').read_text(), 'Shared crop implementation required; rebuild snapshot_hardware_archive_test first'
 out=ROOT/'test/results'/('shared-crop-ab-'+time.strftime('%Y%m%d-%H%M%S'));out.mkdir()
 scratch=Path(tempfile.mkdtemp(prefix='shared-crop-ab-',dir='/mnt/ainvr-ssd/test-scratch'))
 control=scratch/'proxy';control.mkdir()
 user=subprocess.check_output(['systemctl','show','ainvr-ai','-p','User','--value'],text=True).strip() or 'root'
 owner=pwd.getpwnam(user)
 for p in (out,scratch,control):os.chown(p,owner.pw_uid,owner.pw_gid)
 proxy=MongoProxy(control)
 env=os.environ.copy();password=(ROOT/'deploy/infra/secrets/mongo_admin_password').read_text().strip()
 suffix='/?authSource=admin&serverSelectionTimeoutMS=1500&connectTimeoutMS=500&socketTimeoutMS=2000'
 prefix='mongodb://ainvr_admin:'+quote(password,safe='')+'@127.0.0.1:'
 env.update(AI_SERVICE_TEST_MONGO_URI=prefix+'27017'+suffix,AI_SERVICE_TEST_MONGO_PROXY_URI=prefix+str(proxy.port)+suffix,AINVR_ARCHIVE_PROXY_CONTROL=str(control),AINVR_ARCHIVE_TEST_ROOT=str(scratch),TMPDIR=str(scratch),LD_LIBRARY_PATH='/usr/hobot/lib',AINVR_TEST_ARCHIVE_TARGETS='8',AINVR_TEST_ARCHIVE_NV12='1')
 binary=ROOT/'out/build/ai-api-compat/snapshot_hardware_archive_test'
 active=[u for u in ['ainvr-ai','ainvr-recorder'] if subprocess.run(['systemctl','is-active','--quiet',u]).returncode==0]
 report={'start':time.strftime('%Y-%m-%dT%H:%M:%S'),'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'source':'identical synthetic 3840x1920 immutable NV12, eight targets; no decode or detector inference','trials':[]}
 try:
  if active:subprocess.run(['systemctl','stop',*active],check=True,timeout=90)
  for index,mode in enumerate([0,1,1,0,0,1]):
   env['AINVR_ARCHIVE_SHARED_CROP']=str(mode)
   xml=out/f'trial-{index}.xml'
   with (out/f'trial-{index}.log').open('w') as log:
    subprocess.run(['runuser','-u',user,'--',str(binary),'--gtest_filter=HardwareArchive.Continuous4KErpQueueMeasuresHardwareAndDurability','--gtest_output=xml:'+str(xml)],env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
   suite=ET.parse(xml).getroot();assert int(suite.attrib['failures'])==0 and not suite.findall('.//skipped')
   report['trials'].append({'shared_crop':bool(mode),'properties':{p.attrib['name']:p.attrib['value'] for p in suite.findall('.//property')}})
  report['passed']=True
 finally:
  # Attempt every restoration even if the proxy or one service fails.
  errors=[]
  try:proxy.close()
  except Exception as error:errors.append('proxy: '+str(error))
  report['restored']={}
  for unit in active:
   try:
    subprocess.run(['systemctl','start',unit],check=True,timeout=90)
    report['restored'][unit]=subprocess.run(['systemctl','is-active','--quiet',unit],timeout=10).returncode==0
   except Exception as error:
    report['restored'][unit]=False
    errors.append(unit+': '+str(error))
  report['restoration_errors']=errors
  report['end']=time.strftime('%Y-%m-%dT%H:%M:%S')
  (out/'summary.json').write_text(json.dumps(report,indent=2))
  print(out/'summary.json')
  if errors or not all(report['restored'].values()):
   raise RuntimeError('Experiment restoration failed; inspect '+str(out/'summary.json'))
if __name__=='__main__':main()
