#!/usr/bin/env python3
"""Compile original archive business without CUDA and run original ERP golden tests.
This does not claim a linked/running SnapshotStore or hardware image parity.
"""
from pathlib import Path
import hashlib,json,shlex,subprocess
ROOT=Path(__file__).resolve().parents[2]
BUILD=ROOT/'out/build/reused-snapshot';BUILD.mkdir(parents=True,exist_ok=True)
RESULT=ROOT/'test/results/reused-snapshot.json'
def run(args):subprocess.run(args,cwd=ROOT,check=True,timeout=180)
def flags(*modules):return shlex.split(subprocess.check_output(['pkg-config',*modules],text=True))
units=['snapshot_repository','snapshot_pending','snapshot_pipeline','snapshot_crop','erp_perspective']
report={'passed':False,'scope':'original business object compilation and original ERP golden tests; not service integration','sources':{}}
try:
 for unit in units:
  rel=Path('src/output')/(unit+'.cpp');p=ROOT/'ai-service'/rel;ref=ROOT/'TecheAI/ai-service'/rel
  assert p.read_bytes()==ref.read_bytes(),str(rel)+' diverged from reference'
  report['sources'][str(rel)]=hashlib.sha256(p.read_bytes()).hexdigest()
  run(['g++','-std=c++17','-O0','-pthread','-c',str(p),*flags('--cflags','opencv4','libmongoc-1.0'),'-o',str(BUILD/(unit+'.o'))])
  deps=subprocess.check_output(['g++','-std=c++17','-MM',str(p),*flags('--cflags','opencv4','libmongoc-1.0')],cwd=ROOT,text=True)
  assert not any(x in deps.lower() for x in ['cuda','nvbuf','tensorrt','channel_worker.hpp']),deps
 fixture=ROOT/'ai-service/tests/unit/erp_fixtures.json'
 run(['g++','-std=c++17','-O1','-pthread',str(ROOT/'ai-service/src/output/erp_perspective.cpp'),str(ROOT/'ai-service/tests/unit/erp_perspective_test.cpp'),'-DERP_FIXTURES_PATH="'+str(fixture)+'"',*flags('--cflags','--libs','opencv4','gtest_main'),'-o',str(BUILD/'erp_test')])
 run([str(BUILD/'erp_test'),'--gtest_output=json:'+str(ROOT/'test/results/reused-erp-tests.json')])
 report['passed']=True
finally:RESULT.write_text(json.dumps(report,indent=2))
