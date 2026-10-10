#!/usr/bin/env python3
"""Physical SC132GS -> VIN RAW snapshot, without ISP or software substitution."""
import argparse
import fcntl
import json
from pathlib import Path
import numpy as np
import cv2
from common import Experiment, ROOT, SDK, digest
from inspect_isp_environment import inspect_environment

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mipi',type=int,choices=[0,1],default=0)
    parser.add_argument('--pack-mode',type=int,choices=[0,1],default=0)
    parser.add_argument('--timeout',type=int,default=30)
    args=parser.parse_args()
    if not 10<=args.timeout<=60:parser.error('timeout 10..60')
    (ROOT/'results').mkdir(exist_ok=True)
    with (ROOT/'results/.run.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        exp=Experiment('isp_sensor_raw',args)
        def preflight():
            audit=inspect_environment()
            if not audit['ready_for_attempt']:raise RuntimeError(str(audit['blockers']))
            return audit
        ready=exp.case('environment',preflight)['status']=='PASS'
        official=SDK/'sample_vin/get_vin_data/get_vin_data.c'
        target=ROOT/'build/isp_sensor_raw_probe'
        def capture():
            sources=[ROOT/'native/isp_sensor_raw_probe.c',*sorted((SDK/'utils').glob('*.c')),
                     *sorted((SDK/'vp_sensors').rglob('*.c'))]
            target.parent.mkdir(exist_ok=True)
            exp.command(['gcc','-O2','-std=gnu11','-pthread','-Wno-return-type',
                '-I/usr/hobot/include','-I/usr/include/cjson','-I'+str(SDK/'utils'),'-I'+str(SDK/'vp_sensors'),
                '-DPROBE_SOURCE="'+str(official)+'"',*sources,'-L/usr/hobot/lib','-o',target,
                '-lvpf','-lvio','-lcam','-lhbmem','-lcjson','-lm'],'build-sensor-RAW',timeout=90)
            (exp.out/'source-hashes.json').write_text(json.dumps({str(p):digest(p) for p in [*sources,official]},indent=2))
            result=exp.native(target,args.mipi,args.pack_mode)
            events=[m for m in result['measurements'] if m.get('event')=='sensor_RAW_capture']
            if len(events)!=2:raise RuntimeError('Missing two physical RAW captures')
            for index,event in enumerate(events):
                path=exp.out/f'sensor-{index:04d}.raw'
                if path.stat().st_size!=event['file_rowbytes']*event['height']:raise RuntimeError('RAW size mismatch')
            return result
        if ready and exp.case('physical-sensor-VIN-RAW',capture)['status']=='PASS':
            def analyze():
                path=exp.out/'sensor-0001.raw';rows=[]
                if args.pack_mode==0:
                    for byte_order in ('<','>'):
                        raw=np.fromfile(path,dtype=byte_order+'u2')
                        for shift in (0,2,4,6):
                            values=raw>>shift
                            rows.append({'byte_order':byte_order,'storage_shift':shift,
                                'fraction_in_10bit_range':float((values<=1023).mean()),
                                'fraction_unused_low_bits_zero':float(((raw&((1<<shift)-1))==0).mean()),
                                'p01':float(np.percentile(values,1)),'p99':float(np.percentile(values,99)),
                                'mean':float(values.mean()),'std':float(values.std())})
                    # Explicit diagnostic interpretation, not proof of CFA or calibration.
                    values=np.fromfile(path,dtype='<u2').reshape(1280,1088)
                    preview=np.clip(values.astype(np.float32)*255/1023,0,255).astype(np.uint8)
                    if not cv2.imwrite(str(exp.out/'RAW-little-endian-shift0-diagnostic.png'),preview):raise RuntimeError('Preview write failed')
                result={'RAW_sha256':digest(path),'candidate_interpretations':rows,
                    'scope':'VIN RAW payload and layout only. Grayscale preview explicitly assumes LE shift0. No ISP, demosaic, black-level or exposure correctness claim.'}
                (exp.out/'raw-analysis.json').write_text(json.dumps(result,indent=2))
                return result
            exp.case('RAW-layout-and-candidate-interpretations',analyze)
        return exp.finish()

if __name__=='__main__':raise SystemExit(main())
