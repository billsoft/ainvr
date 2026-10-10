#!/usr/bin/env python3
"""Synthetic Bayer RAW -> physical ISP; standalone and official dummy diagnostics."""
import argparse
import fcntl
import json
from pathlib import Path
import numpy as np
import cv2
from common import Experiment, ROOT, SDK, digest
from inspect_isp_environment import inspect_environment

BYPASS={'none':-1,'raw_frontend':5,'defect_pixel':6,'sinter':12,
        'white_balance':15,'radial_shading':16,'mesh_shading':17,
        'iridix':18,'demosaic':19,'cnr':26}
BAYER={'RGGB':0,'GRBG':1,'GBRG':2,'BGGR':3}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime',choices=['installed','isolated'],default='installed')
    p.add_argument('--isp-test-pattern',action='store_true',
                   help='Diagnostic ISP internal pattern; bypasses input-image semantics, not a RAW validation pass')
    p.add_argument('--path',choices=['direct','direct_algorithms','dummy'],default='dummy')
    p.add_argument('--packing',choices=['unpacked16','mipi_raw10','bitstream_lsb10','bitstream_msb10'],default='bitstream_lsb10')
    p.add_argument('--freeze-algorithms',action='store_true',help='Manual AE and unity AWB for repeatable synthetic comparisons')
    p.add_argument('--sinter-target',type=int,help='Firmware spatial RAW denoise target, validated against SDK range')
    p.add_argument('--byte-order',choices=['little','big'],default='little')
    p.add_argument('--storage-shift',type=int,choices=[0,2,4,6],default=0,
                   help='Explicit 16-bit RAW alignment diagnostic; not applied to packed MIPI RAW10')
    p.add_argument('--calibration',choices=['disable','sc132gs'],default='sc132gs',
                   help='Official SC132GS tuning library, for dummy path only')
    p.add_argument('--scenario',choices=['gradient','black','color_bars','noise','defect_pixels','shading'],default='gradient')
    p.add_argument('--bayer',choices=BAYER,default='BGGR')
    p.add_argument('--bypass',choices=BYPASS,default='none')
    p.add_argument('--awb-red',type=int,default=0,help='Q4.8; requires --awb-blue; 256 = 1x')
    p.add_argument('--awb-blue',type=int,default=0)
    p.add_argument('--black-offset',type=int,default=64,help='Input RAW offset only; does not set ISP black level')
    p.add_argument('--frames',type=int,default=8)
    p.add_argument('--frame-period-ms',type=int,default=33,
                   help='Allow asynchronous ISP firmware/algorithms time to update; 0 disables pacing')
    p.add_argument('--width',type=int,default=512)
    p.add_argument('--height',type=int,default=512)
    p.add_argument('--timeout',type=int,default=20)
    args=p.parse_args()
    if args.sinter_target is not None and not 0<=args.sinter_target<=255:p.error('sinter-target 0..255')
    if not 0<=args.frame_period_ms<=100:p.error('frame-period-ms 0..100')
    if args.calibration!='disable' and args.path!='dummy':
        p.error('Calibration requires dummy camera metadata setup')
    if args.storage_shift and args.packing!='unpacked16':
        p.error('Storage shift only applies to unpacked 16-bit storage')
    if args.byte_order!='little' and args.packing!='unpacked16':p.error('byte-order only applies to unpacked16')
    if not 1<=args.frames<=60 or not 10<=args.timeout<=120:
        p.error('frames 1..60, timeout 10..120')
    if args.width%32 or args.height%8 or not 256<=args.width<=4096 or not 128<=args.height<=2160:
        p.error('width multiple of 32, 256..4096; height multiple of 8, 128..2160')
    if not 0<=args.black_offset<=1023 or not 0<=args.awb_red<=1023 or not 0<=args.awb_blue<=1023 or bool(args.awb_red)!=bool(args.awb_blue):
        p.error('10-bit input offset and Q4.8 AWB gain values must be 0..1023; AWB pair required')
    (ROOT/'results').mkdir(exist_ok=True)
    with (ROOT/'results/.run.lock').open('w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise SystemExit('Another hardware experiment is running')
        exp=Experiment('isp_raw_lab',args)
        (exp.out/'environment-audit.json').write_text(json.dumps(inspect_environment(),indent=2))
        runtime=ROOT/'runtime/hobot-multimedia-4.0.5'
        sdk=runtime/'app/multimedia_samples' if args.runtime=='isolated' else SDK
        includes=runtime/'usr/hobot/include' if args.runtime=='isolated' else Path('/usr/hobot/include')
        libs=runtime/'usr/hobot/lib' if args.runtime=='isolated' else Path('/usr/hobot/lib')
        env={'LD_LIBRARY_PATH':str(libs)}
        if args.isp_test_pattern:env['RAW_ISP_TEST_PATTERN']='1'
        if args.freeze_algorithms:env['RAW_ISP_FREEZE_ALGORITHMS']='1'
        if args.sinter_target is not None:env['RAW_ISP_SINTER_TARGET']=str(args.sinter_target)
        official=sdk/'sample_isp/isp_feedback/isp_feedback.c'
        target=ROOT/'build/isp_raw_lab'
        def fixture():
            w,h=args.width,args.height;y,x=np.mgrid[:h,:w]
            values=np.linspace(args.black_offset,1000,w,dtype=np.float32)[None,:].repeat(h,axis=0)
            if args.scenario=='black':values.fill(args.black_offset)
            elif args.scenario=='noise':
                values=np.clip(256+np.random.default_rng(132).normal(0,24,(h,w)),0,1023)
            elif args.scenario=='shading':
                values=800*np.clip(1-0.65*((x-w/2)**2/(w/2)**2+(y-h/2)**2/(h/2)**2),0.1,1)
            elif args.scenario=='defect_pixels':
                values.fill(256);values[::31,::29]=1023;values[15::31,14::29]=0
            elif args.scenario=='color_bars':
                colors=np.array([[900,64,64],[64,900,64],[64,64,900],[900,900,900],
                                 [900,900,64],[64,900,900],[900,64,900],[256,256,256]])
                # Channel index at each Bayer site: R=0, G=1, B=2.
                patterns={'RGGB':[[0,1],[1,2]],'GRBG':[[1,0],[2,1]],
                          'GBRG':[[1,2],[0,1]],'BGGR':[[2,1],[1,0]]}
                channel=np.array(patterns[args.bayer])[y%2,x%2]
                values=colors[np.minimum(x*8//w,7),channel]
            raw=np.rint(values).clip(0,1023).astype('<u2')
            path=exp.out/'input.raw'
            if args.packing=='mipi_raw10':
                groups=raw.reshape(h,w//4,4)
                encoded=np.empty((h,w//4,5),dtype=np.uint8)
                encoded[:,:,:4]=groups>>2
                encoded[:,:,4]=sum((groups[:,:,k]&3)<<(2*k) for k in range(4))
                encoded.tofile(path)
            elif args.packing in ('bitstream_lsb10','bitstream_msb10'):
                groups=raw.reshape(h,w//4,4).astype(np.uint64)
                little=args.packing=='bitstream_lsb10'
                word=sum(groups[:,:,k]<<(10*(k if little else 3-k)) for k in range(4))
                encoded=np.stack([(word>>(8*(k if little else 4-k)))&255 for k in range(5)],axis=-1).astype(np.uint8)
                decoded_word=sum(encoded[:,:,k].astype(np.uint64)<<(8*(k if little else 4-k)) for k in range(5))
                decoded=np.stack([(decoded_word>>(10*(k if little else 3-k)))&1023 for k in range(4)],axis=-1)
                if not np.array_equal(decoded.reshape(h,w),raw):raise RuntimeError('RAW bitstream fixture round-trip mismatch')
                encoded.tofile(path)
            else:(raw<<args.storage_shift).astype('<u2' if args.byte_order=='little' else '>u2').tofile(path)
            return {'path':str(path),'sha256':digest(path),'bytes':path.stat().st_size,
                'RAW10_storage':args.packing,
                'storage_shift':args.storage_shift,'byte_order':args.byte_order,'calibration':args.calibration,
                'bayer':args.bayer,'scope':'Known synthetic fixture; single frame repeats. Noise fixture does not test temporal denoising or sensor exposure feedback.'}
        prepared=exp.case('synthetic-Bayer-fixture',fixture)['status']=='PASS'
        def build():
            target.parent.mkdir(exist_ok=True)
            sources=[ROOT/'native/isp_raw_lab.c',*sorted((sdk/'utils').glob('*.c')),
                     *sorted((sdk/'vp_sensors').rglob('*.c'))]
            exp.command(['gcc','-O2','-std=gnu11','-pthread','-Wno-return-type',
                '-I'+str(includes),'-I/usr/include/cjson','-I'+str(sdk/'utils'),'-I'+str(sdk/'vp_sensors'),
                '-DPROBE_SOURCE="'+str(official)+'"',*sources,'-L'+str(libs),
                '-Wl,-rpath,'+str(libs),'-o',target,'-lvpf','-lvio','-lcam','-lhbmem','-lcjson','-lm'],
                'build-RAW-ISP-lab',timeout=90)
            (exp.out/'source-hashes.json').write_text(json.dumps({str(s):digest(s) for s in [*sources,official]},indent=2))
            exp.command(['ldd',target],'loaded-libraries',env=env,timeout=10)
            return {'official_source':str(official),'runtime':args.runtime,'path':args.path}
        built=exp.case('native-ISP-lab-build',build)['status']=='PASS'
        if prepared and built:
            def hardware():
                result=exp.native(target,exp.out/'input.raw',args.width,args.height,args.frames,
                    args.path,BAYER[args.bayer],BYPASS[args.bypass],args.awb_red,args.awb_blue,args.packing,
                    'lib_sc132gs_linear.so' if args.calibration=='sc132gs' else 'disable',args.frame_period_ms,env=env)
                done=[r for r in result['measurements'] if r.get('event')=='RAW_ISP_completed']
                if len(done)!=1 or done[0]['completed_frames']!=args.frames:raise RuntimeError('No completed RAW -> physical ISP evidence')
                return result
            captured=exp.case('RAW-to-physical-ISP-YUV',hardware)['status']=='PASS'
            if captured:
                def validate():
                    rows=[]
                    for path in sorted(exp.out.glob('output-*.nv12')):
                        data=np.fromfile(path,np.uint8);w,h=args.width,args.height
                        if data.size!=w*h*3//2:raise RuntimeError('NV12 length mismatch')
                        image=cv2.cvtColor(data.reshape(h*3//2,w),cv2.COLOR_YUV2BGR_NV12)
                        if not cv2.imwrite(str(path.with_suffix('.png')),image):raise RuntimeError('PNG write failed')
                        rows.append({'path':str(path),'sha256':digest(path),
                                     'luma_mean':float(data[:w*h].mean()),'luma_std':float(data[:w*h].std())})
                    if not rows:raise RuntimeError('No output capture')
                    return {'images':rows,'scope':'Output and layout validation only; compare baseline/control images before claiming an ISP module effect'}
                exp.case('NV12-output-validation',validate)
                if args.scenario in ['gradient','black','color_bars'] and args.bypass=='none' and not args.isp_test_pattern:
                    def semantics():
                        path=sorted(exp.out.glob('output-*.nv12'))[-1]
                        data=np.fromfile(path,np.uint8);w,h=args.width,args.height
                        y=data[:w*h].reshape(h,w).astype(np.float64)
                        detail={'scope':'Basic synthetic image semantics; failure may indicate missing context, CFA phase, format or tuning initialization'}
                        if args.scenario=='gradient':
                            profile=y[h//8:-h//8].mean(axis=0)
                            correlation=float(np.corrcoef(np.arange(w),profile)[0,1])
                            spread=float(profile[-w//8:].mean()-profile[:w//8].mean())
                            # Gamma, tone mapping and saturation make a correct ISP
                            # response nonlinear. Require a rising coarse profile,
                            # rather than requiring an approximately linear curve.
                            bins=profile.reshape(16,w//16).mean(axis=1)
                            backward=float(np.maximum(-np.diff(bins),0).max())
                            increases=int((np.diff(bins)>2).sum())
                            detail.update(luma_ramp_correlation=correlation,dark_to_light_span=spread,
                                coarse_luma_profile=bins.tolist(),max_backward_jump=backward,
                                increasing_intervals=increases,
                                criterion='Correlation >=0.7, span >=40, coarse backward jumps <=4, >=3 increases over 2; allows nonlinear gamma/tone curves')
                            (exp.out/'pixel-semantics.json').write_text(json.dumps(detail,indent=2))
                            if not np.isfinite(correlation) or correlation<0.7 or spread<40 or backward>4 or increases<3:
                                raise RuntimeError('Output does not reproduce known dark-to-light RAW ramp: '+json.dumps(detail))
                        elif args.scenario=='black':
                            detail['luma_std']=float(y.std())
                            (exp.out/'pixel-semantics.json').write_text(json.dumps(detail,indent=2))
                            if detail['luma_std']>3:raise RuntimeError('Constant RAW gives nonuniform image: '+json.dumps(detail))
                        else:
                            rgb=cv2.cvtColor(data.reshape(h*3//2,w),cv2.COLOR_YUV2RGB_NV12)
                            means=np.array([rgb[h//8:-h//8,i*w//8+w//64:(i+1)*w//8-w//64].mean(axis=(0,1)) for i in range(8)])
                            detail['RGB_bar_means']=means.tolist()
                            dominance=[float(means[i,i]-max(np.delete(means[i],i))) for i in range(3)]
                            detail['primary_channel_dominance']=dominance
                            (exp.out/'pixel-semantics.json').write_text(json.dumps(detail,indent=2))
                            if min(dominance)<20:raise RuntimeError('Known RGB bars not reproduced: '+json.dumps(detail))
                        return detail
                    exp.case('synthetic-image-pixel-semantics',semantics)
        raise SystemExit(exp.finish())

if __name__=='__main__':main()
