"""Persistent heldout evidence controls;synthetic traces,zero neural calls."""
from pathlib import Path
from types import SimpleNamespace as NS
import copy,hashlib,json,time,unittest,tempfile
import test_locateanything_compact_shards_v1 as old
import merge_locateanything_compact_heldout_v2 as merge
import locateanything_compact_resident_trace_v1 as trace
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'

def fixture():
 c,n,g,p,i=old.fixture();c.update(all_models_released=False,models_retained_for_next_request=True,generation_state_retained=False,cache_policy=trace.POLICY)
 return c,n,g,p,i

class NativeControls(old.ShardControls):
 def setUp(self):
  self.original=old.fixture;self.verify=old.verify_case;self.header_verify=old.verify_header
  old.fixture=lambda: self.updated_fixture();old.verify_case=merge.verify_case;old.verify_header=merge.verify_header
 def tearDown(self):old.fixture=self.original;old.verify_case=self.verify;old.verify_header=self.header_verify
 def updated_fixture(self):
  c,n,g,p,i=self.original();c.update(all_models_released=False,models_retained_for_next_request=True,generation_state_retained=False,cache_policy=trace.POLICY);return c,n,g,p,i
 def header(self):
  r=super().header();r.update(source_sha256=merge.WORKER_SHA,evaluation_family='compact_original36_persistent',resident_models=43);return r
 def test_fallback_or_unreleased_models_rejected(self):
  for key,value in [('neural_cpu_fallback',True),('all_models_released',True),('models_retained_for_next_request',False),('generation_state_retained',True),('cache_policy','other'),('architecture_coverage_verified',False)]:
   c,n,g,p,i=old.fixture();c[key]=value
   with self.assertRaises(AssertionError):merge.verify_case(c,n,g,p,i)

class CacheControls(unittest.TestCase):
 def setUp(self):
  self.sizes={k:1024 for k in trace.PIN_KEYS};self.sizes.update({'vision-prefix':2048,'embedding-00':2048})
  self.initial={};self.events=[dict(type='load',key=k,file_bytes=v,load_ms=1.) for k,v in self.sizes.items() if k!='embedding-00']
  self.retained={k:v for k,v in self.sizes.items() if k!='embedding-00'}
  self.case=dict(index=0,all_models_released=False,models_retained_for_next_request=True,generation_state_retained=False,cache_policy=trace.POLICY,initial_loaded_contexts={},retained_contexts=self.retained,executor_stats=dict(loads=43,evictions=0,load_ms=43.,peak_loaded_models=43,peak_resident_file_bytes=50000))
 def test_two_requests_keep_pins_replace_rotating_only(self):
  state=trace.verify_case_cache(self.case,self.events,{},self.sizes)
  e=[dict(type='evict',key='vision-prefix',file_bytes=2048),dict(type='load',key='embedding-00',file_bytes=2048,load_ms=2.)]
  c=copy.deepcopy(self.case);c.update(initial_loaded_contexts=state,retained_contexts={k:v for k,v in self.sizes.items() if k!='vision-prefix'})
  c['executor_stats'].update(loads=1,evictions=1,load_ms=2.)
  self.assertEqual(trace.verify_case_cache(c,e,state,self.sizes),c['retained_contexts'])
 def test_duplicate_load_rejected(self):
  with self.assertRaises(AssertionError):trace.replay({},self.events+[self.events[0]],self.sizes)
 def test_missing_or_wrong_sized_context_rejected(self):
  for e in [dict(type='evict',key='head-00',file_bytes=1024),dict(type='load',key='head-00',file_bytes=1025,load_ms=1.)]:
   with self.assertRaises(AssertionError):trace.replay({},[e],self.sizes)
 def test_pinned_eviction_rejected_until_cleanup(self):
  e=[dict(type='evict',key='head-00',file_bytes=1024)]
  with self.assertRaises(AssertionError):trace.replay(self.retained,e,self.sizes)
  self.assertNotIn('head-00',trace.replay(self.retained,e,self.sizes,release=True)[0])
 def test_context_limit_cannot_be_exceeded(self):
  with self.assertRaises(AssertionError):trace.replay(self.retained,[dict(type='load',key='embedding-00',file_bytes=2048,load_ms=1.)],self.sizes)
 def test_release_cannot_load_models(self):
  with self.assertRaises(AssertionError):trace.replay({},self.events,self.sizes,release=True)
 def test_cross_case_state_or_load_count_tampering_rejected(self):
  for mode in ['state','loads','bytes','pins']:
   c=copy.deepcopy(self.case)
   if mode=='state':c['initial_loaded_contexts']={'head-00':1024}
   if mode=='loads':c['executor_stats']['loads']-=1
   if mode=='bytes':c['retained_contexts']['head-00']+=1
   if mode=='pins':del c['retained_contexts']['head-00']
   with self.assertRaises(AssertionError):trace.verify_case_cache(c,self.events,{},self.sizes)
 def test_failed_request_cleanup_and_accepted_prefix_cleanup(self):
  with tempfile.TemporaryDirectory(dir=ROOT/'test/results',prefix='resident-shard-control-') as d:
   d=Path(d);specs=[]
   for k,size in self.sizes.items():
    root=d/k;root.mkdir();(root/'model.hbm').write_bytes(b'0'*size);specs.append(NS(key=k,root=root))
   def save(name,value):
    p=d/name;p.write_text(json.dumps(value));return merge.digest(p)
   c=copy.deepcopy(self.case);c['events_sha256']=save('case-000-events.json',self.events)
   release=[dict(type='evict',key=k,file_bytes=v) for k,v in self.retained.items()]
   common=dict(cases=[c],all_models_released=True,sdk_owner_tid=2,caller_tid=1,final_worker_state=dict(alive=False,cached_models=0,stopping=True))
   good=dict(common,status='completed',final_release_events_sha256=save('final-release-events.json',release))
   self.assertTrue(trace.verify_shard_cache(good,d/'status.json',specs)['cache_lifecycle_verified'])
   # An exception after the accepted case is written duplicates its event prefix.
   failed=dict(common,status='failed',current=dict(index=0),neural_calls=7,actual_neural_calls_including_failed_case=7,final_release_events_sha256=save('final-release-events.json',[]))
   failed['failed_case_progress']=dict(diagnostic_only=True,terminal_output=False,all_models_released=True,initial_loaded_contexts={},events_file='failed-case-events.json',events_sha256=save('failed-case-events.json',self.events+release),actual_neural_calls=7)
   self.assertTrue(trace.verify_shard_cache(failed,d/'status.json',specs)['all_contexts_released'])
   failed['actual_neural_calls_including_failed_case']=14
   with self.assertRaises(AssertionError):trace.verify_shard_cache(failed,d/'status.json',specs)

if __name__=='__main__':
 out=ROOT/'test/results/locateanything-compact-resident-shard-controls-v2.json';assert not out.exists()
 suite=unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(c) for c in [NativeControls,CacheControls]])
 result=unittest.TextTestRunner(verbosity=2).run(suite)
 out.write_text(json.dumps(dict(status='passed' if result.wasSuccessful() else 'failed',tests_run=result.testsRun,errors=[(t.id(),m) for t,m in result.errors],failures=[(t.id(),m) for t,m in result.failures],source_sha256=merge.digest(__file__),merger_sha256=merge.digest(CODE/'merge_locateanything_compact_heldout_v2.py'),trace_sha256=merge.digest(CODE/'locateanything_compact_resident_trace_v1.py'),synthetic_controls_only=True,neural_calls=0,checked=time.time()),indent=2)+'\n');assert result.wasSuccessful()
