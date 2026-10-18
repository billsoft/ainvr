"""Actual complete original-model BPU generation against preselected native data.

No missing-layer replacement, neural CPU oracle, case reselection, calibration,
or release action. Partial/smoke runs can never establish fresh final acceptance.
"""
from pathlib import Path
import argparse,hashlib,json,re,signal,sys,time,traceback
import numpy as np

BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
CODE=Path('/home/sunrise/ainvr/test/model_conversion')
RUNTIME=Path('/home/sunrise/ainvr/ai-service/runtime')
REFERENCE_SHA='5135f621868ac5999e116cb19f587224b5d1fac39fe6fe1a89b6ea7585ea105c'
TOKENIZER_SHA='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40'

def digest(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as stream:
  for chunk in iter(lambda:stream.read(4*1024**2),b''):h.update(chunk)
 return h.hexdigest()

def parse_response(text):
 boxes=[];points=[];malformed=[];empty=0
 for part in re.findall(r'<box>(.*?)</box>',text):
  if part.strip().lower()=='none':empty+=1;continue
  if re.fullmatch(r'(?:<\d+>){2}|(?:<\d+>){4}',part):
   values=list(map(int,re.findall(r'<(\d+)>',part)))
   if all(0<=v<=1000 for v in values) and (len(values)==2 or (values[2]>values[0] and values[3]>values[1])):
    (boxes if len(values)==4 else points).append(values);continue
  malformed.append(part)
 if '<box>' not in text:malformed.append('missing_box_frame')
 if text.count('<box>')!=text.count('</box>'):malformed.append('unclosed_box')
 return dict(boxes=boxes,points=points,explicit_empty_boxes=empty,malformed_blocks=malformed)

def iou(a,b):
 intersection=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
 area=lambda x:max(0,x[2]-x[0])*max(0,x[3]-x[1])
 union=area(a)+area(b)-intersection
 return intersection/union if union>0 else 0.

def maximum_matches(left,right,compatible):
 """Maximum cardinality one-to-one matching; duplicates remain predictions."""
 adjacent=[[j for j,b in enumerate(right) if compatible(a,b)] for a in left]
 assigned={}
 def augment(i,seen):
  for j in adjacent[i]:
   if j in seen:continue
   seen.add(j)
   if j not in assigned or augment(assigned[j],seen):assigned[j]=i;return True
  return False
 for i in range(len(left)):augment(i,set())
 return sorted((i,j) for j,i in assigned.items())

def summarize(cases,required_indices):
 box=[c for c in cases if c['kind']=='box'];point=[c for c in cases if c['kind']=='point']
 matched=sum(c['matched_boxes'] for c in box)
 predicted=sum(len(c['candidate']['boxes']) for c in box)
 reference=sum(len(c['reference']['boxes']) for c in box)
 precision=matched/predicted if predicted else (1. if reference==0 else 0.)
 recall=matched/reference if reference else (1. if predicted==0 else 0.)
 complete=sorted(c['index'] for c in cases)==list(range(72)) and required_indices==list(range(72))
 type_valid=all(not c['candidate']['points'] for c in box) and all(not c['candidate']['boxes'] for c in point)
 valid=type_valid and all(c['terminal'] and not c['candidate']['malformed_blocks'] and not c['neural_cpu_fallback'] for c in cases)
 return dict(box_cases=len(box),point_cases=len(point),matched_boxes=matched,candidate_boxes=predicted,reference_boxes=reference,
  precision=precision,recall=recall,iou_threshold=.9,coverage_complete=complete,geometry_type_contract_valid=type_valid,all_outputs_terminal_and_well_formed=valid,
  box_trial_quality_passed=complete and valid and precision>=.70 and recall>=.70,
  box_formal_quality_passed=complete and valid and precision>=.80 and recall>=.80,
  box_preferred_quality_passed=complete and valid and precision>=.85 and recall>=.85,
  point_coordinate_tolerance=10,point_reference_count=sum(len(c['reference']['points']) for c in point),
  point_candidate_count=sum(len(c['candidate']['points']) for c in point),point_matches=sum(c['matched_points'] for c in point),
  note='Box agreement with native BF16,not annotation AP. Points separately reported within10/1000 Euclidean units;no point accuracy claim from box P/R. Release additionally requires runtime/media/UI/archive acceptance.')

def capture_failed_generation(error,executor,out):
 """Preserve diagnostic progress without accepting partial output as a result."""
 result=dict(diagnostic_only=True,terminal_output=False,actual_neural_calls=0)
 if executor is not None:
  stats=executor.stats
  result.update(actual_neural_calls=int(stats.get('calls',0)),all_models_released=not bool(executor.loaded),
                executor_stats={k:v for k,v in stats.items() if k!='events'})
  events=out/'failed-case-events.json'
  events.write_text(json.dumps(stats.get('events',[]),allow_nan=False)+'\n')
  result.update(events_file=events.name,events_sha256=digest(events))
 tb=error.__traceback__
 while tb is not None:
  frame=tb.tb_frame
  if frame.f_code.co_name=='generate' and Path(frame.f_code.co_filename)==CODE/'locateanything_bpu_generation_v1.py':
   values=frame.f_locals;state=values.get('state')
   result['completed_steps']=values.get('traces',[])
   result['step_count']=len(result['completed_steps'])
   if state is not None:
    result['partial_generated_ids']=[int(value) for value in state.history[state.prompt_length:]]
    result['generated_token_count']=len(result['partial_generated_ids'])
   if values.get('started') is not None:result['observed_generation_seconds']=time.perf_counter()-values['started']
   break
  tb=tb.tb_next
 return result

def main():
 p=argparse.ArgumentParser()
 p.add_argument('--contract',type=Path,required=True);p.add_argument('--contract-sha256',required=True)
 p.add_argument('--tokenizer',type=Path,required=True);p.add_argument('--reference-root',type=Path,required=True)
 p.add_argument('--out',type=Path,required=True);p.add_argument('--case-indices',default='all')
 p.add_argument('--mode',choices=['slow','hybrid','fast'],default='slow')
 p.add_argument('--maximum-seconds-per-case',type=float,default=1200.)
 p.add_argument('--resident-models',type=int,choices=[1,2],default=1)
 p.add_argument('--check-only',action='store_true');a=p.parse_args()
 assert a.out.parent.resolve()==BASE.resolve() and not a.out.exists()
 assert a.reference_root.resolve().is_relative_to(BASE.resolve()) and 0<a.maximum_seconds_per_case<=3600
 indices=list(range(72)) if a.case_indices=='all' else [int(x) for x in a.case_indices.split(',')]
 assert indices and len(set(indices))==len(indices) and all(0<=i<72 for i in indices)
 indices.sort();a.out.mkdir()
 r=dict(status='checking',started=time.time(),source_sha256=digest(Path(__file__)),contract_sha256=a.contract_sha256,
  reference_sha256=REFERENCE_SHA,mode=a.mode,selected_indices=indices,required_cases=72,cases=[],
  whole_model_bpu_verified=False,release_approved=False,check_only=a.check_only,neural_calls=0,
  maximum_seconds_per_case=a.maximum_seconds_per_case,resident_models=a.resident_models)
 def persist():
  t=a.out/'status.json.tmp';t.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');t.replace(a.out/'status.json')
 def stop(signum,frame):raise RuntimeError('Owned complete-model evaluation interrupted: '+str(signum))
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGHUP,stop)
 executor=None
 persist()
 try:
  reference_path=a.reference_root/'reference-index-v1.json';assert digest(reference_path)==REFERENCE_SHA
  reference=json.loads(reference_path.read_text());assert reference['status']=='completed' and reference['all_terminal']
  assert reference['frozen_grouped_contract_sha256']==a.contract_sha256=='3c3066a0808027b3fc1e0c591ce71f435e622b6b03c01cbfb12bb739ac37ff34'
  assert reference['selection_sha256']=='e32fbb9e82c54ab6e409c6925dfe582806194622661bc36a45ffd03ea69a9c81'
  assert len(reference['cases'])==72 and reference['box_cases']==64 and reference['point_cases']==8 and reference['malformed_block_cases']==0
  sys.path.insert(0,str(RUNTIME));sys.path.insert(0,str(CODE))
  from locateanything_prompt import LocateAnythingPrompt
  prompt=LocateAnythingPrompt(a.tokenizer,TOKENIZER_SHA)
  prepared=[]
  for index in indices:
   case=reference['cases'][index];assert case['index']==index
   arrays={}
   for key in ['pixels','grid','ids']:
    path=(a.reference_root/case[key]).resolve();assert path.is_relative_to(a.reference_root.resolve()) and digest(path)==case[key+'_sha256']
    arrays[key]=np.load(path,allow_pickle=False)
   assert np.array_equal(prompt.encode(case['query'],128,a.mode),arrays['ids'])
   assert arrays['pixels'].shape==(512,3,14,14) and arrays['pixels'].dtype==np.float32
   assert arrays['grid'].tolist()==[[16,32]] and len(arrays['ids'])+128+(0 if a.mode=='slow' else 6)<=512
   prepared.append((case,arrays))
  # Constructor strictly verifies all113 components covering the original full architecture.
  # It must execute before any case can be marked as running or any SDK call.
  from locateanything_bpu_grouped_contract_v1 import load_grouped_generator as load_complete_generator
  generator,contract=load_complete_generator(a.contract,a.contract_sha256)
  assert len(generator.specs)==113 and contract['evaluation_only'] and not contract['release_approved']
  r.update(component_count=113,constructor_validated=True,status='contract_checked' if a.check_only else 'generating_actual_bpu');persist()
  if not a.check_only:
   from locateanything_bpu_components_v2 import ComponentExecutor
   from locateanything_bpu_executor import request_bound_executor_type
   for native,arrays in prepared:
    started=time.monotonic();r['current']=dict(index=native['index'],image_id=native['image_id'],query=native['query']);persist()
    executor_type=request_bound_executor_type(ComponentExecutor,None,started+a.maximum_seconds_per_case)
    executor=executor_type(generator.specs,budget_bytes=1536*1024**2,minimum_available_bytes=2*1024**3,maximum_models=a.resident_models)
    try:
     answer=generator.generate(executor,arrays['pixels'],arrays['grid'],arrays['ids'],mode=a.mode,
      max_new_tokens=128,model_max_length=512,temperature=0.,maximum_seconds=a.maximum_seconds_per_case)
    finally:executor.close()
    assert not executor.loaded and executor.stats['calls']>0
    generated=answer.pop('generated_ids').tolist();text=prompt.decode(generated);candidate=parse_response(text)
    target=parse_response(native['response']);assert target['boxes']==native['boxes'] and target['points']==native['points']
    matches=maximum_matches(target['boxes'],candidate['boxes'],lambda x,y:iou(x,y)>=.9)
    points=maximum_matches(target['points'],candidate['points'],lambda x,y:sum((u-v)**2 for u,v in zip(x,y))<=100)
    record=dict(index=native['index'],image_id=native['image_id'],query=native['query'],kind=native['kind'],
     generated_ids=generated,response=text,reference=target,candidate=candidate,matched_boxes=len(matches),matched_points=len(points),
     matched_ious=[iou(target['boxes'][i],candidate['boxes'][j]) for i,j in matches],
     all_models_released=True,wall_seconds=time.monotonic()-started,**answer)
    events=executor.stats['events'];stats={k:v for k,v in executor.stats.items() if k!='events'}
    record['executor_stats']=stats
    event_path=a.out/f"case-{native['index']:03d}-events.json";event_path.write_text(json.dumps(events)+'\n')
    record['events_sha256']=digest(event_path)
    case_path=a.out/f"case-{native['index']:03d}.json";case_path.write_text(json.dumps(record,indent=2,allow_nan=False)+'\n')
    r['cases'].append(record);r['neural_calls']+=stats['calls'];r['aggregate']=summarize(r['cases'],indices);persist()
   r.update(status='completed',current=None,actual_complete_architecture_generation_executed=True,
    fresh_box_quality_verified=r['aggregate']['box_trial_quality_passed'])
 except BaseException as error:
  r.update(status='failed',error=traceback.format_exc())
  try:
   r['failed_case_progress']=capture_failed_generation(error,executor,a.out)
   current=r.get('current')
   already_counted=current is None or any(c['index']==current['index'] for c in r['cases'])
   r['actual_neural_calls_including_failed_case']=r['neural_calls']+(0 if already_counted else r['failed_case_progress']['actual_neural_calls'])
  except Exception:r['failure_telemetry_error']=traceback.format_exc()
  raise
 finally:
  r['finished']=time.time();persist()
 print(json.dumps({k:r.get(k) for k in ['status','neural_calls','whole_model_bpu_verified','aggregate']}))

if __name__=='__main__':main()
