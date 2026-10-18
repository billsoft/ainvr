"""Negative controls for full160 candidate qualification;zero neural/service calls."""
from pathlib import Path
import copy,hashlib,importlib.util,json,time
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'
SOURCE=CODE/'compare_locateanything_prefill_three_groups_full_image_v213.py'
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()=='2e7855487804614b51ec581a6b08d33c89ea8a0f3e5fd08b607c50453a66e287'
spec=importlib.util.spec_from_file_location('candidate_qualification_controls',SOURCE)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
CANDIDATE='c'*64;RAW_SHA='a'*64

def fixture():
 cases=[]
 for i in range(160):
  answer=dict(generated_ids=[i,42],response='x',token_logprobs=[-.1,-.2],terminal=i!=117,stopped_at_token_limit=i==117,generation_mode='slow',neural_cpu_fallback=False,limits={'kv':512},bpu_calls=(160 if i<159 else 354),model_loads=0,steps=[{'name':'prefill','seconds':1.0,'calls':1}])
  cases.append(dict(index=i,image_id=i,query='x',kind='box',reference=[],reference_eligible=True,reference_terminal=True,candidate=[],terminal=i!=117,neural_cpu_fallback=False,answer=answer,rpc_ok=True,runtime_equivalent=True,different_fields=[]))
 baseline=dict(cases=copy.deepcopy(cases),summary={'p':.593,'r':.625})
 raw=dict(status='completed_all160_runtime_regression',all160_operations_executed=True,runtime_equivalence_passed=True,summary_exactly_equal_baseline=True,contract_sha256=CANDIDATE,baseline_bpu_sha256='8a9e35dfe7203c9e982b0edee8546e907bb0e988d137d2f13b18e839d5ca1b13',source_sha256='61682a5cca043ec937882f330deb516ee5afaf19865f8510de1c2ad89660b90e',reference_index_sha256='8b16861bd8f5c78e050dfae3a41a18597ca887105fbac636469e8ffb2e8ef253',cases=cases,summary=copy.deepcopy(baseline['summary']),retained_failed_indices=[117],mismatch_indices=[],neural_calls=25794)
 guard=dict(status='completed_all160_runtime_equivalence_not_installed',raw_sha256=RAW_SHA,client_sha256=raw['source_sha256'],backend_sha256='a5f903f4674a2d0af973b8c36bce591ce279ccdb273b1dc702e67c2474b7487e',runtime_equivalence_passed=True,neural_calls=25794,retained_failed_indices=[117],source_recording_stopped=False,production_candidate_installed=False,original_backend_user_config_and_sei_output_restored=True,restore_errors=[],config_before='x',config_after='x',binary_before='y',binary_after='y',memory_sample_count=1,conservative_experiment_memory_bytes_maximum=6000000000,owned_ion_after_exit={'carveout':0},media_before={'original_unit_processes':{'recorder':1,'ingest':2}},media_after={'original_unit_processes':{'recorder':1,'ingest':2}})
 return raw,guard,baseline

def qualify(a):m.require_full160(a[0],a[1],a[2],CANDIDATE,RAW_SHA)

def set_path(path,value):
 def change(a):
  target=a
  for key in path[:-1]:target=target[key]
  target[path[-1]]=value
 return change

controls=[
 ('partial_cases',lambda a:a[0]['cases'].pop()),
 ('duplicate_case',set_path([0,'cases',159,'index'],158)),
 ('token_changed',set_path([0,'cases',0,'answer','generated_ids'],[99])),
 ('probability_changed',set_path([0,'cases',0,'answer','token_logprobs'],[-9.])),
 ('step_semantics_changed',set_path([0,'cases',0,'answer','steps',0,'calls'],2)),
 ('parsed_box_changed',set_path([0,'cases',0,'candidate'],[[1,2,3,4]])),
 ('new_termination_failure',set_path([0,'cases',99,'terminal'],False)),
 ('exception_waived',set_path([0,'retained_failed_indices'],[])),
 ('cpu_fallback',set_path([0,'cases',0,'answer','neural_cpu_fallback'],True)),
 ('hidden_load',set_path([0,'cases',0,'answer','model_loads'],1)),
 ('rpc_failed',set_path([0,'cases',0,'rpc_ok'],False)),
 ('pass_flag_hides_diff',set_path([0,'cases',0,'different_fields'],['response'])),
 ('different_reference',set_path([0,'cases',0,'reference'],[99])),
 ('unreconciled_calls',set_path([0,'neural_calls'],1599)),
 ('summary_changed',set_path([0,'summary'],{'p':1,'r':1})),
 ('candidate_hash_wrong',set_path([0,'contract_sha256'],'d'*64)),
 ('baseline_hash_wrong',set_path([0,'baseline_bpu_sha256'],'d'*64)),
 ('client_source_wrong',set_path([0,'source_sha256'],'d'*64)),
 ('reference_hash_wrong',set_path([0,'reference_index_sha256'],'d'*64)),
 ('raw_hash_wrong',set_path([1,'raw_sha256'],'d'*64)),
 ('backend_source_wrong',set_path([1,'backend_sha256'],'d'*64)),
 ('guard_failed',set_path([1,'status'],'failed')),
 ('recorder_stopped',set_path([1,'source_recording_stopped'],True)),
 ('candidate_installed',set_path([1,'production_candidate_installed'],True)),
 ('sei_not_restored',set_path([1,'original_backend_user_config_and_sei_output_restored'],False)),
 ('restore_errors',set_path([1,'restore_errors'],['error'])),
 ('config_changed',set_path([1,'config_after'],'changed')),
 ('native_changed',set_path([1,'binary_after'],'changed')),
 ('no_memory_samples',set_path([1,'memory_sample_count'],0)),
 ('memory_limit',set_path([1,'conservative_experiment_memory_bytes_maximum'],10400000001)),
 ('ion_leak',set_path([1,'owned_ion_after_exit','carveout'],4096)),
 ('recorder_restarted',set_path([1,'media_after','original_unit_processes','recorder'],3)),
 ('cleanup_error',set_path([1,'cleanup_error'],'error')),
]
qualify(fixture());passed=[]
for name,mutate in controls:
 a=fixture();mutate(a)
 try:qualify(a)
 except (AssertionError,KeyError,TypeError):passed.append(name)
 else:raise AssertionError('Accepted invalid evidence '+name)
# Timing may differ;semantic comparisons intentionally exclude seconds only.
a=fixture();a[0]['cases'][0]['answer']['steps'][0]['seconds']=.1;qualify(a)
r=dict(schema='ainvr_full160_qualification_controls_v214',finished=time.time(),positive_synthetic_controls=2,negative_controls=passed,neural_calls=0,service_actions=0,real_candidate_qualified=False,source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
out=ROOT/'test/results/locateanything-prefill-three-groups-full160-controls-v214.json';assert not out.exists();out.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
