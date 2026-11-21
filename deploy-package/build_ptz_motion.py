#!/usr/bin/env python3
"""Build the paired console/alarm motion-admission release without changing live services."""
from pathlib import Path
import argparse,importlib.util,json,os,shutil,subprocess,sys,time

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('console_build',ROOT/'deploy-package/build-onvif-release.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)

def sources():
    extra=[p for p in (ROOT/'alarm-service/src').rglob('*.mjs')]
    extra += [ROOT/'alarm-service/package.json',ROOT/'alarm-service/package-lock.json']
    extra += list((ROOT/'deploy-package').glob('*ptz_motion*'))
    extra += [ROOT/'deploy-package/ptz-motion-state.mjs']
    return {**base.sources(),**{str(p.relative_to(ROOT)):base.sha(p) for p in extra if p.is_file()}}

def build(output):
    output=output.resolve()
    if not output.is_relative_to(ROOT/'out') or output.exists():
        raise RuntimeError('Use a new candidate directory under out/')
    output.mkdir(parents=True)
    initial=sources();(output/'source-manifest.json').write_text(json.dumps(initial,indent=2)+'\n')
    env={**os.environ,'PATH':'/opt/node-v26.13.0-linux-arm64/bin:'+os.environ['PATH'],'NODE_OPTIONS':'--max-old-space-size=1024'}
    def run(command,cwd,label):
        with (output/(label+'.log')).open('wb') as log:
            subprocess.run(command,cwd=cwd,env=env,stdout=log,stderr=log,check=True,timeout=300)
    try:
        backend=ROOT/'srs-web-console/backend';frontend=ROOT/'srs-web-console/frontend'
        run(['node','node_modules/typescript/bin/tsc','-p','tsconfig.json','--outDir',str(output/'backend')],backend,'backend-build')
        shutil.copytree(backend/'src/store/migrations',output/'backend/store/migrations',dirs_exist_ok=True)
        shutil.copytree(backend/'helpers',output/'backend/helpers',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
        (output/'backend/ptz-compatibility.json').write_text(json.dumps({'schema':1,'viewGuardVersion':1,'sceneBindingVersion':1,'presetBindingVersion':1,'motionAdmissionVersion':1})+'\n')
        run(['node','node_modules/typescript/bin/tsc','-b','--noEmit'],frontend,'frontend-typecheck')
        run(['node','node_modules/vite/bin/vite.js','build','--outDir',str(output/'frontend')],frontend,'frontend-build')
        shutil.copytree(ROOT/'alarm-service/src',output/'alarm-src')
        base.copy_release_tools(output)
        for p in [*(ROOT/'deploy-package').glob('*ptz_motion*'),ROOT/'deploy-package/ptz-motion-state.mjs']:
            if p.is_file():shutil.copy2(p,output/'deploy-package'/p.name)
        if sources()!=initial:raise RuntimeError('Source changed during build; use a new candidate')
        (output/'artifacts.json').write_text(json.dumps({p:base.tree(output/p) for p in ['backend','frontend','alarm-src','deploy-package','shared']},indent=2)+'\n')
        (output/'status.json').write_text(json.dumps({'phase':'built','motionAdmissionVersion':1,'createdAt':time.time()})+'\n')
        print(str(output))
    except BaseException:
        (output/'status.json').write_text('{"phase":"failed"}\n');raise

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    build(parser.parse_args().output)
