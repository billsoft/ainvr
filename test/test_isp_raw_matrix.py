#!/usr/bin/env python3
"""Require valid synthetic ISP baseline before running module experiments."""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parent

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime',choices=['installed','isolated'],default='installed')
    p.add_argument('--path',choices=['direct','direct_algorithms','dummy'],default='dummy')
    p.add_argument('--packing',choices=['unpacked16','mipi_raw10','bitstream_lsb10','bitstream_msb10'],default='bitstream_lsb10')
    p.add_argument('--calibration',choices=['disable','sc132gs'],default='sc132gs')
    p.add_argument('--frames',type=int,default=30)
    p.add_argument('--timeout',type=int,default=20)
    args=p.parse_args()
    if not 2<=args.frames<=60 or not 10<=args.timeout<=120:p.error('frames 2..60, timeout 10..120')
    out=ROOT/'results'/f"{dt.datetime.now():%Y%m%d-%H%M%S-%f}-isp-raw-matrix"
    out.mkdir(parents=True,exist_ok=False)
    jobs=[('baseline-gradient',['--scenario','gradient']),
          ('baseline-color-bars',['--scenario','color_bars']),
          ('baseline-black',['--scenario','black','--black-offset','0'])]
    scenarios={'raw_frontend':'black','defect_pixel':'defect_pixels','sinter':'noise',
               'white_balance':'color_bars','radial_shading':'shading','mesh_shading':'shading',
               'iridix':'gradient','demosaic':'color_bars','cnr':'noise'}
    for module,scenario in scenarios.items():
        input_args=['--scenario',scenario]
        if scenario=='black':input_args+=['--black-offset','0']
        jobs.append((module+'-reference',input_args))
        jobs.append((module+'-bypass',input_args+['--bypass',module]))
    jobs.append(('AWB-manual-readback',['--scenario','color_bars','--awb-red','512','--awb-blue','128']))
    rows=[];halt=False
    for name,extra in jobs:
        row={'name':name,'status':'SKIP'}
        if halt:row['reason']='Earlier baseline or control failed; not executed'
        else:
            before=set(ROOT.glob('results/*-isp_raw_lab/result.json'))
            command=[sys.executable,str(ROOT/'test_isp_raw_lab.py'),'--runtime',args.runtime,
                     '--path',args.path,'--packing',args.packing,'--calibration',args.calibration,
                     '--freeze-algorithms','--frames',str(args.frames),'--timeout',str(args.timeout),*extra]
            # The child enforces per-command timeouts and owns hardware cleanup.
            with (out/(name+'.log')).open('w') as f:
                proc=subprocess.run(command,cwd=ROOT,stdout=f,stderr=subprocess.STDOUT)
            paths=set(ROOT.glob('results/*-isp_raw_lab/result.json'))-before
            if len(paths)!=1:
                row.update(status='FAIL',reason='Missing or ambiguous child result');halt=True
            else:
                path=paths.pop();r=json.loads(path.read_text())
                row.update(status=r['status'],result=str(path),returncode=proc.returncode)
                halt=r['status']!='PASS' or proc.returncode!=0
        rows.append(row)
        report={'status':'FAIL' if halt else 'PASS','trials':rows,
            'scope':'PASS covers frame/layout/selected pixel checks and parameter readback only. Module image effect, black-level coefficient correctness, AE closed-loop and temporal YNR need separate acceptance.'}
        (out/'matrix.json').write_text(json.dumps(report,indent=2))
        print(f"[{row['status']}] {name}",flush=True)
    print('RESULT',out/'matrix.json')
    raise SystemExit(1 if halt else 0)

if __name__=='__main__':main()
