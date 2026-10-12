#!/usr/bin/env python3
"""Exercise real snapshot renderer, codec selection, dimensions and decoded pixels."""
from pathlib import Path
import datetime,json,os,subprocess
ROOT=Path(__file__).resolve().parents[2]
out=ROOT/'test/results'/('snapshot-renderer-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'));out.mkdir()
build=ROOT/'out/build/ai-s100p'
libs=['snapshot','ai_core','image_preprocessor','jpeg','pym','gdc','media_memory','gles']
with (out/'build.log').open('w') as log:
    subprocess.run(['c++','-std=c++17','-O2','-I'+str(ROOT/'ai-service/src'),str(ROOT/'test/ai_port/snapshot_renderer_probe.cpp'),*[str(build/f'libainvr_{x}.a') for x in libs],'-L/usr/hobot/lib','-Wl,-rpath,/usr/hobot/lib','-lmultimedia','-lhbmem','-lvpf','-lEGL','-lGLESv2','-lgbm','-lwayland-client','-ljpeg','-o',str(out/'probe')],check=True,timeout=60,stdout=log,stderr=subprocess.STDOUT)
with (out/'probe.log').open('w') as log:
    subprocess.run([str(out/'probe'),str(out/'images')],check=True,timeout=90,env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'),stdout=log,stderr=subprocess.STDOUT)
cases=json.loads((out/'images/summary.json').read_text())
for c in cases:
    file=out/'images'/(c['name']+'.jpg')
    metadata=json.loads(subprocess.check_output(['/usr/bin/ffprobe','-v','error','-show_entries','stream=width,height','-of','json',str(file)],text=True,timeout=15))['streams'][0]
    assert metadata['width']==c['width'] and metadata['height']==c['height'],c
    run=subprocess.run(['/usr/bin/ffmpeg','-v','error','-i',str(file),'-pix_fmt','rgb24','-f','rawvideo','-'],check=True,capture_output=True,timeout=15)
    assert not run.stderr,run.stderr
    assert len(run.stdout)==c['width']*c['height']*3
    assert max(abs(x-100) for x in run.stdout)<=2,c
report=dict(passed=True,cases=cases,scope='Original snapshot renderer; enhancement/archive/channel service are separate pending stages')
(out/'summary.json').write_text(json.dumps(report,indent=2));print(out/'summary.json')
