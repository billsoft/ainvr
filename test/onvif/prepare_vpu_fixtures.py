#!/usr/bin/env python3
"""Reproducible test camera media: S100P VPU video and distinctive audio.

The installed vendor example is read only. A scratch copy changes only GOP
configuration for the requested fixture; no vendor source/binary is shipped as
AINVR product code. CPU work synthesizes test patterns/audio, not video encoding.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import wave
import numpy as np

ROOT=Path(__file__).resolve().parents[2]
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--result',type=Path,required=True)
    parser.add_argument('--sdk',type=Path,default=Path('/app/multimedia_samples'))
    parser.add_argument('--width',type=int,default=320)
    parser.add_argument('--height',type=int,default=240)
    parser.add_argument('--fps',type=int,default=10)
    parser.add_argument('--seconds',type=int,default=18)
    parser.add_argument('--gop-preset',type=int,choices=[9],default=9)
    args=parser.parse_args();out=args.result.resolve()
    if not out.is_relative_to(ROOT/'test/results') or out.exists():raise ValueError('Use a new directory under test/results/')
    if not 160<=args.width<=1920 or args.width%16 or not 128<=args.height<=1080 or args.height%8 or not 3<=args.fps<=30 or not 2<=args.seconds<=30:raise ValueError('Bounded fixture dimensions, fps and duration required')
    out.mkdir(parents=True)
    original=args.sdk/'sample_codec/sample_codec.c'
    source=original.read_text()
    old='params->gop_params.gop_preset_idx = 1;'
    assert source.count(old)==1,'Vendor sample version changed; review before adapting'
    source=source.replace(old,f'params->gop_params.gop_preset_idx = {args.gop_preset};\n params->gop_params.decoding_refresh_type = 2;')
    # Vendor synchronous sample cannot feed reordered B-frame GOPs.
    # Use an existing timestamped camera fixture for B-frame tests.
    period=args.fps
    for codec in ['h264','h265']:
        old=f'params->rc_params.{codec}_cbr_params.frame_rate = frame_rate;'
        assert source.count(old)==1
        source=source.replace(old,old+f'\n params->rc_params.{codec}_cbr_params.intra_period = {period};')
    scratch=out/'sample_codec_fixture.c';scratch.write_text(source)
    files=[scratch,*sorted((args.sdk/'utils').glob('*.c')),*sorted((args.sdk/'vp_sensors').glob('*.c'))]
    for folder in sorted((args.sdk/'vp_sensors').iterdir()):
        if folder.is_dir():files.extend(sorted(folder.glob('*.c')))
    command=['gcc','-O1','-I/usr/hobot/include','-I/usr/include/cjson','-I'+str(args.sdk/'utils'),'-I'+str(args.sdk/'vp_sensors'),'-I'+str(args.sdk/'sample_codec'),*[str(p) for p in files],'-L/usr/hobot/lib','-lvpf','-lvio','-lcam','-lhbmem','-lmultimedia','-lavformat','-lavcodec','-lavutil','-lswresample','-lm','-lpthread','-o',str(out/'sample_codec')]
    with (out/'build.log').open('wb') as log:subprocess.run(command,stdout=log,stderr=log,check=True,timeout=90)
    rate=16000;rng=np.random.default_rng(28181);audio=[]
    for _ in range(args.seconds):
        t=np.arange(rate)/rate;f=int(rng.integers(220,2200));g=int(rng.integers(100,1200))
        audio.append(np.rint(9500*(.5+.5*np.sin(np.pi*t)**2)*(np.sin(2*np.pi*(f*t+230*t*t))+.3*np.sin(2*np.pi*g*t))).astype('<i2'))
    audio_file=out/'distinctive.wav'
    with wave.open(str(audio_file),'wb') as wav:
        wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(rate);wav.writeframes(np.concatenate(audio).tobytes())
    count=args.fps*args.seconds;frame_bytes=args.width*args.height*3//2
    unique=min(count,(128<<20)//frame_bytes)
    if unique<args.fps:raise ValueError('Raw fixture would exceed its bounded RAM budget')
    if shutil.disk_usage('/dev/shm').free<unique*frame_bytes+(16<<20):raise RuntimeError('Insufficient temporary RAM for fixture')
    with tempfile.TemporaryDirectory(prefix='ainvr-onvif-fixture-',dir='/dev/shm') as temp:
        raw=Path(temp)/'pattern.nv12'
        with raw.open('xb') as handle:
            for index in range(unique):
                frame=np.full((args.height,args.width),32+index%180,dtype=np.uint8)
                x=(index*3)%max(1,args.width-64)
                frame[args.height//4:3*args.height//4,x:x+64]=235
                handle.write(frame.tobytes());handle.write(bytes([128])*(args.width*args.height//2))
        for codec,kind in [('h264',0),('hevc',1)]:
            config=out/(codec+'.ini');elementary=out/(codec+'.es')
            profile='h264_main@L4' if kind==0 else 'h265_main@L4%high_tier'
            config.write_text(f'[encode]\nencode_streams=0x1\n[venc_stream1]\ncodec_type={kind}\nwidth={args.width}\nheight={args.height}\nframe_rate={args.fps}\nbit_rate=2048\ninput={raw}\noutput={elementary}\nframe_num={count}\nprofile={profile}\n[decode]\ndecode_streams=0x0\n')
            with (out/(codec+'-encode.log')).open('wb') as log:subprocess.run([str(out/'sample_codec'),'-f',str(config)],stdout=log,stderr=log,check=True,timeout=90)
            subprocess.run(['/usr/bin/ffmpeg','-hide_banner','-loglevel','error','-fflags','+genpts','-r',str(args.fps),'-f','h264' if kind==0 else 'hevc','-i',str(elementary),'-i',str(audio_file),'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','64k','-t',str(args.seconds),'-y',str(out/(codec+'.mp4'))],check=True,timeout=30)
    manifest={'description':'S100P VPU encoded video; distinctive test-only synthesized audio','dimensions':[args.width,args.height],'fps':args.fps,'seconds':args.seconds,'gopPreset':args.gop_preset,'idrFrames':period,'sdkOriginalSHA256':sha(original),'scratchChanges':['GOP preset','IDR refresh type 2','intra period'],'files':{name:sha(out/name) for name in ['h264.mp4','hevc.mp4','distinctive.wav']}}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(str(out))
if __name__=='__main__':main()
