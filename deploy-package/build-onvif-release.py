#!/usr/bin/env python3
"""Build an isolated ONVIF/console candidate without replacing live files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT=Path(__file__).resolve().parents[1]
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def tree(path):return {p.relative_to(path).as_posix():sha(p) for p in sorted(path.rglob('*')) if p.is_file() and '__pycache__' not in p.parts}
def sources():
    files=[]
    for name in ['srs-web-console/backend/src','srs-web-console/frontend/src','onvif-service','shared/ptzcontrol','ingest-service','shared/host-restart-helper','shared/python']:
        files.extend(p for p in (ROOT/name).rglob('*') if p.is_file() and not p.is_relative_to(ROOT/'shared/host-restart-helper/data') and '__pycache__' not in p.parts and 'node_modules' not in p.parts and '.git' not in p.parts)
    for name in ['srs-web-console/backend','srs-web-console/frontend']:
        files.extend(p for p in (ROOT/name).iterdir() if p.is_file() and (p.suffix in ['.json','.ts','.js','.cjs'] or p.name=='index.html'))
    files.extend(ROOT/'deploy-package'/name for name in ['deploy_ptz_release.py','release_common.py','ptz-production-state.mjs','ptz_rollback_guard.py','ptz-rollback-state.mjs'])
    return {p.relative_to(ROOT).as_posix():sha(p) for p in sorted(set(files))}
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    output=(args.output or ROOT/'out'/('onvif-release-'+time.strftime('%Y%m%dT%H%M%S'))).resolve()
    if not output.is_relative_to(ROOT/'out') or output.exists():raise RuntimeError('Use a new candidate directory inside out/')
    output.mkdir(parents=True)
    initial=sources();(output/'source-manifest.json').write_text(json.dumps(initial,indent=2)+'\n')
    env={**os.environ,'PATH':'/opt/ainvr/node-v24.20.0-linux-arm64/bin:'+os.environ['PATH'],'GOMAXPROCS':'2','GOTELEMETRY':'off'}
    def run(args,cwd,label):
        with (output/(label+'.log')).open('wb') as log:subprocess.run(args,cwd=cwd,env=env,stdout=log,stderr=log,check=True,timeout=300)
    try:
        backend=ROOT/'srs-web-console/backend';frontend=ROOT/'srs-web-console/frontend'
        run(['node','node_modules/typescript/bin/tsc','-p','tsconfig.json','--outDir',str(output/'backend')],backend,'backend-build')
        shutil.copytree(backend/'src/store/migrations',output/'backend/store/migrations',dirs_exist_ok=True)
        (output/'backend/ptz-compatibility.json').write_text(json.dumps({'schema':1,'viewGuardVersion':1})+'\n')
        run(['node','node_modules/typescript/bin/tsc','-b','--noEmit'],frontend,'frontend-typecheck')
        run(['node','node_modules/vite/bin/vite.js','build','--outDir',str(output/'frontend')],frontend,'frontend-build')
        go=Path(os.environ.get('AINVR_GO',str(ROOT/'out/gb28181/go/bin/go')))
        # First-party replacement is source, not a downloaded module archive.
        # Mark it as a workspace main module for checksum verification; both
        # source trees are already frozen in source-manifest.json.
        workspace=output/'verification.work'
        workspace.write_text('go 1.24.0\nuse (\n'+str(ROOT/'onvif-service')+'\n'+str(ROOT/'shared/ptzcontrol')+'\n)\n')
        env['GOWORK']=str(workspace)
        run([str(go),'mod','verify'],ROOT/'onvif-service','go-dependencies')
        (output/'onvif').mkdir()
        run([str(go),'build','-trimpath','-o',str(output/'onvif/ainvr_onvif'),'./cmd/onvif'],ROOT/'onvif-service','go-build')
        shutil.copytree(ROOT/'out/media-bridge/runtime',output/'media-bridge')
        (output/'deploy-package').mkdir()
        for name in ['deploy_ptz_release.py','release_common.py','ptz-production-state.mjs','ptz_rollback_guard.py','ptz-rollback-state.mjs']:
            shutil.copy2(ROOT/'deploy-package'/name,output/'deploy-package'/name)
        (output/'onvif/licenses').mkdir()
        module_cache=Path(subprocess.check_output([str(go),'env','GOMODCACHE'],cwd=ROOT/'onvif-service',env=env,text=True).strip())
        shutil.copy2(module_cache/'github.com/icholy/digest@v1.2.0/LICENSE',output/'onvif/licenses/digest-MIT-LICENSE.txt')
        goroot=Path(subprocess.check_output([str(go),'env','GOROOT'],cwd=ROOT/'onvif-service',env=env,text=True).strip())
        shutil.copy2(goroot/'LICENSE',output/'onvif/licenses/Go-LICENSE.txt')
        shutil.copy2(ROOT/'onvif-service/THIRD_PARTY.md',output/'onvif/THIRD_PARTY.md')
        (output/'helper').mkdir()
        shutil.copy2(ROOT/'shared/host-restart-helper/observability.py',output/'helper/observability.py')
        shutil.copytree(ROOT/'shared/python',output/'shared/python',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
        for name in ['main.py','media_policy.py','async_launch.py']:
            target=output/'ingest-service'/name;target.parent.mkdir(exist_ok=True);shutil.copy2(ROOT/'ingest-service'/name,target)
        if sources()!=initial:raise RuntimeError('Source changed while building; discard candidate and rebuild')
        artifacts={name:tree(output/name) for name in ['frontend','backend','onvif','ingest-service','media-bridge','shared','deploy-package','helper']}
        (output/'artifacts.json').write_text(json.dumps(artifacts,indent=2)+'\n')
        (output/'status.json').write_text(json.dumps({'phase':'built','createdAt':time.time(),'productionChanged':False,'mediaAcceptanceRequired':True},indent=2)+'\n')
        print(str(output))
    except BaseException:
        (output/'status.json').write_text(json.dumps({'phase':'failed','productionChanged':False})+'\n')
        raise
if __name__=='__main__':main()
