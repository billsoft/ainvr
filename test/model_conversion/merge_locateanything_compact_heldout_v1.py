"""Revalidate complete compact BPU heldout shards without repeating successful images.

Requires the complete constructor, unchanged72 references and every actual trace.
No neural execution, deployment, memory/performance approval or case filtering.
"""
from pathlib import Path
from collections import Counter
import argparse,hashlib,json,math,sys,time
import numpy as np
from locateanything_compact_quality_v1 import summarize_compact,verify_slow_call_coverage,POLICY_SHA,parse_response
from locateanything_generation_control_v1 import ar_token_type

ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';RESULTS=ROOT/'test/results'
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
WORKER_SHA='0994aa8234ae1a21eb010c235cb64d8cc6204fa0681b0a30faaaf0c057526be0'
REFERENCE_SHA='5135f621868ac5999e116cb19f587224b5d1fac39fe6fe1a89b6ea7585ea105c'
TOKENIZER_SHA='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40'

def digest(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for block in iter(lambda:f.read(4*1024**2),b''):h.update(block)
 return h.hexdigest()

def verify_header(report,contract_sha,component_count):
 assert report['status'] in ['completed','failed'] and report['evaluation_family']=='compact_original36'
 assert report['source_sha256']==WORKER_SHA and report['contract_sha256']==contract_sha
 assert report['reference_sha256']==REFERENCE_SHA and report['quality_policy_sha256']==POLICY_SHA
 assert report['constructor_validated'] is True and report['component_count']==component_count
 assert report['check_only'] is False and report['runtime_uid']==1000 and report['mode']=='slow'
 assert report['resident_models'] in [1,2] and report['required_cases']==72
 selected=report['selected_indices'];indices=[c['index'] for c in report['cases']]
 assert selected==sorted(set(selected)) and selected and all(type(i) is int and 0<=i<72 for i in selected)
 assert indices==selected[:len(indices)] and indices
 if report['status']=='completed':assert indices==selected and report['actual_complete_architecture_generation_executed'] is True
 assert report['neural_calls']==sum(c['executor_stats']['calls'] for c in report['cases'])
 return indices

def verify_case(case,native,generator,prompt,input_ids):
 assert all(case[k]==native[k] for k in ['index','image_id','query','kind'])
 target=parse_response(native['response']);assert target['boxes']==native['boxes'] and target['points']==native['points']
 assert case['reference']==target and case['candidate']==parse_response(case['response'])
 ids=case['generated_ids'];steps=case['steps']
 assert ids and len(ids)==len(steps)==len(case['token_logprobs'])<=128
 assert all(type(i) is int and 0<=i<152681 for i in ids)
 assert prompt.decode(ids)==case['response'] and case['neural_cpu_fallback'] is False
 for i,(token,step) in enumerate(zip(ids,steps)):
  assert step['accepted_tokens']==[token] and step['mtp'] is False
  assert step['pattern']==ar_token_type(token,generator.token_ids,'slow')
  assert step['profile']==('prefill' if i==0 else 'ar')
  assert step['query_length']==(len(input_ids) if i==0 else 1)
  assert step['past_length']==(0 if i==0 else len(input_ids)+i-1)
  assert step['kept_cache_length']==len(input_ids)+i
  assert math.isfinite(step['seconds']) and step['seconds']>=0
  if i<len(ids)-1:assert step['pattern']!='im_end'
 assert case['terminal']==(steps[-1]['pattern']=='im_end') and case['stopped_at_token_limit']==(not case['terminal'])
 assert case['generation_mode']=='slow' and case['all_models_released'] is True
 assert case['architecture_coverage_verified'] is True
 stats=case['executor_stats'];counts=case['successful_component_calls']
 assert stats['calls']==case['bpu_calls']==sum(counts.values()) and stats['calls']>0
 assert case['model_loads']==stats['loads']
 coverage=verify_slow_call_coverage(generator,Counter(counts),case,input_ids)
 assert case['architecture_coverage']==coverage
 assert math.isfinite(case['wall_seconds']) and case['wall_seconds']>0
 return coverage

def main():
 p=argparse.ArgumentParser();p.add_argument('--contract',type=Path,required=True);p.add_argument('--contract-sha256',required=True)
 p.add_argument('--reports',type=Path,nargs='+',required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
 assert a.out.parent.resolve()==RESULTS and not a.out.exists()
 assert len(set(p.resolve() for p in a.reports))==len(a.reports)
 assert digest(CODE/'validate_locateanything_compact_heldout_bpu_v1.py')==WORKER_SHA
 sys.path.insert(0,str(ROOT/'ai-service/runtime'))
 from locateanything_bpu_compact_grouped_contract_v1 import load_compact_generator
 from locateanything_prompt import LocateAnythingPrompt
 generator,contract=load_compact_generator(a.contract,a.contract_sha256)
 assert contract['architecture']=='original36_compact_affine_four_groups' and len(generator.specs) in [113,117]
 assert contract['acceptance_policy']['sha256']==POLICY_SHA
 prompt=LocateAnythingPrompt(BASE/'tokenizer-original-v1.json',TOKENIZER_SHA)
 refroot=BASE/'official-heldout-reference-v1';refpath=refroot/'reference-index-v1.json';assert digest(refpath)==REFERENCE_SHA
 reference=json.loads(refpath.read_text());assert len(reference['cases'])==72 and reference['all_terminal']
 prepared={}
 for native in reference['cases']:
  i=native['index'];assert i not in prepared and 0<=i<72
  for key in ['pixels','grid','ids']:
   path=(refroot/native[key]).resolve();assert path.is_relative_to(refroot) and digest(path)==native[key+'_sha256']
  ids=np.load(refroot/native['ids'],allow_pickle=False)
  assert np.array_equal(prompt.encode(native['query'],128,'slow'),ids)
  prepared[i]=(native,ids)
 cases=[];inputs=[];seen=set();residencies=set();actual_calls=0;source_failures=[]
 for path in a.reports:
  path=path.resolve();assert path.parent.parent==BASE and path.name=='status.json' and not path.is_symlink()
  report=json.loads(path.read_text());verify_header(report,a.contract_sha256,len(generator.specs));residencies.add(report['resident_models'])
  if report['status']=='failed':source_failures.append(dict(path=str(path),completed_case_count=len(report['cases']),error=report.get('error'),failed_case_progress=report.get('failed_case_progress')))
  for case in report['cases']:
   i=case['index'];assert i not in seen,'Duplicate case across shards;do not select a preferred retry'
   assert json.loads((path.parent/f'case-{i:03d}.json').read_text())==case
   events_path=path.parent/f'case-{i:03d}-events.json';assert digest(events_path)==case['events_sha256']
   events=json.loads(events_path.read_text());assert all(e['type'] in ['load','evict'] and e['key'] in {s.key for s in generator.specs} for e in events)
   assert sum(e['type']=='load' for e in events)==case['executor_stats']['loads']
   native,ids=prepared[i];verify_case(case,native,generator,prompt,ids)
   seen.add(i);cases.append(case);actual_calls+=case['executor_stats']['calls']
  inputs.append(dict(path=str(path),sha256=digest(path)))
 assert seen==set(range(72)),'Every preselected case is required'
 assert len(residencies)==1,'Mixed residency needs separate runtime acceptance'
 cases.sort(key=lambda c:c['index']);aggregate=summarize_compact(cases,list(range(72)))
 assert aggregate['coverage_complete'] and aggregate['actual_complete_architecture_cases']==72
 result=dict(status='completed',source_sha256=digest(__file__),contract_sha256=a.contract_sha256,reference_sha256=REFERENCE_SHA,
  quality_policy_sha256=POLICY_SHA,constructor_revalidated=True,component_count=len(generator.specs),evaluation_family='compact_original36',
  mode='slow',resident_models=next(iter(residencies)),source_neural_calls=actual_calls,actual_complete_architecture_cases=72,
  inputs=inputs,cases=cases,aggregate=aggregate,source_failures_preserved=source_failures,maximum_case_wall_seconds=max(c['wall_seconds'] for c in cases),
  neural_calls_during_merge=0,neural_cpu_fallback=False,whole_model_release_approved=False,release_approved=False,finished=time.time())
 temp=a.out.with_suffix('.json.upload');assert not temp.exists();temp.write_text(json.dumps(result,indent=2,allow_nan=False)+'\n');temp.replace(a.out)
 print(json.dumps({k:result[k] for k in ['status','actual_complete_architecture_cases','source_neural_calls','aggregate']}))
if __name__=='__main__':main()
