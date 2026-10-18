"""Bind complete compact residency to raw actual full-model evidence.

This validates provenance/coverage and sampled memory,not heldout quality/UI.
Hybrid diagnostic reports must never authorize complete compact service.
"""
from pathlib import Path
import hashlib,json
ROOT=Path('/home/sunrise/ainvr');RESULTS=ROOT/'test/results'
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
BASELINE_SOURCE='39934d0e29d434f5bbdbc8c0cc581f646eae1947e711f419717006fee5b71148'
BASELINE_GUARD='1337ab5360de025b28f1d550b4f0902b23aea5e198085fac2d8370fa95d19dd4'
SELECTION='4890891e8c421d9723c37cce1a4c5034e85007cc18cd6b12b73a4339e6f958b6'
WORKER='1413aada82b992674080b6eaa42af370784f2f9fa2c0e7fa1e45784ece055bd5'
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def raw_from_guard(path,expected_sha):
 p=Path(path);assert p.parent.resolve()==RESULTS and not p.is_symlink() and p.name.endswith('-guard.json') and digest(p)==expected_sha
 g=json.loads(p.read_text());assert g['status']=='completed' and g['production_restored'] is True and g['actual_complete_image_generation_executed'] is True
 raw=BASE/(p.name[:-len('-guard.json')]+'-actual')/'status.json'
 assert raw.parent.parent.resolve()==BASE and not raw.is_symlink() and digest(raw)==g['case_report_sha256']
 w=json.loads(raw.read_text());assert w['status']=='completed' and w['runtime_uid']==1000 and w['check_only'] is False
 return g,w,raw

def verify_counts(counts,case):
 ids=case['generated_ids'];assert ids and all(type(i) is int and 0<=i<152681 for i in ids)
 assert case['terminal'] is True and not case['stopped_at_token_limit'] and case['neural_cpu_fallback'] is False
 assert case['generation_mode']=='slow' and len(case['steps'])==len(ids) and case['steps'][0]['query_length']==155
 assert all(len(s['accepted_tokens'])==1 and not s['mtp'] for s in case['steps'])
 assert [s['accepted_tokens'][0] for s in case['steps']]==ids
 vision=['vision-prefix']+[f'vision-block-{i:02d}' for i in range(27)]+['vision-connector']
 allowed=set(vision)|{f'embedding-{i:02d}' for i in range(38)}|{f'head-{i:02d}' for i in range(38)}|{f'decoder-group-{i:02d}-{i+8:02d}-{p}' for i in (0,9,18,27) for p in ['prefill','decode']}
 assert set(counts)<=allowed
 assert all(counts[k]==1 for k in vision)
 for i in (0,9,18,27):
  assert counts[f'decoder-group-{i:02d}-{i+8:02d}-prefill']==155
  assert counts.get(f'decoder-group-{i:02d}-{i+8:02d}-decode',0)==len(ids)-1
 assert all(counts[f'head-{i:02d}']==len(ids) for i in range(38))
 assert sum(v for k,v in counts.items() if k.startswith('embedding-'))==27+len(ids)-1
 assert all(type(v) is int and v>0 for v in counts.values()) and sum(counts.values())==case['bpu_calls']
 return sum(counts.values())

def load_baseline(path,expected_sha,contract_sha):
 g,w,raw=raw_from_guard(path,expected_sha)
 assert g['source_sha256']==BASELINE_GUARD and g['validator_sha256']==BASELINE_SOURCE and w['source_sha256']==BASELINE_SOURCE
 assert w['contract_sha256']==contract_sha and w['selection_sha256']==SELECTION and w['resident_models']==1
 assert not w.get('diagnostic_only',False) and w['architecture_coverage_verified'] and w['all_models_released'] and w['output_usable']
 assert verify_counts(w['successful_component_calls'],w['case'])==w['neural_calls']
 return w,dict(guard_path=str(path),guard_sha256=expected_sha,raw_path=str(raw),raw_sha256=digest(raw))

def load_residency_evidence(path,expected_sha,contract_sha,specs,worker_sha,executor_sha):
 g,w,raw=raw_from_guard(path,expected_sha)
 assert g['validator_sha256']==w['source_sha256']==worker_sha and w['resident_executor_sha256']==executor_sha and w['persistent_worker_source_sha256']==WORKER
 assert w['architecture']=='original36_compact_affine_four_groups' and w['complete_compact_candidate'] is True and w['diagnostic_only'] is False
 assert w['contract_sha256']==contract_sha and w['component_hbm_sha256']=={s.key:s.hbm_sha256 for s in specs}
 assert w['complete_image_runs']==2 and w['warm_native_ids_equal'] and w['all_models_released'] and w['architecture_coverage_verified']
 assert w['sdk_owner_tid']!=w['caller_tid'] and w['persistent_worker_state']['completed_requests']==2
 baseline,_=load_baseline(w['baseline_guard_path'],w['baseline_guard_sha256'],contract_sha)
 assert w['case']['generated_ids']==w['warm_case']['generated_ids']==baseline['case']['generated_ids']
 a=verify_counts(w['run_component_calls'][0],w['case']);b=verify_counts(w['run_component_calls'][1],w['warm_case'])
 assert a+b==w['neural_calls']==g['neural_calls'] and w['executor_stats']['peak_loaded_models']==43
 assert 0<g['conservative_sampled_memory_bytes_maximum']<=10400000000
 assert g['process_memory_observations']['actual']['owned_heap_bytes_maxima']['cma_reserved']>3*1024**3
 return dict(guard_path=str(path),guard_sha256=expected_sha,raw_path=str(raw),raw_sha256=digest(raw),contract_sha256=contract_sha,residency_sampled_verified=True,exact_peak_verified=False,heldout_quality_or_ui_approved=False)
