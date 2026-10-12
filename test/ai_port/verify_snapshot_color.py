#!/usr/bin/env python3
"""AINVR hardware geometry/GLES color conversion/JPU screenshot integration."""
from pathlib import Path
import datetime,json,os,subprocess
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
def main():
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    work=ROOT/'test/runtime'/('snapshot-color-'+stamp);work.mkdir()
    out=ROOT/'test/results'/('snapshot-color-'+stamp);out.mkdir()
    probe=work/'probe';build=ROOT/'out/build/ai-s100p'
    libs=['image_preprocessor','jpeg','pym','gdc','media_memory','gles']
    subprocess.run(['c++','-std=c++17','-O2','-I'+str(ROOT/'ai-service/src'),
        str(ROOT/'test/ai_port/snapshot_color_probe.cpp'),*[str(build/f'libainvr_{lib}.a') for lib in libs],
        '-L/usr/hobot/lib','-Wl,-rpath,/usr/hobot/lib','-lmultimedia','-lhbmem','-lvpf',
        '-lEGL','-lGLESv2','-lgbm','-lwayland-client','-o',str(probe)],check=True,timeout=60)
    images=out/'images'
    with (out/'probe.log').open('w') as log:
        subprocess.run([str(probe),str(images)],check=True,timeout=180,
            env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'),stdout=log,stderr=subprocess.STDOUT)
    report=json.loads((images/'summary.json').read_text())
    for case in report['cases']:
        if not case['jpeg_encoded']:continue
        name=case['case']
        decoded=subprocess.run(['/usr/bin/ffmpeg','-hide_banner','-loglevel','error',
            '-i',str(images/(name+'.jpg')),'-vf','scale=in_range=pc:out_range=pc',
            '-pix_fmt','nv12','-f','rawvideo','-'],check=True,capture_output=True,timeout=45)
        assert not decoded.stderr,decoded.stderr.decode(errors='replace')
        actual=np.frombuffer(decoded.stdout,dtype=np.uint8)
        expected=np.fromfile(images/(name+'.nv12'),dtype=np.uint8)
        assert len(actual)==len(expected)==case['width']*case['height']*3//2
        mae=float(np.abs(actual.astype(np.int16)-expected.astype(np.int16)).mean())
        assert mae<3,(case,mae)
        case['jpeg_vs_cpu_mae']=mae
    report.update(status='PASS',scope='geometry/color/JPU screenshot stages; not archive persistence or channel service')
    (out/'summary.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report));print(out)
if __name__=='__main__':main()
