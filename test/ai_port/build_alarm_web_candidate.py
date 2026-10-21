#!/usr/bin/env python3
"""Freeze/build AINVR console candidates on SSD without replacing live dist/config."""
import argparse,hashlib,json,os,pathlib,shutil,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',required=True,type=pathlib.Path);args=parser.parse_args()
 out=args.output;ssd=pathlib.Path('/mnt/ainvr-ssd')
 if not ssd.is_mount() or not out.is_absolute() or out.resolve()!=out or not out.is_relative_to(ssd) or out==ssd:raise SystemExit('New canonical SSD output required')
 out.mkdir(mode=0o700)
 state={'pid':os.getpid(),'started_at':time.time(),'output':str(out),'phase':'freezing','deployment_performed':False}
 def status(phase,**fields):
  state.update(phase=phase,updated_at=time.time(),**fields);temp=out/'status.json.new';temp.write_text(json.dumps(state,indent=2)+'\n');temp.replace(out/'status.json')
 try:
  os.nice(10);subprocess.run(['ionice','-c','2','-n','7','-p',str(os.getpid())],check=True)
  selected=set()
  for name in ['backend','frontend']:
   base=ROOT/'srs-web-console'/name
   for tree in ['src','public']:
    folder=base/tree
    if folder.exists():selected.update(p for p in folder.rglob('*') if p.is_file() and not p.is_symlink())
   selected.update(p for p in base.iterdir() if p.is_file() and (p.suffix in ['.json','.ts','.js','.cjs','.html'] or p.name=='package-lock.json') and 'tsbuildinfo' not in p.name)
  selected.update((ROOT/'test/fixtures').glob('*.json'))
  manifest={}
  for source in sorted(selected):
   rel=source.relative_to(ROOT);before=sha(source);target=out/'source'/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
   if sha(source)!=before or sha(target)!=before:raise RuntimeError('Concurrent source edit: '+str(rel))
   manifest[str(rel)]=before
  if any(sha(ROOT/rel)!=before for rel,before in manifest.items()):raise RuntimeError('Source generation changed while freezing')
  (out/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
  for name in ['backend','frontend']:
   base=out/'source/srs-web-console'/name;modules=base/'node_modules';modules.mkdir()
   # Dependency packages are read-only links; caches remain private to this build.
   for package in (ROOT/'srs-web-console'/name/'node_modules').iterdir():
    if package.name not in ['.tmp','.cache','.vite','.vite-temp']: (modules/package.name).symlink_to(package,target_is_directory=package.is_dir())
   if name=='frontend':
    for config in ['tsconfig.app.json','tsconfig.node.json']:
     path=base/config;text=path.read_text();path.write_text(text.replace('./node_modules/.tmp/','./.candidate-cache/'))
   status('building-'+name)
   subprocess.run(['npm','run','build'],cwd=base,check=True)
  artifacts={}
  for name in ['backend','frontend']:
   dist=out/'source/srs-web-console'/name/'dist';files=[p for p in dist.rglob('*') if p.is_file()]
   if not files:raise RuntimeError('Missing '+name+' build')
   artifacts[name]={'root':str(dist),'files':len(files),'sha256':hashlib.sha256(json.dumps([(str(p.relative_to(dist)),sha(p)) for p in sorted(files)]).encode()).hexdigest()}
  status('passed',artifacts=artifacts,current_source_changes=[r for r,h in manifest.items() if not (ROOT/r).exists() or sha(ROOT/r)!=h])
 except Exception as error:
  status('failed',error_type=type(error).__name__);raise
if __name__=='__main__':main()
