#!/usr/bin/env python3
"""Add PTZ gateway, hardware AI and alarm components to a verified console build.
Builds only. Never reads live credentials or changes running services.
"""
import argparse,hashlib,json,os,shutil,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def files(folder):return {p.relative_to(folder).as_posix():sha(p)for p in sorted(folder.rglob('*'))if p.is_file()}
def extra_sources():
 result={}
 for name in ['gb28181-service','shared/ptzcontrol','ai-service/src','ai-service/cmake','alarm-service/src']:
  for p in (ROOT/name).rglob('*'):
   if p.is_file()and not any(n in p.parts for n in ['node_modules','.git','__pycache__']):result[p.relative_to(ROOT).as_posix()]=sha(p)
 for name in ['ai-service/CMakeLists.txt','alarm-service/package.json','deploy-package/prepare-ptz-components.py','deploy-package/install-ai-s100p.py']:
  result[name]=sha(ROOT/name)
 return result

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--candidate',type=Path,required=True);parser.add_argument('--profile',choices=['ptz','search'],default='ptz')
 parser.add_argument('--reuse-validated-builds',action='store_true',help='Search only: reconfigure and rebuild existing tested caches with all release flags and artifact checks')
 args=parser.parse_args();out=args.candidate.resolve(strict=True)
 if args.reuse_validated_builds and args.profile!='search':raise RuntimeError('Validated search caches require the search profile')
 if not out.is_relative_to(ROOT/'out')or out.is_symlink():raise RuntimeError('Use a real candidate under out/')
 if json.loads((out/'status.json').read_text()).get('phase')!='built':raise RuntimeError('Base build must have succeeded')
 sources=json.loads((out/'source-manifest.json').read_text())
 for name,want in sources.items():
  p=(ROOT/name).resolve(strict=True)
  if not p.is_relative_to(ROOT)or sha(p)!=want:raise RuntimeError('Source changed: '+name)
 artifacts=json.loads((out/'artifacts.json').read_text())
 for name,want in artifacts.items():
  if files(out/name)!=want:raise RuntimeError('Base artifacts changed: '+name)
 if args.profile=='search':
  status=json.loads((out/'status.json').read_text())
  if status.get('releaseProfile')!='search' or status.get('searchComponents')is not False:raise RuntimeError('Use a fresh search-profile base build')
  if any((out/n).exists()for n in ['search-ai','search-llm','search-native']):raise RuntimeError('Search extension already started; use a fresh base build')
  from search_release_profile import prepare_components
  (out/'status.json').write_text(json.dumps({'phase':'building-search','releaseProfile':'search','productionChanged':False})+'\n')
  def search_run(cmd,cwd,label,timeout=300):
   with(out/(label+'.log')).open('wb')as log:subprocess.run(cmd,cwd=cwd,env={**os.environ,'CARGO_NET_OFFLINE':'true'},stdout=log,stderr=log,timeout=timeout,check=True)
  try:
   builds={name:ROOT/'out/build'/('search-release-'+name)for name in ['ai-service','llm-service','search-service']}
   if args.reuse_validated_builds:
    builds={'ai-service':ROOT/'out/build/ai-api-compat','llm-service':ROOT/'out/llm-search-software/native','search-service':ROOT/'out/search-text-integration'}
    if not all((build/'CMakeCache.txt').is_file() for build in builds.values()):raise RuntimeError('All tested caches must exist; no unchecked binary copy is permitted')
   prepare_components(ROOT,out,search_run,builds)
   for name,want in sources.items():
    if sha(ROOT/name)!=want:raise RuntimeError('Source changed during search build: '+name)
   for name in ['search-ai','search-llm','search-native']:artifacts[name]=files(out/name)
   (out/'artifacts.json').write_text(json.dumps(artifacts,indent=2)+'\n')
   (out/'status.json').write_text(json.dumps({'phase':'built','releaseProfile':'search','searchComponents':True,'productionChanged':False,'createdAt':time.time(),'physicalCameraAcceptance':False},indent=2)+'\n')
   print(str(out));return
  except BaseException:
   (out/'status.json').write_text(json.dumps({'phase':'failed-search','releaseProfile':'search','productionChanged':False})+'\n');raise
 if json.loads((out/'status.json').read_text()).get('releaseProfile')=='search':raise RuntimeError('Search candidate requires explicit --profile search')
 if any((out/n).exists()for n in ['ptz-ai','ptz-gb28181','ptz-alarm']):raise RuntimeError('PTZ extension already started; use a fresh base build')
 initial=extra_sources();(out/'status.json').write_text(json.dumps({'phase':'building-ptz','productionChanged':False})+'\n')
 env={**os.environ,'GOMAXPROCS':'2','GOTELEMETRY':'off','GOWORK':'off'}
 def run(cmd,cwd,label,timeout=300):
  with (out/(label+'.log')).open('wb')as log:subprocess.run(cmd,cwd=cwd,env=env,stdout=log,stderr=log,timeout=timeout,check=True)
 try:
  (out/'ptz-gb28181').mkdir();go=ROOT/'out/gb28181/go/bin/go'
  workspace=out/'gb-verification.work';workspace.write_text('go 1.24.0\nuse (\n'+str(ROOT/'gb28181-service')+'\n'+str(ROOT/'shared/ptzcontrol')+'\n)\n');env['GOWORK']=str(workspace)
  run([str(go),'mod','verify'],ROOT/'gb28181-service','gb-verify')
  run([str(go),'build','-trimpath','-o',str(out/'ptz-gb28181/gateway'),'./cmd/gateway'],ROOT/'gb28181-service','gb-build')
  env['GOWORK']='off'
  run(['cmake','--build',str(ROOT/'out/build/ai-s100p'),'--target','ainvr_s100p_control_service','ptz_analytics_reset_test','-j2'],ROOT,'ai-build',600)
  run([str(ROOT/'out/build/ai-s100p/ptz_analytics_reset_test')],ROOT,'ai-reset-tests',60)
  (out/'ptz-ai').mkdir();shutil.copy2(ROOT/'out/build/ai-s100p/ainvr_s100p_control_service',out/'ptz-ai/ainvr_s100p_control_service')
  run([str(out/'ptz-ai/ainvr_s100p_control_service'),'--runtime-info'],ROOT,'ai-runtime-info',30)
  shutil.copytree(ROOT/'alarm-service/src',out/'ptz-alarm/src');shutil.copy2(ROOT/'alarm-service/package.json',out/'ptz-alarm/package.json')
  if extra_sources()!=initial:raise RuntimeError('PTZ source changed during build')
  for name,want in sources.items():
   if sha(ROOT/name)!=want:raise RuntimeError('Base source changed during PTZ build: '+name)
  sources.update(initial);(out/'source-manifest.json').write_text(json.dumps(sources,indent=2)+'\n')
  for name in ['ptz-ai','ptz-gb28181','ptz-alarm']:artifacts[name]=files(out/name)
  (out/'artifacts.json').write_text(json.dumps(artifacts,indent=2)+'\n')
  (out/'status.json').write_text(json.dumps({'phase':'built','ptzComponents':True,'productionChanged':False,'createdAt':time.time(),'physicalCameraAcceptance':False},indent=2)+'\n')
  print(str(out))
 except BaseException:
  (out/'status.json').write_text(json.dumps({'phase':'failed-ptz','productionChanged':False})+'\n');raise
if __name__=='__main__':main()
