#!/usr/bin/env python3
"""Fresh native fixtures + complete alarm suite against isolated Mongo at 27028.

Start the dedicated test Mongo before running. Never reuse consumed journal files.
No production database URI or password is accepted by this runner.
"""
import argparse,hashlib,json,os,pathlib,re,subprocess,tempfile,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--tracking-library',type=pathlib.Path,required=True);a=parser.parse_args()
 library=a.tracking_library.resolve();ssd=pathlib.Path('/mnt/ainvr-ssd')
 if not ssd.is_mount() or not library.is_file() or not library.is_relative_to(ssd):raise SystemExit('Verified tracking library on mounted SSD required')
 out=pathlib.Path(tempfile.mkdtemp(prefix='ainvr-alarm-acceptance-',dir=ssd));prefix=ROOT/'test/results/alarm-acceptance';report={'phase':'preparing','output':str(out),'started_at':time.time(),'tracking_library_sha256':hashlib.sha256(library.read_bytes()).hexdigest()}
 files=[*sorted((ROOT/'alarm-service/src').glob('*.mjs')),*sorted((ROOT/'alarm-service/test').glob('*.mjs')),ROOT/'alarm-service/package-lock.json']
 manifest={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
 def save(phase,**fields):
  report.update(phase=phase,updated_at=time.time(),**fields);prefix.with_suffix('.json').write_text(json.dumps(report,indent=2)+'\n')
 try:
  os.nice(10)
  with prefix.with_suffix('.log').open('w') as log:
   def run(args,**kw):return subprocess.run(args,stdout=log,stderr=log,timeout=240,check=True,**kw)
   save('building-native-fixtures')
   run(['g++','-O1','-std=c++17',str(ROOT/'test/ai_port/observation_journal_test.cpp'),'-lcrypto','-o',str(out/'journal-probe')]);run([str(out/'journal-probe'),str(out/'observations')])
   run(['g++','-O1','-std=c++17',str(ROOT/'test/ai_port/observation_quality_probe.cpp'),'-I'+str(ROOT/'ai-service/third_party'),'-I/usr/include/eigen3','-I/usr/include/opencv4',str(library),'-lcrypto','-lopencv_core','-pthread','-o',str(out/'quality-probe')]);run([str(out/'quality-probe'),str(out/'quality')])
   env=os.environ.copy();env.update(AINVR_ALARM_TEST_MONGO='1',AINVR_NATIVE_JOURNAL_ROOT=str(out/'observations'),AINVR_NATIVE_QUALITY_ROOT=str(out/'quality'))
   save('running-all-alarm-tests');run(['node','--test','--test-reporter=tap',*[str(p) for p in sorted((ROOT/'alarm-service/test').glob('*.test.mjs'))]],cwd=ROOT/'alarm-service',env=env)
  output=prefix.with_suffix('.log').read_text();counts={key:int(re.findall(r'^# '+key+r' (\d+)$',output,re.M)[-1]) for key in ['tests','pass','fail','skipped']}
  if counts['fail'] or counts['skipped'] or counts['pass']!=counts['tests']:raise RuntimeError('All alarm tests must pass without skips')
  if any(hashlib.sha256((ROOT/r).read_bytes()).hexdigest()!=h for r,h in manifest.items()):raise RuntimeError('Source changed during acceptance')
  save('passed',counts=counts,source_manifest=manifest)
 except Exception as error:save('failed',error_type=type(error).__name__);raise
 finally:
  for name in ['journal-probe','quality-probe']:(out/name).unlink(missing_ok=True)
if __name__=='__main__':main()
