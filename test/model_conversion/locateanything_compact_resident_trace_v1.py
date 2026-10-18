"""Verify persistent cache transitions across real heldout requests and final cleanup.
No inference or quality acceptance; caller must also verify native generation.
"""
import json,math
from pathlib import Path
from merge_locateanything_compact_heldout_v1 import digest
from locateanything_compact_resident_executor_v1 import PIN_KEYS
POLICY='persistent_compact_four_groups_heads_alias_v1'

def component_sizes(specs):
 return {s.key:(s.root/'model.hbm').stat().st_size for s in specs if not s.key.endswith('-prefill')}

def valid_state(state,sizes):
 assert isinstance(state,dict) and len(state)<=43
 assert all(k in sizes and type(v) is int and v==sizes[k] for k,v in state.items())
 return dict(state)

def replay(initial,events,sizes,*,release=False,allow_pin_eviction=False):
 state=valid_state(initial,sizes);loads=evictions=0;load_ms=0.
 assert isinstance(events,list)
 for e in events:
  assert e['key'] in sizes and type(e['file_bytes']) is int and e['file_bytes']==sizes[e['key']]
  k=e['key']
  if e['type']=='load':
   assert not release and k not in state
   assert math.isfinite(e['load_ms']) and e['load_ms']>=0
   state[k]=e['file_bytes'];loads+=1;load_ms+=e['load_ms']
  else:
   assert e['type']=='evict' and k in state
   assert release or allow_pin_eviction or k not in PIN_KEYS,'Pinned model evicted during a successful request'
   del state[k];evictions+=1
  assert len(state)<=43
 return state,dict(loads=loads,evictions=evictions,load_ms=load_ms)

def read_events(path,sha):
 assert path.is_file() and not path.is_symlink() and digest(path)==sha
 return json.loads(path.read_text())

def verify_case_cache(case,events,initial,sizes):
 assert case['all_models_released'] is False and case['models_retained_for_next_request'] is True
 assert case['generation_state_retained'] is False and case['cache_policy']==POLICY
 assert valid_state(case['initial_loaded_contexts'],sizes)==initial
 state,counts=replay(initial,events,sizes)
 assert state==valid_state(case['retained_contexts'],sizes) and PIN_KEYS<=set(state)
 stats=case['executor_stats']
 assert all(stats[k]==counts[k] for k in ['loads','evictions'])
 assert math.isclose(stats['load_ms'],counts['load_ms'],rel_tol=1e-10,abs_tol=1e-5)
 assert stats['peak_loaded_models']==43 and 0<stats['peak_resident_file_bytes']<6*1024**3
 return state

def verify_shard_cache(report,path,specs):
 sizes=component_sizes(specs);state={};last_events=[];last_initial={}
 for case in report['cases']:
  events=read_events(path.parent/f"case-{case['index']:03d}-events.json",case['events_sha256'])
  last_initial=dict(state);state=verify_case_cache(case,events,state,sizes);last_events=events
 assert report['all_models_released'] is True
 assert type(report['sdk_owner_tid']) is int and report['sdk_owner_tid']>0 and report['sdk_owner_tid']!=report['caller_tid']
 final=report['final_worker_state'];assert final['alive'] is False and final['cached_models']==0 and final['stopping'] is True
 release=read_events(path.parent/'final-release-events.json',report['final_release_events_sha256'])
 if report['status']=='failed':
  failed=report['failed_case_progress'];assert failed['diagnostic_only'] and failed['terminal_output'] is False and failed['all_models_released']
  events=read_events(path.parent/failed['events_file'],failed['events_sha256']);current=report.get('current')
  duplicate=bool(report['cases'] and (current is None or current['index']==report['cases'][-1]['index']))
  if duplicate:
   assert failed['initial_loaded_contexts']==last_initial and events[:len(last_events)]==last_events
   events=events[len(last_events):]
  else:assert valid_state(failed['initial_loaded_contexts'],sizes)==state
  # Failed SDK requests close all contexts on the owner; pins may be released.
  state,counts=replay(state,events,sizes,release=duplicate,allow_pin_eviction=True)
  if not duplicate:
   assert counts['loads']==failed['executor_stats']['loads'] and counts['evictions']==failed['executor_stats']['evictions']
  assert state=={} and release==[]
  assert report['actual_neural_calls_including_failed_case']==report['neural_calls']+(0 if duplicate else failed['actual_neural_calls'])
 state,_=replay(state,release,sizes,release=True);assert state=={}
 return dict(cache_lifecycle_verified=True,all_contexts_released=True,retained_generation_state=False)
