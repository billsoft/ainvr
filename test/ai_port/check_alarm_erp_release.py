#!/usr/bin/env python3
"""Verify this ERP release against tests, saved browser contracts and installed files. No Git mutations."""
import argparse,hashlib,json,pathlib,re,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_text())
def git(*args):return subprocess.check_output(['git','-C',str(ROOT),*args])
def counts(name):
 text=re.sub(r'\x1b\[[0-9;]*m','',(ROOT/'test/results'/name).read_text())
 assert not re.search(r'(?:Tests|Test Files)\s+.*(?:failed|skipped)',text)
 rows=re.findall(r'Tests\s+(\d+) passed\s+\((\d+)\)',text)
 assert rows and rows[-1][0]==rows[-1][1]
 return int(rows[-1][0])
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--web-candidate',type=pathlib.Path,required=True);parser.add_argument('--alarm-candidate',type=pathlib.Path,required=True);parser.add_argument('--frontend-log',default='erp-final-frontend-r3.log');parser.add_argument('--backend-log',default='erp-final-backend-r3.log');a=parser.parse_args()
 result={'phase':'checking','at':time.time(),'automatic_commit_performed':False}
 try:
  git('diff','--check');git('diff','--cached','--check')
  tests={'frontend':counts(a.frontend_log),'backend':counts(a.backend_log)}
  web=read(a.web_candidate/'status.json');assert web['phase']=='passed'
  for rel,h in read(a.web_candidate/'source-manifest.json').items():assert sha(ROOT/rel)==h,rel
  for name,artifact in web['artifacts'].items():
   dist=pathlib.Path(artifact['root']);installed=ROOT/'srs-web-console'/name/'dist'
   for f in dist.rglob('*'):
    if f.is_file():assert sha(installed/f.relative_to(dist))==sha(f),str(f)
  accepted=read(a.alarm_candidate/'status.json');assert accepted['phase']=='passed';tests['alarm']=accepted['counts']
  assert tests['alarm']['fail']==tests['alarm']['skipped']==0
  deployed=read(ROOT/'test/results/alarm-submit-deployment-20261019.json');assert deployed['phase']=='passed' and deployed['video_services_unchanged']
  release=pathlib.Path(deployed['release'])
  for rel,h in read(a.alarm_candidate/'source-manifest.json').items():assert sha(ROOT/'alarm-service'/rel)==sha(release/rel)==h,rel
  for rel,h in read(a.alarm_candidate/'artifact-manifest.json').items():assert sha(release/rel)==h,rel
  browser=read(ROOT/'test/results/erp-browser-contract-verification.json');assert browser['phase']=='passed'
  live=read(ROOT/'test/results/alarm-submit-live-20261019.json');before=read(ROOT/'test/results/erp-before-deployment-live.json')
  assert live['phase']=='passed' and live['video_services_unchanged'] and live['configuration_unchanged'] and live['baseline']==before['baseline']
  assert live['observation_journal']['failed']==0
  names=set()
  for args in [('diff','--name-only','--diff-filter=ACMRT','-z'),('diff','--cached','--name-only','--diff-filter=ACMRT','-z'),('ls-files','--others','--exclude-standard','-z')]:names.update(x.decode() for x in git(*args).split(b'\0') if x)
  manifest={}
  for name in sorted(names):
   f=ROOT/name
   if not f.is_file():continue
   data=f.read_bytes()
   assert not data.startswith((b'\x7fELF',b'MZ')),name
   assert f.suffix not in ['.pyc','.tsbuildinfo','.o','.a','.hbm','.hbo','.bc','.mp4','.log'],name
   assert 'node_modules' not in f.parts,name
   assert not re.search(rb'^(?:<<<<<<< |>>>>>>> |-----BEGIN .*PRIVATE KEY-----)',data,re.M),name
   if f.suffix=='.py':compile(data,str(f),'exec')
   manifest[name]=sha(f)
  assert not git('ls-files','srs-web-console/backend/tsconfig.tsbuildinfo').strip()
  subprocess.run(['git','-C',str(ROOT),'check-ignore','--quiet','test/ai_port/runtime_label_catalog_test'],check=True)
  result.update(phase='ready_to_commit',tests=tests,source_manifest=manifest,changed_files=len(manifest),web_candidate=str(a.web_candidate),alarm_candidate=str(a.alarm_candidate),release=str(release),production_verified=True,physical_ipad_tested=False)
 finally:
  (ROOT/'test/results/alarm-erp-commit-readiness-20261020.json').write_text(json.dumps(result,indent=2)+'\n')
if __name__=='__main__':main()
