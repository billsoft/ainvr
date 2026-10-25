#!/usr/bin/env python3
"""Prepare a bounded PS sample from MP4/TS using copy-only FFmpeg + ps_fixture.
Run where the test remuxer is built (normally the board); copy resulting sample
back to Windows. Audio must be AAC, or explicitly omit it. No video transcoding.
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time
from virtual_camera import load_records

def main():
    root=Path(__file__).resolve().parents[2]
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('input',type=Path);p.add_argument('output',type=Path)
    p.add_argument('--seconds',type=int,default=60)
    p.add_argument('--no-audio',action='store_true')
    p.add_argument('--ffmpeg',type=Path,default=root/'out/gb28181/ffmpeg-runtime/bin/ffmpeg')
    p.add_argument('--remuxer',type=Path,default=root/'out/gb28181/ps_fixture')
    a=p.parse_args()
    if not 2<=a.seconds<=120: p.error('duration must be 2..120 seconds')
    if not a.input.is_file() or a.output.exists(): p.error('input missing or output already exists')
    probe=a.ffmpeg.with_name('ffprobe' + a.ffmpeg.suffix)
    info=json.loads(subprocess.check_output([str(probe),'-v','error','-show_streams','-of','json',str(a.input)],timeout=10))
    videos=[v for v in info['streams'] if v['codec_type']=='video']
    audio=[v for v in info['streams'] if v['codec_type']=='audio']
    if not videos or videos[0]['codec_name'] not in ('h264','hevc'): p.error('video must already be H.264 or H.265')
    if audio and not a.no_audio and audio[0]['codec_name']!='aac': p.error('audio must be AAC; alternatively use --no-audio')
    a.output.parent.mkdir(parents=True,exist_ok=True)
    procs=[]
    # Never overwrite existing files or retain an incomplete sample as a valid one.
    with tempfile.TemporaryDirectory(dir=a.output.parent) as temporary:
        sample=Path(temporary)/'sample.psrecords'
        log=Path(temporary)/'remux.log'
        try:
            with log.open('wb') as errors,sample.open('wb') as target:
                command=[str(a.ffmpeg),'-nostdin','-hide_banner','-loglevel','error','-i',str(a.input),'-t',str(a.seconds),'-map','0:v:0']
                if not a.no_audio: command+=['-map','0:a:0?']
                command+=['-c','copy','-f','mpegts','pipe:1']
                source=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=errors);procs.append(source)
                sink=subprocess.Popen([str(a.remuxer)],stdin=source.stdout,stdout=target,stderr=errors);procs.append(sink);source.stdout.close()
                deadline=time.monotonic()+60
                while sink.poll() is None:
                    if time.monotonic()>deadline or sample.stat().st_size>128*1024*1024: raise RuntimeError('sample preparation limit exceeded')
                    time.sleep(.1)
                if source.wait(timeout=3)!=0 or sink.returncode!=0: raise RuntimeError('remux failed; use H.264/H.265 video and AAC audio, or --no-audio')
            records=load_records(sample)
            with a.output.open('xb') as destination,sample.open('rb') as data:
                while chunk:=data.read(65536):destination.write(chunk)
            print(f'Prepared {len(records)} compressed PS records: {a.output}')
        finally:
            for proc in reversed(procs):
                if proc.poll() is None:
                    proc.terminate()
                    try:proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':main()
