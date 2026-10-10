#!/usr/bin/env python3
"""Known RAW spatial noise -> physical ISP Sinter strength sweep."""
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys
import numpy as np
import cv2
from common import ROOT, digest

def main():
    out=ROOT/'results'/f'{dt.datetime.now():%Y%m%d-%H%M%S-%f}-isp-sinter-sweep'
    out.mkdir(parents=True,exist_ok=False);rows=[]
    for target in (0,64,128,255):
        before=set(ROOT.glob('results/*-isp_raw_lab/result.json'))
        with (out/f'target-{target}.log').open('w') as log:
            proc=subprocess.run([sys.executable,str(ROOT/'test_isp_raw_lab.py'),'--scenario','noise',
                '--freeze-algorithms','--frames','30','--sinter-target',str(target)],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
        paths=set(ROOT.glob('results/*-isp_raw_lab/result.json'))-before
        row={'target':target,'status':'FAIL','returncode':proc.returncode}
        if len(paths)==1:
            path=paths.pop();result=json.loads(path.read_text());row.update(status=result['status'],result=str(path))
            if row['status']=='PASS':
                w=result['parameters']['width'];h=result['parameters']['height']
                data=np.fromfile(sorted(path.parent.glob('output-*.nv12'))[-1],np.uint8)[:w*h].reshape(h,w).astype(np.float32)
                center=data[h//4:3*h//4,w//4:3*w//4];residual=center-cv2.GaussianBlur(center,(9,9),0)
                row.update(input_sha256=digest(path.parent/'input.raw'),central_mean=float(center.mean()),
                           central_highpass_rms=float(np.sqrt((residual**2).mean())))
        rows.append(row);print(row,flush=True)
        report={'trials':rows,'scope':'Single fixed RAW noise fixture, manual AE/unity AWB; spatial Sinter only, not temporal YNR.'}
        if len(rows)==4 and all(r['status']=='PASS' for r in rows):
            same=len({r['input_sha256'] for r in rows})==1
            ratio=rows[-1]['central_highpass_rms']/max(rows[0]['central_highpass_rms'],1e-6)
            report.update(same_input=same,highpass_ratio_target255_vs0=ratio,
                          pixel_response='NOISE_REDUCTION_CONFIRMED' if same and ratio<0.95 else 'NO_SUFFICIENT_REDUCTION_OBSERVED',
                          status='PASS' if same and ratio<0.95 else 'UNVERIFIED')
        (out/'sweep.json').write_text(json.dumps(report,indent=2))
        if row['status']!='PASS':break
    print('RESULT',out/'sweep.json')
    return 0 if report.get('status')=='PASS' else 1

if __name__=='__main__':raise SystemExit(main())
