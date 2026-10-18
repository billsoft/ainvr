"""Actual v7 drop-in rewrite controls;no files/services/models are changed."""
from pathlib import Path
import hashlib,importlib.util,json,time
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'
p=CODE/'install_locateanything_prefill_groups_runtime_v189.py'
assert hashlib.sha256(p.read_bytes()).hexdigest()=='7d007f7621fceeee39dd64f25fd2df81ce2fd28d0162e2d5a480eaeda8c873f3'
spec=importlib.util.spec_from_file_location('prefill_install_controls',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert hashlib.sha256(m.HEALTH.read_bytes()).hexdigest()=='20f67c83fb31213b5c0951f8deac6c48ce048210316307a8fd38700da522afa3'
side=m.read(m.SIDECAR);assert side['generation']['contract_sha256']==m.OLD_SHA
old_contract=side['installation']['production_contract'];drop=m.DROP.read_bytes();out=m.rewrite_dropin(drop,old_contract,str(m.CONTRACT))
assert drop==out.replace(str(m.NEW).encode(),str(m.OLD).encode()).replace(m.CONTRACT_SHA.encode(),m.OLD_SHA.encode()).replace(str(m.CONTRACT).encode(),old_contract.encode())
assert out.count(b'ExecStartPost=')==drop.count(b'ExecStartPost=')==2
assert m.CONTRACT.parent==m.BASE # Runtime169 admits BASE,not an arbitrary release copy.
mutations=[('missing_post_hash',drop.replace(m.OLD_SHA.encode(),b'f'*64,1)),('missing_post_reset',drop.replace(b'ExecStartPost=\n',b'')),('duplicate_actual_post',drop+next(x for x in drop.splitlines(keepends=True) if x.startswith(b'ExecStartPost=') and x!=b'ExecStartPost=\n')),('already_candidate',out),('wrong_old_backend',drop.replace(str(m.OLD).encode(),b'/wrong.py'))]
passed=[]
for name,data in mutations:
 try:m.rewrite_dropin(data,old_contract,str(m.CONTRACT))
 except AssertionError:passed.append(name)
 else:raise AssertionError('Invalid drop-in accepted '+name)
r=dict(schema='ainvr_prefill_upgrade_dropin_controls_v190',finished=time.time(),actual_current_dropin_sha256=hashlib.sha256(drop).hexdigest(),in_memory_candidate_dropin_sha256=hashlib.sha256(out).hexdigest(),actual_v7_roundtrip_passed=True,negative_controls=passed,candidate_contract_path=str(m.CONTRACT),candidate_qualified=False,installer_executed=False,neural_calls=0,service_actions=0,source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
p=ROOT/'test/results/locateanything-prefill-upgrade-controls-v190.json';assert not p.exists();p.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
