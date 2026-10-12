#!/usr/bin/env python3
"""AINVR JPU encode with independent JPEG decoding and changing YUV content."""
from pathlib import Path
import datetime,json,os,subprocess
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
def main():
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    work=ROOT/'test/runtime'/('jpeg-encoder-'+stamp);work.mkdir()
    out=ROOT/'test/results'/('jpeg-encoder-'+stamp);out.mkdir()
    probe=work/'probe'
    subprocess.run(['c++','-std=c++17','-O2','-I'+str(ROOT/'ai-service/src'),
        str(ROOT/'test/ai_port/jpeg_encode_probe.cpp'),str(ROOT/'out/build/ai-s100p/libainvr_jpeg.a'),
        str(ROOT/'out/build/ai-s100p/libainvr_media_memory.a'),'-L/usr/hobot/lib',
        '-Wl,-rpath,/usr/hobot/lib','-lmultimedia','-lhbmem','-o',str(probe)],check=True,timeout=60)
    cases=[]
    for w,h in [(18,18),(30,22),(638,358),(1922,1082),(3840,2160),(7680,3840)]:
      folder=out/f'{w}x{h}'
      with (out/f'{w}x{h}.log').open('w') as log:
        subprocess.run([str(probe),str(w),str(h),str(folder)],check=True,timeout=45,
            env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'),stdout=log,stderr=subprocess.STDOUT)
      summary=json.loads((folder/'summary.json').read_text())
      for i in range(3):
        metadata=json.loads(subprocess.check_output(['/usr/bin/ffprobe','-v','error',
            '-show_entries','stream=width,height','-of','json',str(folder/f'{i}.jpg')],timeout=10))['streams'][0]
        assert (metadata['width'],metadata['height'])==(w,h),metadata
        decoded=subprocess.run(['/usr/bin/ffmpeg','-hide_banner','-loglevel','error',
            '-i',str(folder/f'{i}.jpg'),'-vf','scale=in_range=pc:out_range=pc',
            '-pix_fmt','nv12','-f','rawvideo','-'],timeout=30,check=True,capture_output=True)
        assert not decoded.stderr,decoded.stderr.decode(errors='replace')
        raw=decoded.stdout
        actual=np.frombuffer(raw,dtype=np.uint8)
        assert len(actual)==w*h*3//2
        expected=np.empty(w*h*3//2,dtype=np.uint8)
        y=expected[:w*h].reshape(h,w);y[:]=32+i*40;y[:,w//2:]+=32;y[h//2:,:]+=24
        expected[w*h::2]=90+i*10;expected[w*h+1::2]=160-i*10
        mae=float(np.abs(actual.astype(np.int16)-expected.astype(np.int16)).mean())
        assert mae<2,(w,h,i,mae)
        luma_error=np.abs(actual[:w*h].astype(np.int16).reshape(h,w)-expected[:w*h].astype(np.int16).reshape(h,w))
        edge_mae=float(np.concatenate([luma_error[-2:,:].ravel(),luma_error[:,-2:].ravel()]).mean())
        assert edge_mae<3,(w,h,i,'edge',edge_mae)
        summary['frames'][i]['decoded_nv12_mae']=mae
        summary['frames'][i]['edge_mae']=edge_mae
      cases.append(summary)
    (out/'summary.json').write_text(json.dumps({'status':'PASS','cases':cases,
        'scope':'JPU stage only, full-range BT601 NV12; not full snapshot pipeline'},indent=2))
    print(json.dumps(cases));print(out)
if __name__=='__main__':main()
