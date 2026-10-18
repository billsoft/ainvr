"""Actual v8 drop-in rewrite controls;no files/services/models are changed."""
from pathlib import Path
import hashlib,importlib.util,json,time
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'
p=CODE/'install_locateanything_prefill_three_groups_runtime_v217.py'
assert hashlib.sha256(p.read_bytes()).hexdigest()=='af864d27a25ef7de7895b4f5f4a97c9761c40e01abdb61ea5b635d951dda9227'
spec=importlib.util.spec_from_file_location('prefill_install_controls',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert hashlib.sha256(m.HEALTH.read_bytes()).hexdigest()=='708d24e4676509ed500d1f243c65a76b222fa9fb38981f750e222283496328dd'
m.CONTRACT_SHA='c'*64 # Synthetic unknown future hash,not an admitted candidate.
side=m.read(m.SIDECAR);assert side['generation']['contract_sha256']==m.OLD_SHA
old_contract=side['installation']['production_contract'];drop=m.DROP.read_bytes();out=m.rewrite_dropin(drop,old_contract,str(m.CONTRACT))
assert drop==out.replace(str(m.NEW).encode(),str(m.OLD).encode()).replace(m.CONTRACT_SHA.encode(),m.OLD_SHA.encode()).replace(str(m.CONTRACT).encode(),old_contract.encode())
assert out.count(b'ExecStartPost=')==drop.count(b'ExecStartPost=')==2
assert m.CONTRACT.parent==m.BASE # Runtime204 admits BASE,not an arbitrary release copy.
mutations=[('missing_post_hash',drop.replace(m.OLD_SHA.encode(),b'f'*64,1)),('missing_post_reset',drop.replace(b'ExecStartPost=\n',b'')),('duplicate_actual_post',drop+next(x for x in drop.splitlines(keepends=True) if x.startswith(b'ExecStartPost=') and x!=b'ExecStartPost=\n')),('already_candidate',out),('wrong_old_backend',drop.replace(str(m.OLD).encode(),b'/wrong.py'))]
passed=[]
for name,data in mutations:
 try:m.rewrite_dropin(data,old_contract,str(m.CONTRACT))
 except AssertionError:passed.append(name)
 else:raise AssertionError('Invalid drop-in accepted '+name)
r=dict(schema='ainvr_prefill_three_groups_upgrade_dropin_controls_v219',finished=time.time(),actual_current_dropin_sha256=hashlib.sha256(drop).hexdigest(),in_memory_candidate_dropin_sha256=hashlib.sha256(out).hexdigest(),actual_v8_roundtrip_passed=True,negative_controls=passed,candidate_contract_path=str(m.CONTRACT),candidate_qualified=False,installer_executed=False,neural_calls=0,service_actions=0,source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
p=ROOT/'test/results/locateanything-prefill-three-groups-upgrade-controls-v219.json';assert not p.exists();p.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
