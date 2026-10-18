"""Actual measured mixed candidate admission and coherent manifest mutations;no neural calls or compiler jobs."""
from pathlib import Path
import copy,json,sys,time
sys.path.insert(0,'/work/official-llm-v1')
import locateanything_attn8_mlp4_candidate_v1 as candidate
from locateanything_row_gptq_checkpoint_v1 import digest
original_root=candidate.ROOT;manifest=original_root/'manifest.json';pin='d1c52be06fdd5a0a011f71d0155076ee1fffa463b8b3da7d6d92a1f4e391e316';assert digest(manifest)==pin;entries,actual=candidate.admit(pin);assert len(entries)==252
root=Path('/opt/locate-attn8-mlp4-admission-controls-v1');assert not root.exists();root.mkdir();a=next(i for i,e in enumerate(actual['modules']) if e['bits']==8);m=next(i for i,e in enumerate(actual['modules']) if e['bits']==4)
changes=[('missing_projection',lambda x:x['modules'].pop()),('duplicate_projection',lambda x:x['modules'].__setitem__(-1,copy.deepcopy(x['modules'][0]))),('attention_to_w4',lambda x:x['modules'][a].__setitem__('bits',4)),('mlp_to_w8',lambda x:x['modules'][m].__setitem__('bits',8)),('modified_mlp_payload',lambda x:x['modules'][m]['prepared_entry'].__setitem__('sha256','0'*64)),('changed_original_attention',lambda x:x['modules'][a].__setitem__('original_bf16_parameter_sha256','0'*64)),('inflated_quality',lambda x:x['preparation']['aggregate'].__setitem__('precision',.99)),('changed_quality_reference',lambda x:x['preparation'].__setitem__('quality_control_sha256','0'*64)),('shrunk_vocabulary',lambda x:x['architecture'].__setitem__('vocabulary',32768)),('unrecognized_preparer',lambda x:x.__setitem__('source_sha256','0'*64)),('different_weights_root',lambda x:x['modules'][m].__setitem__('prepared_root','/opt/unrelated'))]
negative=[]
try:
 for name,edit in changes:
  mutant=copy.deepcopy(actual);edit(mutant);d=root/name;d.mkdir();p=d/'manifest.json';p.write_text(json.dumps(mutant,indent=2)+'\n');candidate.ROOT=d
  try:candidate.admit(digest(p))
  except ValueError as error:negative.append(dict(name=name,rejected=str(error)));continue
  raise AssertionError('Invalid composition admitted:'+name)
finally:candidate.ROOT=original_root
candidate.admit(pin);r=dict(status='passed_actual_positive_and_semantic_negatives',created=time.time(),source_sha256=digest(__file__),admission_source_sha256=digest('/work/official-llm-v1/locateanything_attn8_mlp4_candidate_v1.py'),manifest_sha256=pin,actual_positive_controls=2,negative_controls=negative,neural_calls=0,hbm_compiles=0,research_export_only=True,trial_release_approved=False);p=Path('/work/official-llm-v1/attn8-mlp4-admission-controls-v1.json');assert not p.exists();p.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({k:r[k] for k in ['status','actual_positive_controls','negative_controls','neural_calls']}))
