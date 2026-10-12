"""AINVR install an exact-output optimized HBM with SSD backup and rollback."""
import argparse, hashlib, json, os, shutil, subprocess, time, urllib.request
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--model',type=Path,required=True)
p.add_argument('--candidate',type=Path,required=True)
p.add_argument('--comparison',type=Path,required=True)
p.add_argument('--compile-status',type=Path,required=True)
p.add_argument('--backup',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--config',type=Path,required=True)
p.add_argument('--channel',required=True)
a=p.parse_args();assert not a.output.exists() and not a.backup.exists()
sha=lambda x:hashlib.sha256(x.read_bytes()).hexdigest()
comparison=json.loads(a.comparison.read_text());compile_status=json.loads(a.compile_status.read_text())
assert comparison['passed'] and comparison['accuracy_verified'] and comparison['all_outputs_exact']
assert comparison['candidate_fps']>5 and comparison['speedup']>1
assert compile_status['state']=='compiled_needs_validation' and compile_status['opt']==2
assert compile_status['hbm_sha256']==comparison['candidate_sha256']==sha(a.candidate)
assert comparison['baseline_sha256']==sha(a.model)
sidecar=Path(str(a.model)+'.ainvr.json');old=sidecar.read_bytes()
contract=json.loads(old);assert contract['production_approved'] and contract['accuracy_verified']
assert contract['hbm_sha256']==comparison['baseline_sha256']
probe=Path('/home/sunrise/ainvr/out/build/ai-s100p/ainvr_bpu_probe')
description=subprocess.check_output([str(probe),str(a.candidate)],text=True,timeout=60)
lines=description.splitlines();start=next(i for i,x in enumerate(lines) if x.strip()=='{')
actual=json.JSONDecoder().raw_decode('\n'.join(lines[start:]))[0]
for field in ['inputs','outputs']:
    assert len(actual[field])==len(contract[field])
    for x,y in zip(actual[field],contract[field]):
        assert all(x[k]==y[k] for k in ['name','shape','dtype_id','quantization']), (field,x,y)
a.backup.mkdir(parents=True)
shutil.copy2(a.model,a.backup/a.model.name);(a.backup/sidecar.name).write_bytes(old)
key=json.loads(a.config.read_text())['server']['api_key']
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
route='/api/v1/channels/'+a.channel
def api(path,method='GET'):
    req=urllib.request.Request('http://127.0.0.1:8000'+path,headers={'x-api-key':key},method=method)
    with opener.open(req,timeout=20) as r:return json.load(r)
before=api(route);was_running=before['state']=='running'
live_path=before['config']['model']['path']
live_uses_installed=(Path('/home/sunrise/ainvr/ai-service')/live_path).resolve()==a.model.resolve()
report={'model_path':str(a.model.resolve()),'backup':str(a.backup.resolve()),
        'comparison':comparison,'shared_bc_sha256':compile_status['bc_sha256'],
        'production_deployed':False,'source_and_recorder_changed':False,
        'live_channel_model_path':live_path,'live_channel_uses_installed_model':live_uses_installed}
def replace(source,destination):
    tmp=destination.with_name(destination.name+'.optimization-tmp')
    assert not tmp.exists();shutil.copy2(source,tmp);tmp.chmod(0o644);os.replace(tmp,destination)
try:
    if was_running:api(route+'/stop','POST')
    assert sha(a.model)==comparison['baseline_sha256'] and sidecar.read_bytes()==old
    contract['hbm_sha256']=comparison['candidate_sha256']
    contract['inputs']=actual['inputs'];contract['outputs']=actual['outputs']
    contract.setdefault('validation',{})['compiler_optimization']='O2'
    contract['validation']['sequential_bpu_fps']=comparison['candidate_fps']
    contract['validation']['optimization_equivalence']={
        'all_outputs_exact':True,'samples':128,'shared_bc_sha256':compile_status['bc_sha256'],
        'baseline_sha256':comparison['baseline_sha256'],'speedup':comparison['speedup']}
    staged=a.backup/'optimized.hbm.ainvr.json';staged.write_text(json.dumps(contract,indent=2)+'\n')
    replace(a.candidate,a.model);replace(staged,sidecar)
    if was_running:
        api(route+'/start','POST');start=api(route);time.sleep(15);after=api(route)
        assert after['state']=='running' and after['stats']['consecutive_errors']==0
        assert after['stats']['inference_count']>start['stats']['inference_count']
        assert after['stats']['publish']['running']
        assert after['stats']['publish']['sei_injected']>start['stats']['publish']['sei_injected']
        report['live_stats']=after['stats']
    report['production_deployed']=True
except Exception:
    api(route+'/stop','POST')
    replace(a.backup/a.model.name,a.model);replace(a.backup/sidecar.name,sidecar)
    if was_running:api(route+'/start','POST')
    report['rolled_back']=True
    raise
finally:
    report['channel_state_after']=api(route)['state'];a.output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['model_path','production_deployed','channel_state_after']}))
