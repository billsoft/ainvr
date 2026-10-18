"""Pure two-stage drop-in rewrite controls from the actual current-v8 file.

Intermediate v9 and candidate v10 identities use explicit synthetic hashes.
No production files, processes, model contexts or configuration are changed.
"""
from pathlib import Path
import hashlib,importlib.util,json,time
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'

def load(name,pin):
 p=CODE/name;assert hashlib.sha256(p.read_bytes()).hexdigest()==pin
 spec=importlib.util.spec_from_file_location(name[:-3],p);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

prefix=load('install_locateanything_prefill_three_groups_runtime_v217.py','af864d27a25ef7de7895b4f5f4a97c9761c40e01abdb61ea5b635d951dda9227')
candidate=load('install_locateanything_prefill_all_runtime_v251.py','ef24a2d5f795a42bdd88ea01034d5f274daabc286c78e7c26b092b02a1e7b506')
original=prefix.DROP.read_bytes();side=prefix.read(prefix.SIDECAR)
assert side['generation']['contract_sha256']==prefix.OLD_SHA
prefix.CONTRACT_SHA='e'*64
middle=prefix.rewrite_dropin(original,side['installation']['production_contract'],str(prefix.CONTRACT))
candidate.OLD_SHA='e'*64;candidate.CONTRACT_SHA='f'*64
assert prefix.NEW==candidate.OLD
rewritten=candidate.rewrite_dropin(middle,str(prefix.CONTRACT),str(candidate.CONTRACT))
assert middle==rewritten.replace(str(candidate.NEW).encode(),str(candidate.OLD).encode()).replace(candidate.CONTRACT_SHA.encode(),candidate.OLD_SHA.encode()).replace(str(candidate.CONTRACT).encode(),str(prefix.CONTRACT).encode())
assert rewritten.count(b'ExecStartPost=')==original.count(b'ExecStartPost=')==2
mutations=[('missing_post_hash',middle.replace(candidate.OLD_SHA.encode(),b'0'*64,1)),('missing_post_reset',middle.replace(b'ExecStartPost=\n',b'')),('duplicate_actual_post',middle+next(x for x in middle.splitlines(keepends=True) if x.startswith(b'ExecStartPost=') and x!=b'ExecStartPost=\n')),('already_candidate',rewritten),('wrong_prior_backend',middle.replace(str(candidate.OLD).encode(),b'/wrong.py'))]
passed=[]
for name,value in mutations:
 try:candidate.rewrite_dropin(value,str(prefix.CONTRACT),str(candidate.CONTRACT))
 except AssertionError:passed.append(name)
 else:raise AssertionError('Invalid upgrade input accepted: '+name)
report=dict(status='actual_v8_based_two_stage_synthetic_rewrite_controls_passed',finished=time.time(),source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),actual_current_dropin_sha256=hashlib.sha256(original).hexdigest(),synthetic_intermediate_roundtrip=True,negative_controls=passed,neural_calls=0,service_actions=0,installed=False,candidate_qualified=False)
out=ROOT/'test/results/locateanything-prefill-all-upgrade-controls-v252.json';assert not out.exists();out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
