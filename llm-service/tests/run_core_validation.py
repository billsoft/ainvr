"""Bounded board experiment; restore exactly the production units we stopped."""
import json
import os
import signal
import subprocess
import time
from pathlib import Path

ROOT=Path('/home/sunrise/ainvr')
OUT=ROOT/'test/results/llm-service-development'
units=['ainvr-ai.service','ainvr-locateanything-official-bpu.service']
was={u:subprocess.run(['systemctl','is-active',u],capture_output=True,text=True).stdout.strip() for u in units}
report=dict(started=time.time(),was=was,steps=[])
child=None

def stop_signal(signum,frame):
    raise InterruptedError('validation interrupted')

for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(sig,stop_signal)

def run(name,cmd,timeout=600):
    global child
    with open(OUT/(name+'.log'),'w') as log:
        child=subprocess.Popen(cmd,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:rc=child.wait(timeout=timeout)
        except BaseException:
            os.killpg(child.pid,signal.SIGTERM)
            try:child.wait(timeout=20)
            except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
            raise
        finally:child=None
    report['steps'].append(dict(name=name,rc=rc))
    if rc:raise RuntimeError(name+' failed; see log')

try:
    (OUT/'guard-baseline.json').write_text(json.dumps(report,indent=2))
    for u in units:
        if was[u]=='active':subprocess.run(['systemctl','stop',u],check=True,timeout=120)
    run('python-reference',['ai-service/runtime/.venv-locateanything/bin/python',
         'test/model_conversion/qwen3vl/board_run_alarm_v1.py',
         '/mnt/ainvr-ssd/qwen3vl/run-v1/manifest-o2-v3.json',
         '/mnt/ainvr-ssd/llm-eval/service-dev-20/reference-items.jsonl',str(OUT/'python-dev20.jsonl'),'20'])
    run('cpp-reference',['/mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_probe',
         '/mnt/ainvr-ssd/llm-packages/qwen3vl-4b-review-v3','infer',
         '/mnt/ainvr-ssd/llm-eval/service-dev-20/fixtures.jsonl',str(OUT/'cpp-dev20.jsonl')])
    run('numerical-compare',['python3','llm-service/tests/verify_reference.py','logits'],60)
    report['passed']=True
except BaseException as error:
    report['passed']=False;report['error']=str(error)
finally:
    report['restoration']={}
    for u in reversed(units):
        if was[u]=='active':
            try:
                p=subprocess.run(['systemctl','start',u],capture_output=True,text=True,timeout=180)
                report['restoration'][u]=dict(rc=p.returncode)
            except Exception as e:report['restoration'][u]=dict(error=str(e))
    report['now']={u:subprocess.run(['systemctl','is-active',u],capture_output=True,text=True).stdout.strip()
                   for u in units+['ainvr-recorder.service','ainvr-ingest.service']}
    report['finished']=time.time()
    (OUT/'core-validation-guard.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report),flush=True)
if not report.get('passed'):raise SystemExit(1)
