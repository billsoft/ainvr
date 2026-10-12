#!/usr/bin/env python3
"""AINVR: investigate display POC against software decode across closed GOPs."""
from pathlib import Path
import datetime
import json
import os
import subprocess
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def main():
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    work = ROOT / 'test/runtime' / ('vpu-timestamps-' + stamp)
    out = ROOT / 'test/results' / ('vpu-timestamps-' + stamp)
    work.mkdir();out.mkdir()
    probe = work / 'probe'
    subprocess.run(['c++', '-std=c++17', '-O2', '-I'+str(ROOT/'ai-service/src'),
        '-I/usr/hobot/include', str(ROOT/'test/ai_port/vpu_timestamp_probe.cpp'),
        str(ROOT/'out/build/ai-s100p/libainvr_media_source.a'),
        str(ROOT/'out/build/ai-s100p/libainvr_media_memory.a'), '-L/usr/hobot/lib',
        '-Wl,-rpath,/usr/hobot/lib', '-lmultimedia', '-lhbmem', '-lavformat',
        '-lavcodec', '-lavutil', '-o', str(probe)], check=True, timeout=60)
    summary = []
    for codec in ['h264', 'hevc']:
        video = work / (codec+'.mp4')
        encoder = (['-c:v', 'libx264', '-x264-params', 'open-gop=0:scenecut=0'] if codec=='h264'
                   else ['-c:v', 'libx265', '-x265-params', 'pools=1:frame-threads=1:open-gop=0:scenecut=0:log-level=error'])
        with (out/(codec+'-encode.log')).open('w') as log:
            subprocess.run(['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
                '-i', 'testsrc2=size=640x360:rate=15', '-frames:v', '36', *encoder,
                '-threads', '1', '-preset', 'fast', '-bf', '2', '-g', '12', str(video)],
                check=True, timeout=60, stdout=log, stderr=subprocess.STDOUT)
        hardware = work/(codec+'-hw.yuv');software=work/(codec+'-cpu.yuv')
        with (out/(codec+'-probe.log')).open('w') as log:
            subprocess.run([str(probe),str(video),str(hardware),str(out/(codec+'.json'))],
                env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'),check=True,
                timeout=30,stdout=log,stderr=subprocess.STDOUT)
        subprocess.run(['/usr/bin/ffmpeg','-hide_banner','-loglevel','error','-i',str(video),
            '-pix_fmt','nv12','-f','rawvideo',str(software)],check=True,timeout=30)
        hw=np.fromfile(hardware,dtype=np.uint8).reshape(-1,640*360*3//2)
        cpu=np.fromfile(software,dtype=np.uint8).reshape(-1,640*360*3//2)
        assert len(hw)==len(cpu)==36
        errors=np.abs(hw.astype(np.int16)-cpu.astype(np.int16)).mean(axis=1)
        assert max(errors)<1,errors.tolist()
        metadata=json.loads((out/(codec+'.json')).read_text())
        pending=list(metadata['inputs']);pts=[]
        for frame in metadata['outputs']:
            assert frame['decode_result'] in [1,16]
            match=next((i for i,p in enumerate(pending) if p['parser_poc']==frame['display_poc']),None)
            assert match is not None,frame
            pts.append(pending.pop(match)['pts_ns'])
        assert not pending
        expected=[round(i*1e9/15) for i in range(36)]
        assert all(abs(a-b)<=1 for a,b in zip(pts,expected)),pts
        summary.append({'codec':codec,'frames':len(hw),'pixel_mae_max':float(max(errors)),
            'poc_pts_match':True,'gops':3,'raw_sdk_token_matches_input':False})
    (out/'summary.json').write_text(json.dumps({'status':'PASS','results':summary,
        'scope':'diagnostic closed-GOP fixtures; not production POC mapping implementation'},indent=2))
    print(json.dumps(summary));print(out)


if __name__=='__main__':main()
