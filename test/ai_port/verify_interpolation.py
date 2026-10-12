#!/usr/bin/env python3
"""AINVR GPU filter acceptance; OpenCV/CPU is a test oracle, never inference.

Run as root: python3 test/ai_port/verify_interpolation.py
Quality cases use RGB8 OpenCV resize. Benchmarks include upload/readback, but
exclude decode, inference, rendering, recording and source-fixture generation.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import signal
import subprocess
import sys
import time
import cv2
import numpy as np

ROOT=Path(__file__).resolve().parents[2]


def main():
    assert ROOT.resolve()==Path('/home/sunrise/ainvr') and os.geteuid()==0
    assert Path('/mnt/ainvr-ssd').is_mount()
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+str(os.getpid())
    result=ROOT/'test/results'/('interpolation-'+stamp);result.mkdir()
    work=Path('/mnt/ainvr-ssd/test-media')/result.name;work.mkdir(mode=0o700)
    account=pwd.getpwnam('sunrise');os.chown(work,account.pw_uid,account.pw_gid)
    binary=ROOT/'out/build/ai-ffmpeg8/ainvr_interpolation_probe'
    cases=[];benchmarks=[];contracts=None
    filters={'bicubic':(1,cv2.INTER_CUBIC),'area':(2,cv2.INTER_AREA),'lanczos4':(3,cv2.INTER_LANCZOS4)}

    def cancelled(_signum,_frame):raise KeyboardInterrupt('GPU interpolation test cancelled')
    signal.signal(signal.SIGTERM,cancelled)

    def command(args,log,seconds):
        child=subprocess.Popen(args,env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'),
            stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:return child.wait(timeout=seconds)
        finally:
            try:os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)

    def probe(label,name,format,iw,ih,ow,oh,letterbox,oracle,repeats=3):
        directory=work/label
        args=['runuser','-u','sunrise','--',str(binary),str(directory),str(filters[name][0]),
            str(iw),str(ih),str(ow),str(oh),str(int(letterbox)),format,str(repeats),str(int(oracle))]
        with (result/(label+'.log')).open('w') as log:
            code=command(args,log,150)
        assert code==0, label+' hardware failure; inspect its log'
        report=json.loads((directory/'native.json').read_text());assert report['passed'] and report['backend']=='gles'
        output=np.fromfile(directory/'output.f32',dtype=np.float32).reshape(3,oh,ow)
        assert np.isfinite(output).all()
        return directory,report,output

    try:
        with (result/'contracts.log').open('w') as log:
            code=command(['runuser','-u','sunrise','--',str(binary),'--validate-contract'],log,15)
        assert code==0
        contracts=json.loads((result/'contracts.log').read_text());assert contracts['passed'] and contracts['invalid_contracts_rejected']==5
        for name,(_,flag) in filters.items():
            for format in ['rgba','nv12_601_full','nv12_709_limited']:
                for label,iw,ih,ow,oh,box in [('shrink',74,50,23,17,False),
                        ('grow',38,26,91,73,False),('letterbox',78,34,37,43,True)]:
                    label=name+'-'+format+'-'+label
                    directory,report,output=probe(label,name,format,iw,ih,ow,oh,box,True)
                    if format=='rgba':
                        source=np.fromfile(directory/'input.rgba',dtype=np.uint8).reshape(ih,iw,4)[:,:,:3]
                    else:
                        source=np.fromfile(directory/'source-rgb-cpu-oracle.u8',dtype=np.uint8).reshape(ih,iw,3)
                    nw,nh=ow,oh
                    if box:
                        gain=min(ow/iw,oh/ih);nw,nh=round(iw*gain),round(ih*gain)
                    resized=cv2.resize(source,(nw,nh),interpolation=flag)
                    rgb=np.empty((oh,ow,3),dtype=np.float32);rgb[:]=report['padding']
                    x,y=(ow-nw)//2,(oh-nh)//2;rgb[y:y+nh,x:x+nw]=resized
                    expected=(rgb[:,:,::-1].transpose(2,0,1)-np.array(report['mean'])[:,None,None])/np.array(report['divisor'])[:,None,None]
                    # Measure in original 8-bit channel units, before normalization.
                    error=np.abs(output-expected)*np.array(report['divisor'])[:,None,None]
                    maximum=float(error.max());mean=float(error.mean())
                    row={**report,'name':name,'label':label,'max_byte_error':maximum,'mean_byte_error':mean,'artifact':str(directory)}
                    cases.append(row)
                    assert maximum<=2.05 and mean<=.35, label+' differs from independent RGB8 resize oracle'
                    print(json.dumps({'quality':label,'max_byte_error':maximum,'mean_byte_error':mean}),flush=True)
        for name in filters:
            for iw,ih in [(3840,2160),(7680,3840)]:
                label=name+'-nv12-benchmark-'+str(iw)
                directory,report,output=probe(label,name,'nv12_709_limited',iw,ih,640,640,True,False,5)
                benchmarks.append({**report,'name':name,'artifact':str(directory)})
                print(json.dumps({'benchmark':label,'warm_mean_ms':report['warm_mean_ms'],'warm_fps':report['warm_fps']}),flush=True)
    finally:
        summary={'passed':bool(contracts and contracts['passed']) and len(cases)==27 and len(benchmarks)==6 and all(c['max_byte_error']<=2.05 and c['mean_byte_error']<=.35 for c in cases),
            'contracts':contracts,
            'quality_cases':cases,'benchmarks':benchmarks,'cv2_version':cv2.__version__,
            'opencv_is_test_oracle_only':True,'gpu_resize_verified':len(cases)==27,
            'user_model_inference_verified':False,'full_migration_completed':False,
            'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
            'production_resize_defaults_changed':False}
        (result/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print('RESULT',str(result),flush=True)
    return 0 if summary['passed'] else 1


if __name__=='__main__':sys.exit(main())
