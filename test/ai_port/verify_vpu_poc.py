#!/usr/bin/env python3
"""Validate production POC/token matching against independent software frames."""
from pathlib import Path
import datetime
import json
import os
import subprocess
import numpy as np
ROOT=Path(__file__).resolve().parents[2]

def main():
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    work=ROOT/'test/runtime'/('vpu-poc-'+stamp);work.mkdir()
    out=ROOT/'test/results'/('vpu-poc-'+stamp);out.mkdir()
    probe=work/'probe'
    subprocess.run(['c++','-std=c++17','-O2','-I'+str(ROOT/'ai-service/src'),
        str(ROOT/'test/ai_port/vpu_poc_probe.cpp'),str(ROOT/'out/build/ai-s100p/libainvr_vpu.a'),
        str(ROOT/'out/build/ai-s100p/libainvr_media_source.a'),str(ROOT/'out/build/ai-s100p/libainvr_media_memory.a'),
        '-L/usr/hobot/lib','-Wl,-rpath,/usr/hobot/lib','-lmultimedia','-lhbmem',
        '-lavformat','-lavcodec','-lavutil','-o',str(probe)],check=True,timeout=60)
    summary=[]
    for codec in ['h264','hevc']:
      for open_gop in [0,1]:
        name=codec+'-open'+str(open_gop);video=work/(name+'.mp4')
        params=f'open-gop={open_gop}:scenecut=0'
        encoder=['-c:v','libx264','-x264-params',params] if codec=='h264' else [
            '-c:v','libx265','-x265-params','pools=1:frame-threads=1:log-level=error:'+params]
        with (out/(name+'-encode.log')).open('w') as log:
          subprocess.run(['/usr/bin/ffmpeg','-hide_banner','-loglevel','error','-f','lavfi',
            '-i','testsrc2=size=640x360:rate=15','-vf','setpts=(N+floor(N/3))/(15*TB)',
            '-vsync','vfr','-frames:v','36',*encoder,'-threads','1','-preset','fast','-bf','2','-g','12',str(video)],
            check=True,timeout=60,stdout=log,stderr=subprocess.STDOUT)
        hw_path=work/(name+'-hw.yuv');cpu_path=work/(name+'-cpu.yuv');report=out/(name+'.json')
        with (out/(name+'-decode.log')).open('w') as log:
          subprocess.run([str(probe),str(video),str(hw_path),str(report)],
            env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'),check=True,timeout=30,stdout=log,stderr=subprocess.STDOUT)
        subprocess.run(['/usr/bin/ffmpeg','-hide_banner','-loglevel','error','-i',str(video),
            '-vsync','0','-pix_fmt','nv12','-f','rawvideo',str(cpu_path)],check=True,timeout=30)
        software=json.loads(subprocess.check_output(['/usr/bin/ffprobe','-v','error','-select_streams','v',
            '-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',str(video)],timeout=30))['frames']
        actual=json.loads(report.read_text())['frames']
        assert len(actual)==len(software)==36
        assert len({f['token'] for f in actual})==36
        for a,b in zip(actual,software):assert abs(a['pts_ns']-round(float(b['best_effort_timestamp_time'])*1e9))<=501,(a,b)
        hw=np.fromfile(hw_path,dtype=np.uint8).reshape(36,-1)
        cpu=np.fromfile(cpu_path,dtype=np.uint8).reshape(36,-1)
        errors=np.abs(hw.astype(np.int16)-cpu.astype(np.int16)).mean(axis=1)
        assert max(errors)<1,errors.tolist()
        summary.append({'codec':codec,'open_gop':bool(open_gop),'frames':36,
            'pixel_mae_max':float(max(errors)),'source_pts_match':True})
    (out/'summary.json').write_text(json.dumps({'status':'PASS','cases':summary},indent=2))
    print(json.dumps(summary));print(out)

if __name__=='__main__':main()
