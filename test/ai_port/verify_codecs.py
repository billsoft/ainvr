#!/usr/bin/env python3
"""AINVR native VPU/JPU regression using generated, non-private fixtures."""
import json
import os
from pathlib import Path
import subprocess
ROOT=Path(__file__).resolve().parents[2]
def main():
    work=ROOT/'test/runtime/ai-codecs';out=ROOT/'test/results/ai-port-20261011'
    work.mkdir(parents=True,exist_ok=True);out.mkdir(parents=True,exist_ok=True)
    env=os.environ.copy();env['LD_LIBRARY_PATH']='/usr/hobot/lib';report={}
    cases=[('h264',['-c:v','libx264','-preset','ultrafast','-bf','0','-f','h264'],12),
           ('h264-bframes',['-c:v','libx264','-preset','medium','-bf','2','-f','h264'],12),
           ('h265',['-c:v','libx265','-preset','ultrafast','-x265-params','pools=2:frame-threads=1:bframes=2','-f','hevc'],12),
           ('jpeg',['-c:v','mjpeg','-threads','1','-f','image2'],1)]
    for name,options,frames in cases:
        suffix='.jpg' if name=='jpeg' else '.h265' if name=='h265' else '.h264';source=work/(name+suffix)
        generation=subprocess.run(['/usr/bin/ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x320:rate=15','-frames:v',str(frames),*options,'-y',str(source)],capture_output=True,text=True,timeout=60)
        (out/(name+'-fixture.log')).write_text(generation.stdout+generation.stderr,encoding='utf-8');generation.check_returncode()
        result=subprocess.run([str(ROOT/'out/build/ai-s100p/ainvr_decode_probe'),str(source),'640','320',str(frames)],env=env,capture_output=True,text=True,timeout=30)
        (out/(name+'-decode.log')).write_text(result.stdout+result.stderr,encoding='utf-8');result.check_returncode()
        report[name]=json.loads(result.stdout[result.stdout.find('{\n'):])
        if not 10<report[name]['mean_y']<245:raise RuntimeError('Unexpected blank decoded image')
    (out/'codec-summary.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))
if __name__=='__main__':main()
