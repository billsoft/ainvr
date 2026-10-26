"""Isolated protocol tests: never load a model, never pause production."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

root=Path(__file__).resolve().parents[2]
result=root/'test/results/llm-service-development'
def main():
    key,admin=secrets.token_hex(32),secrets.token_hex(32)
    with tempfile.TemporaryDirectory(prefix='ainvr-llm-test-') as tmp:
        config=Path(tmp)/'config.json'
        config.write_text(json.dumps(dict(inference_key=key,admin_key=admin,
             package_root='/home/sunrise/ainvr/ai-service/models/llm/qwen3vl-4b-review-v3')))
        config.chmod(0o600)
        with open(result/'http-control.log','w') as log:
            process=subprocess.Popen(['/mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_service',str(config)],stdout=log,stderr=subprocess.STDOUT)
            def call(path,body=None,token=None):
                req=urllib.request.Request('http://127.0.0.1:8300'+path,
                     data=None if body is None else json.dumps(body).encode(),
                     headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if token else {})})
                try:
                    with urllib.request.urlopen(req,timeout=5) as r:return r.status,json.load(r)
                except urllib.error.HTTPError as e:return e.code,json.load(e)
            try:
                for _ in range(30):
                    if process.poll() is not None:raise RuntimeError('test server exited; port may already be in use')
                    try:
                        status,health=call('/health');break
                    except OSError:time.sleep(.1)
                assert status==200 and health['model']=='unloaded'
                assert call('/v1/models')[0]==401
                assert call('/v1/status',token=key)[0]==401
                assert call('/v1/status',token=admin)[0]==200
                status,models=call('/v1/models',token=key)
                assert status==200 and models['object']=='list' and len(models['data'])==1
                status,error=call('/v1/chat/completions',{'model':'qwen3vl-4b-review-v3','messages':[{'role':'user','content':'hello'}]},key)
                assert status==400 and error['error']['code']=='capability_not_available'
                assert call('/v1/admin/load',{},key)[0]==401
                assert call('/v1/ainvr/tasks/alarm-review-zh-v1',{'image':{'jpeg_base64':'bad'}},key)[0]==400
                report=dict(passed=8,model_loaded=False,production_paused=False)
                (result/'http-control.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
            finally:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()

if __name__=='__main__':main()
