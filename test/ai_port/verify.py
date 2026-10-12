#!/usr/bin/env python3
"""Validate AINVR AI core, Mali DRM/GBM GLES and actual HBM execution."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
ROOT=Path(__file__).resolve().parents[2]
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model',type=Path,required=True,help='HBM; zero input only checks execution')
    parser.add_argument('--output',type=Path,default=ROOT/'test/results/ai-port-20261011')
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    report={'scope':'portable core, GLES pixels, HBM execution; no user-model accuracy claim','checks':{}}
    env=os.environ.copy();env['LD_LIBRARY_PATH']='/usr/hobot/lib';env.pop('HW_WAYLAND_SOCKET',None)
    def run(name,command,timeout=120):
        p=subprocess.run(command,cwd=ROOT,env=env,capture_output=True,text=True,timeout=timeout)
        (args.output/(name+'.log')).write_text(p.stdout+p.stderr,encoding='utf-8')
        report['checks'][name]={'returncode':p.returncode}
        if p.returncode:raise RuntimeError(name+' failed; see log')
        return p.stdout
    try:
        output=run('ctest',['ctest','--test-dir','out/build/ai-s100p','-V','--output-on-failure'])
        report['native_test_cases_passed']=sum(int(n) for n in re.findall(r'\[  PASSED  \]\s+(\d+) tests?',output))
        report['gpu']='Mali hardware required; DRM/GBM offscreen, no desktop dependency'
        run('tensor_layout',['python3','test/ai_port/test_tensor_layout.py'])
        output=run('bpu',['out/build/ai-s100p/ainvr_bpu_probe',str(args.model.resolve()),'10'],timeout=60)
        start=output.find('{\n')
        if start<0:raise RuntimeError('Missing BPU report')
        data=json.loads(output[start:])
        (args.output/'bpu-report.json').write_text(json.dumps(data,indent=2),encoding='utf-8')
        report['bpu']={k:data[k] for k in ('soc','dnn_version','ucp_version','iterations','elapsed_ms','output_elements')}
        report['status']='passed'
    except Exception as exc:
        report['status']='failed';report['error']=str(exc)
    finally:
        (args.output/'summary.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))
    return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
