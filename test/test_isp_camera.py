#!/usr/bin/env python3
"""SC132GS: bounded official MIPI -> ISP1 -> YNR1 -> PYM1 -> H.264 experiment."""
import argparse
import fcntl
import json
from pathlib import Path
import shutil
import numpy as np
import cv2
from common import Experiment, ROOT, SDK, digest, Skip
from inspect_isp_environment import inspect_environment

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mipi',type=int,choices=[0,1],default=0)
    p.add_argument('--sensor-mode',type=int,choices=[1,6],default=1,
                   help='1: free running, 6: external trigger, using official SC132GS driver modes')
    p.add_argument('--trigger-duty',type=int,default=1000,
                   help='LPWM duty in us; 1000 matches the latest official GS130 S100 backend')
    p.add_argument('--frames',type=int,default=90)
    p.add_argument('--nr',choices=['baseline','nr2d_only','nr3d_only','nr_off'],default='baseline')
    p.add_argument('--timeout',type=int,default=90)
    p.add_argument('--control-trial',action='store_true',
                   help='180-frame sequential auto/manual exposure and white balance image comparison')
    p.add_argument('--fixed-2a',action='store_true',help='Manual exposure 20000, analog 128, digital 0, ISP 32; unity AWB for NR comparisons')
    p.add_argument('--runtime',choices=['isolated','installed'],default='installed',
                   help='isolated is an unsuccessful ABI diagnostic, not a working replacement SDK')
    p.add_argument('--allow-inconsistent-sdk',action='store_true',
                   help='Explicitly reproduce SDK mismatch failures; never bypass driver version checks')
    args=p.parse_args()
    if not 20<=args.trigger_duty<=1000:p.error('trigger-duty 20..1000 us')
    if not 8<=args.frames<=900 or not 10<=args.timeout<=180:
        p.error('frames 8..900, timeout 10..180')
    if args.control_trial and args.frames!=180:p.error('control-trial requires exactly 180 frames')
    if args.control_trial and args.fixed_2a:p.error('control-trial and fixed-2a are exclusive')
    ROOT.joinpath('results').mkdir(exist_ok=True)
    with ROOT.joinpath('results/.run.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        exp=Experiment('isp_camera',args)
        audit=inspect_environment()
        (exp.out/'environment-audit.json').write_text(json.dumps(audit,indent=2))
        def preflight():
            if not audit['ready_for_attempt']:
                raise RuntimeError('; '.join(audit['blockers']))
            return audit
        ready=exp.case('SDK-and-package-preflight',preflight)['status']=='PASS'
        if not ready and not args.allow_inconsistent_sdk:
            exp.case('physical-ISP-and-hardware-recording',
                     lambda: (_ for _ in ()).throw(Skip('Blocked by environment preflight; no hardware capture attempted')))
            raise SystemExit(exp.finish())
        binary=[];evidence=[]
        runtime=ROOT/'runtime/hobot-multimedia-4.0.5'
        sdk=SDK
        includes=Path('/usr/hobot/include')
        libs=runtime/'usr/hobot/lib' if args.runtime=='isolated' else Path('/usr/hobot/lib')
        env={'LD_LIBRARY_PATH':str(libs)}
        official=sdk/'sample_pipeline/single_pipe_vin_isp_ynr_pym_vpu/single_pipe_vin_isp_ynr_pym_vpu.c'
        def build():
            if not official.is_file():raise RuntimeError('Official pipeline source missing: '+str(official))
            sources=[ROOT/'native/isp_camera_probe.c',*sorted((sdk/'utils').glob('*.c')),
                     *sorted((sdk/'vp_sensors').rglob('*.c'))]
            target=ROOT/'build/isp_camera_probe';target.parent.mkdir(exist_ok=True)
            extra=[];bridge_sources=[]
            if args.runtime=='isolated':
                nsdk=runtime/'app/multimedia_samples'
                sensor=nsdk/'vp_sensors/sc132gs/linear_1088x1280_raw10_30fps_2lane.c'
                bridge=ROOT/'native/sc132gs_camera_bridge.c';obj=ROOT/'build/sc132gs_camera_bridge.o'
                exp.command(['gcc','-O2','-std=gnu11','-pthread','-I'+str(runtime/'usr/hobot/include'),
                  '-I/usr/include/cjson','-I'+str(nsdk/'utils'),'-I'+str(nsdk/'vp_sensors'),
                  '-DPROBE_NEW_SENSOR_SOURCE="'+str(sensor)+'"','-c',bridge,'-o',obj],
                  'build-camera-ABI-bridge',timeout=30)
                extra=['-DCAMERA_ABI_BRIDGE','-I'+str(ROOT/'runtime/vpf-interface-overlay')]
                bridge_sources=[bridge,sensor]
                sources.append(obj)
            exp.command(['gcc','-O2','-std=gnu11','-pthread','-Wno-return-type',
              *extra,'-I'+str(includes),'-I/usr/include/cjson','-I'+str(sdk/'utils'),'-I'+str(sdk/'vp_sensors'),
              '-DPROBE_SOURCE="'+str(official)+'"',*sources,'-L'+str(libs),
              '-L/usr/hobot/lib','-Wl,-rpath,'+str(libs),'-o',target,
              '-lvpf','-lvio','-lcam','-lhbmem','-lmultimedia','-lcjson','-lm'],'build-isp-camera',timeout=90)
            binary.append(target)
            hashes={str(path):digest(path) for path in [*sources,official,*bridge_sources]}
            (exp.out/'source-hashes.json').write_text(json.dumps(hashes,indent=2))
            dependency_text,_=exp.command(['ldd',target],'loaded-libraries',env=env,timeout=10)
            return {'official_pipeline':str(official),'official_sha256':digest(official),
                    'python_sha256':digest(Path(__file__)),
                    'runtime':args.runtime,'dependencies':dependency_text,
                    'scope':'Physical SC132GS; native ISP and hardware H.264; no fallback'}
        def identity():
            bus=args.mipi+1;addr='0x32' if args.mipi==0 else '0x33'
            text,_=exp.command(['i2ctransfer','-y',str(bus),'w2@'+addr,'0x31','0x07','r2'],
                               'sensor-chip-id',timeout=3)
            if text.strip()!='0x01 0x32':
                raise RuntimeError('Full chip ID does not match SC132GS')
            return {'mipi':args.mipi,'i2c_bus':bus,'address':addr,'chip_id':'0x0132'}
        identified=exp.case('physical-sensor-identity',identity)['status']=='PASS'
        built=exp.case('build-official-pipeline',build)['status']=='PASS'
        def capture():
            result=exp.native(binary[0],args.mipi,args.frames,args.nr,args.sensor_mode,args.trigger_duty,int(args.control_trial),int(args.fixed_2a),env=env)
            evidence.extend(result['measurements'])
            done=[r for r in evidence if r.get('event')=='camera_pipeline_result']
            if len(done)!=1 or done[0]['completed_frames']!=args.frames:
                raise RuntimeError('Missing hardware frame completion count')
            if args.fixed_2a:
                telemetry=[r for r in evidence if r.get('event')=='isp_telemetry' and r['index']>=15]
                if not telemetry or any(r['ae_rc'] or r['awb_rc'] or r['ae_mode']!=1 or r['awb_mode']!=1 or
                    r['exposure']!=20000 or r['again']!=128 or r['dgain']!=0 or r['ispgain']!=32 or
                    abs(r['rgain_q8']-256)>=2 or abs(r['bgain_q8']-256)>=2 for r in telemetry):
                    raise RuntimeError('Fixed exposure/gain/white balance readback failed')
            return result
        captured=identified and built and exp.case('physical-ISP-and-hardware-recording',capture)['status']=='PASS'
        if captured:
            cfg=next(x for x in evidence if x.get('event')=='pipeline_configuration')
            w,h=cfg['width'],cfg['height']
            def images():
                measurements=[];last=[]
                for path in sorted(exp.out.glob('frame-*.nv12')):
                    data=np.fromfile(path,np.uint8)
                    if data.size!=w*h*3//2:raise RuntimeError('Incorrect NV12 capture length')
                    y=data[:w*h].reshape(h,w)
                    bgr=cv2.cvtColor(data.reshape(h*3//2,w),cv2.COLOR_YUV2BGR_NV12)
                    png=path.with_suffix('.png')
                    if not cv2.imwrite(str(png),bgr):raise RuntimeError('PNG write failed')
                    measurements.append({'frame':path.name,'sha256':digest(path),'png':png.name,
                      'luma_mean':float(y.mean()),'luma_std':float(y.std()),
                      'luma_p01':float(np.percentile(y,1)),'luma_p99':float(np.percentile(y,99)),
                      'fraction_y_le_16':float((y<=16).mean()),'fraction_y_ge_235':float((y>=235).mean())})
                    last.append(y.astype(np.float32));last=last[-8:]
                if not measurements:raise RuntimeError('No frame captures')
                diff=np.diff(np.stack(last),axis=0)
                return {'captures':measurements,'temporal_difference_rms_last8':float(np.sqrt((diff**2).mean())),
                        'scope':'Temporal difference includes scene movement, lighting, AE/AWB changes and noise; not a calibrated noise measurement'}
            exp.case('NV12-layout-and-color-preview',images)
            if args.control_trial:
                def control_effects():
                    samples={}
                    for index in (15,45,75,105,135,165):
                        data=np.fromfile(exp.out/f'frame-{index:04d}.nv12',np.uint8)
                        rgb=cv2.cvtColor(data.reshape(h*3//2,w),cv2.COLOR_YUV2RGB_NV12)
                        samples[index]={'luma_mean':float(data[:w*h].mean()),
                            'rgb_mean':rgb.mean(axis=(0,1)).tolist()}
                    exposure_delta=samples[75]['luma_mean']-samples[45]['luma_mean']
                    def rb(index):
                        r,g,b=samples[index]['rgb_mean'];return (r+1)/(b+1)
                    wb_ratio=rb(105)/rb(135)
                    result={'samples':samples,'exposure_luma_delta':exposure_delta,
                        'warm_to_cool_rb_ratio':wb_ratio,
                        'scope':'Same camera stream, sequential phases. Darkness, saturation or scene changes can invalidate pixel-effect conclusions.'}
                    (exp.out/'control-effects.json').write_text(json.dumps(result,indent=2))
                    if exposure_delta<3 or wb_ratio<1.2:
                        raise RuntimeError('Image response not confirmed: '+json.dumps(result))
                    return result
                exp.case('manual-AE-and-AWB-pixel-response',control_effects)
            def movie():
                if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
                    raise RuntimeError('ffmpeg/ffprobe missing')
                exp.command(['ffmpeg','-v','error','-r','30','-i',exp.out/'camera.h264',
                             '-c','copy',exp.out/'camera.mp4'],'mp4-remux',timeout=30)
                text,_=exp.command(['ffprobe','-v','error','-count_frames','-select_streams','v:0',
                  '-show_entries','stream=codec_name,width,height,nb_read_frames','-of','json',
                  exp.out/'camera.mp4'],'recording-validation',timeout=30)
                stream=json.loads(text)['streams'][0]
                if (stream['width'],stream['height'])!=(w,h) or int(stream['nb_read_frames'])!=args.frames:
                    raise RuntimeError('Recorded video dimensions or decoded frame count differ')
                exp.command(['ffmpeg','-v','error','-i',exp.out/'camera.mp4','-vf',
                  'select=eq(n\\,0)+eq(n\\,'+str(args.frames//2)+')+eq(n\\,'+str(args.frames-1)+')',
                  '-vsync','0',str(exp.out/'decoded-%02d.png')],'extract-recorded-frames',timeout=30)
                return {'stream':stream,'mp4':str(exp.out/'camera.mp4'),
                        'mp4_sha256':digest(exp.out/'camera.mp4'),
                        'decoded_pngs':[p.name for p in sorted(exp.out.glob('decoded-*.png'))]}
            exp.case('recording-remux-decode-and-extract',movie)
        raise SystemExit(exp.finish())

if __name__=='__main__':main()
