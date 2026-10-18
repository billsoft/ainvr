"""Reconcile existing native counters and control routing timings,without MAC claims."""
from pathlib import Path
import hashlib,json,statistics,time
ROOT=Path('/home/sunrise/ainvr');T=ROOT/'test/results';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1');OUT=T/'locateanything-runtime-phase-analysis-v144.json'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def kind(key):
 if key.startswith('decoder-group-') and key.endswith('-prefill'):return 'text_prefill'
 if key.startswith('decoder-group-') and key.endswith('-ar'):return 'text_autoregressive'
 if key.startswith('vision-'):return 'vision'
 if key.startswith('embedding-'):return 'embedding'
 assert key=='full-vocabulary-head';return 'vocabulary_head'
def main():
 assert not OUT.exists();p=BASE/'full-runtime-phase-profile-v143/status.json';gpath=T/'locateanything-runtime-phase-profile-v143-guard.json';g=read(gpath);r=read(p);assert g['status']=='completed_runtime_phase_profile_and_current_production_restored' and g['raw_sha256']==sha(p) and g['proof']==r and g['original_current_configuration_and_real_SEI_restored'] and not any(g['owned_ion_after_exit'].values())
 assert r['source_sha256']=='512790d179f620d3e7cf8d719e001333ab3a2b24df90907dda332a89f0a0a7bd' and r['status']=='completed_current_family_runtime_phase_profile' and r['same_generated_tokens_all11'] and r['all_models_released'] and len(r['cases'])==11 and r['timed_request_count']==10
 cases=[c for c in r['cases'] if not c['warmup']];assert [c['index'] for c in cases]==[0,1,5,79,159]*2;assert sum(len(c['program_rows']) for c in r['cases'])==r['total_neural_calls'];groups={};control={};wall=0
 nativefields=['allocation_ms','copy_clean_ms','submit_wait_release_ms','invalidate_host_copy_ms','total_ms']
 for c in cases:
  assert c['complete_output_semantics_identical'] and c['answer']['model_loads']==c['answer']['executor_stats']['loads']==c['answer']['executor_stats']['evictions']==0;wall+=c['wall_seconds']*1000
  for row in c['program_rows']:
   a=groups.setdefault(kind(row['key']),dict(calls=0,checked_run_ms=0.,native={k:0. for k in nativefields},input_valid_bytes=0,output_valid_bytes=0));a['calls']+=1;a['checked_run_ms']+=row['checked_run_ms'];a['input_valid_bytes']+=row['input_valid_bytes'];a['output_valid_bytes']+=row['output_valid_bytes']
   for k in nativefields:a['native'][k]+=row['native'][k]
  for row in c['control_rows']:
   a=control.setdefault(row['kind'],dict(calls=0,ms=0.));a['calls']+=1;a['ms']+=row['ms']
 native={k:sum(v['native'][k] for v in groups.values()) for k in nativefields};checked=sum(v['checked_run_ms'] for v in groups.values());control_ms=sum(v['ms'] for v in control.values());residual=wall-checked-control_ms;assert residual>=-1 and abs(sum(native[k] for k in nativefields[:-1])-native['total_ms'])<1e-5
 for a in groups.values():
  a['fraction_of_observed_wall_time']=a['checked_run_ms']/wall;a['mean_checked_ms_per_call']=a['checked_run_ms']/a['calls'];a['mean_native_ms_per_call']={k:v/a['calls'] for k,v in a['native'].items()}
 bycase=[]
 for index in [0,1,5,79,159]:
  rows=[x for x in cases if x['index']==index];bycase.append(dict(index=index,tokens=len(rows[0]['answer']['generated_ids']),median_seconds=statistics.median(x['wall_seconds'] for x in rows),median_first_token_seconds=statistics.median(x['answer']['first_token_seconds'] for x in rows)))
 result=dict(status='completed_current_model_native_and_control_runtime_attribution',created=time.time(),source_sha256=sha(__file__),guard_sha256=sha(gpath),raw_sha256=sha(p),requests=11,timed_requests=10,neural_calls=r['total_neural_calls'],all_selected_outputs_unchanged=True,architecture=dict(text_layers=36,vision_blocks=27,vocabulary=152681,logical_programs=76,physical_hbms=46),groups=groups,control=control,per_case=bycase,total_observed_wall_ms=wall,total_checked_program_ms=checked,native=native,native_fraction_of_wall={k:v/wall for k,v in native.items()},checked_wrapper_outside_native_ms=checked-native['total_ms'],unattributed_outside_measured_program_and_control_ms=residual,conservative_worker_memory_maximum=g['conservative_worker_memory_maximum'],current_user_configuration_and_real_SEI_restored=True,source_recording_stopped=False,quality_scope='Selected frozen cases after complete160 equivalence;not unseen accuracy evaluation',timing_scope='Instrumented Python plus existing native counters; submit/wait/release includes scheduling,device execution and release;not pure MAC activity or isolated accelerator latency;not speedup A/B',goal_status='active')
 OUT.write_text(json.dumps(result,indent=2,allow_nan=False)+'\n');print(json.dumps(dict(status=result['status'],sha256=sha(OUT),native_fraction_of_wall=result['native_fraction_of_wall'],control=control,groups=groups,per_case=bycase,unattributed_ms=residual)))
if __name__=='__main__':main()
