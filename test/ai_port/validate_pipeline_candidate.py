#!/usr/bin/env python3
"""AINVR actual HBM parity and throughput; bounded hardware jobs, automatic restore."""
import copy
import json
import os
from pathlib import Path
import subprocess

ROOT = Path('/home/sunrise/ainvr')
BUILD = ROOT/'out/build/ai-api-compat'
BACKUP = Path('/mnt/ainvr-ssd/migration-backups/inference-throughput-20261013')


def main():
    out = ROOT/'test/results/throughput-pipeline-v2-20261013'
    out.mkdir(exist_ok=False)
    original=json.loads((BACKUP/'channels-before.json').read_text())['channels'][0]
    active=[u for u in ['ainvr-ai','ainvr-recorder'] if subprocess.run(['systemctl','is-active','--quiet',u]).returncode==0]
    env={**os.environ,'LD_LIBRARY_PATH':'/usr/hobot/lib'}
    summary={'passed':False,'restore_units':active,'parity':[],'throughput':[]}
    def run(name,args,timeout=100):
        with (out/(name+'.log')).open('w') as log:
            subprocess.run(args,stdout=log,stderr=log,check=True,timeout=timeout,env=env,cwd=ROOT)
    try:
        if active:
            subprocess.run(['systemctl','stop',*active],check=True,timeout=90)
        run('worker-tests',[str(BUILD/'reused_worker_test')],100)
        for name,adapter in [('yolo26x','yolo26_bpu'),('yolo26x-face','yoloface_bpu'),('yoloe-26x','yoloe_bpu')]:
            cfg=copy.deepcopy(original['config']);cfg['id']='throughput-probe'
            cfg['model'].update(name=name,adapter=adapter,path=f'models/derived/s100p/{name}.hbm')
            if adapter=='yoloe_bpu':cfg['model'].update(description='person',label_id='person',label_name='person')
            cfg['publish']['target_url']='rtmp://127.0.0.1:1935/live/ainvr-throughput-probe'
            cfg['publish'].pop('effective_target_url',None);cfg['snapshot']['enabled']=False
            cfg['inference_fps']=0
            path=out/(name+'.json');path.write_text(json.dumps(cfg))
            report=out/(name+'-parity.json')
            run(name+'-parity',[str(BUILD/'ainvr_bpu_pipeline_probe'),str(path),str(report)])
            summary['parity'].append(json.loads(report.read_text()))
            for fps in ([15,0] if name=='yolo26x' else [0]):
                cfg['inference_fps']=fps;path.write_text(json.dumps(cfg))
                report=out/(name+f'-live-{fps}.json')
                run(name+f'-live-{fps}',[str(BUILD/'ainvr_throughput_probe'),str(path),str(ROOT/'ai-service'),'35',str(report)])
                result=json.loads(report.read_text());warm=result['samples'][7];end=result['samples'][-1]
                summary['throughput'].append({k:result[k] for k in ['measured_fps','decoded_fps','mean_bpu_percent','peak_rss_kib','stop_ms']}
                    | {'model':name,'target_fps':fps,'timing':result['status']['timing'],
                       'warm_sei_late':end['publish']['buffer']['too_late']-warm['publish']['buffer']['too_late'],
                       'warm_sei_injected':end['publish']['sei_injected']-warm['publish']['sei_injected']})
                assert result['status']['consecutive_errors']==0 and result['status']['last_error'] is None
                assert result['status']['publish']['reconnect_count']==0
                (out/'progress.json').write_text(json.dumps(summary,indent=2))
        summary['passed']=True
    finally:
        for unit in active:
            try:
                subprocess.run(['systemctl','start',unit],check=True,timeout=90)
            except (subprocess.SubprocessError, OSError) as exc:
                summary.setdefault('restore_errors', []).append(f'{unit}: {exc}')
        summary['restored']=all(subprocess.run(['systemctl','is-active','--quiet',u]).returncode==0 for u in active)
        (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print(json.dumps(summary),flush=True)


if __name__=='__main__':main()
