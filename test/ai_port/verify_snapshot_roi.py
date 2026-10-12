#!/usr/bin/env python3
"""AINVR target crop coordinates, edge replication, GPU/CPU and JPU checks."""
import datetime,json,os,subprocess
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
out=ROOT/'test/results'/('snapshot-roi-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
out.mkdir()
build=ROOT/'out/build/ai-s100p'
libs=['image_preprocessor','jpeg','pym','gdc','media_memory','gles']
subprocess.run(['c++','-std=c++17','-O2','-I'+str(ROOT/'ai-service/src'),str(ROOT/'test/ai_port/snapshot_roi_probe.cpp'),str(ROOT/'ai-service/src/output/snapshot_plan.cpp'),*[str(build/f'libainvr_{lib}.a') for lib in libs],'-L/usr/hobot/lib','-Wl,-rpath,/usr/hobot/lib','-lmultimedia','-lhbmem','-lvpf','-lEGL','-lGLESv2','-lgbm','-lwayland-client','-o',str(out/'probe')],check=True,timeout=60)
with (out/'probe.log').open('w') as log:
    subprocess.run([str(out/'probe'),str(out/'images')],check=True,timeout=120,env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'),stdout=log,stderr=subprocess.STDOUT)
cases=json.loads((out/'images/summary.json').read_text())
for c in cases:
    if not c['encoded']:continue
    stem=out/'images'/c['name']
    run=subprocess.run(['/usr/bin/ffmpeg','-v','error','-i',str(stem)+'.jpg','-vf','scale=in_range=pc:out_range=pc','-pix_fmt','nv12','-f','rawvideo','-'],capture_output=True,check=True,timeout=30)
    assert not run.stderr,run.stderr
    got=np.frombuffer(run.stdout,dtype=np.uint8)
    want=np.fromfile(str(stem)+'.nv12',dtype=np.uint8)
    assert len(got)==len(want)==c['width']*c['height']*3//2
    c['jpeg_mae']=float(np.abs(got.astype(np.int16)-want.astype(np.int16)).mean())
    assert c['jpeg_mae']<2,c
report=dict(passed=True,cases=cases,scope='Crop geometry rendering and eligible JPU outputs; odd/tiny JPEG and reference INTER_AREA parity remain pending')
(out/'summary.json').write_text(json.dumps(report,indent=2))
print(out/'summary.json')
