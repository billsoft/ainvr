#!/usr/bin/env python3
"""Freeze and validate an independent alarm release; never deploy or restart services."""
import argparse,hashlib,json,os,pathlib,shutil,subprocess,tempfile,time,re
ROOT=pathlib.Path(__file__).resolve().parents[2]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def inventory(root):
 return {str(p.relative_to(root)):sha(p) for p in sorted(root.rglob('*')) if p.is_file()}
def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--output',type=pathlib.Path,required=True)
 parser.add_argument('--tracking-library',type=pathlib.Path,required=True)
 a=parser.parse_args();out=a.output;ssd=pathlib.Path('/mnt/ainvr-ssd');library=a.tracking_library
 if not ssd.is_mount() or out.resolve()!=out or not out.is_relative_to(ssd) or out==ssd or not library.is_file() or not library.resolve().is_relative_to(ssd):raise SystemExit('Canonical new SSD candidate and tracking library required')
 out.mkdir(mode=0o700);state={'phase':'freezing','pid':os.getpid(),'started_at':time.time(),'deployment_performed':False}
 def status(phase,**fields):
  state.update(phase=phase,updated_at=time.time(),**fields)
  tmp=out/'status.json.new';tmp.write_text(json.dumps(state,indent=2)+'\n');tmp.replace(out/'status.json')
 try:
  os.nice(10);source=ROOT/'alarm-service';release=out/'release';release.mkdir()
  files=[*sorted((source/'src').rglob('*.mjs')),*sorted((source/'test').rglob('*')),source/'package.json',source/'package-lock.json']
  manifest={str(p.relative_to(source)):sha(p) for p in files if p.is_file()}
  for rel,h in manifest.items():
   p=source/rel;target=release/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,target)
   if sha(p)!=h or sha(target)!=h:raise RuntimeError('Concurrent source change')
  # A private dependency copy ensures a later npm operation cannot mutate this candidate.
  modules=source/'node_modules';dependencies=inventory(modules)
  shutil.copytree(modules,release/'node_modules',symlinks=False)
  if inventory(modules)!=dependencies or inventory(release/'node_modules')!=dependencies:raise RuntimeError('Dependency copy mismatch')
  (out/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
  (out/'dependency-manifest.json').write_text(json.dumps(dependencies,indent=2)+'\n')
  fixtures=ROOT/'test/fixtures';fixture_manifest=inventory(fixtures)
  shutil.copytree(fixtures,out/'test/fixtures')
  if inventory(out/'test/fixtures')!=fixture_manifest:raise RuntimeError('Shared test fixture copy mismatch')
  (out/'fixture-manifest.json').write_text(json.dumps(fixture_manifest,indent=2))
  native=out/'native';native.mkdir();status('native-fixtures')
  with (out/'acceptance.log').open('w') as log:
   def run(args,**kw):return subprocess.run(args,stdout=log,stderr=log,timeout=240,check=True,**kw)
   run(['g++','-O1','-std=c++17',str(ROOT/'test/ai_port/observation_journal_test.cpp'),'-lcrypto','-o',str(native/'journal-probe')])
   run([str(native/'journal-probe'),str(native/'observations')])
   run(['g++','-O1','-std=c++17',str(ROOT/'test/ai_port/observation_quality_probe.cpp'),'-I'+str(ROOT/'ai-service/third_party'),'-I/usr/include/eigen3','-I/usr/include/opencv4',str(library),'-lcrypto','-lopencv_core','-pthread','-o',str(native/'quality-probe')])
   run([str(native/'quality-probe'),str(native/'quality')])
   env=os.environ.copy();env.update(AINVR_ALARM_TEST_MONGO='1',AINVR_NATIVE_JOURNAL_ROOT=str(native/'observations'),AINVR_NATIVE_QUALITY_ROOT=str(native/'quality'))
   status('testing-frozen-release')
   run(['node','--test','--test-reporter=tap',*[str(p) for p in sorted((release/'test').glob('*.test.mjs'))]],cwd=release,env=env)
  text=(out/'acceptance.log').read_text();counts={k:int(re.findall(r'^# '+k+r' (\d+)$',text,re.M)[-1]) for k in ['tests','pass','fail','skipped']}
  if counts['fail'] or counts['skipped'] or counts['tests']!=counts['pass']:raise RuntimeError('Acceptance requires all tests without skips')
  if any(sha(source/r)!=h or sha(release/r)!=h for r,h in manifest.items()):raise RuntimeError('Source changed during validation')
  if inventory(release/'node_modules')!=dependencies:raise RuntimeError('Dependencies changed during validation')
  artifact=inventory(release);(out/'artifact-manifest.json').write_text(json.dumps(artifact,indent=2)+'\n')
  status('passed',counts=counts,release=str(release),artifact_manifest_sha256=sha(out/'artifact-manifest.json'),dependency_manifest_sha256=sha(out/'dependency-manifest.json'),tracking_library_sha256=sha(library))
 except Exception as error:status('failed',error_type=type(error).__name__);raise
if __name__=='__main__':main()
