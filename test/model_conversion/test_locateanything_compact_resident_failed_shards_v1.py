"""Cross-request failure cleanup evidence;synthetic cache events,zero BPU calls."""
from pathlib import Path
from types import SimpleNamespace as NS
import hashlib,json,tempfile,time,unittest,copy
import locateanything_compact_resident_trace_v1 as trace
ROOT=Path('/home/sunrise/ainvr')
class FailedShardControls(unittest.TestCase):
 def test_new_failed_request_is_not_accepted_prefix(self):
  with tempfile.TemporaryDirectory(dir=ROOT/'test/results',prefix='resident-failure-') as directory:
   d=Path(directory);sizes={k:16 for k in trace.PIN_KEYS};sizes.update({'vision-prefix':32,'embedding-00':32});specs=[]
   for key,size in sizes.items():
    root=d/key;root.mkdir();(root/'model.hbm').write_bytes(b'0'*size);specs.append(NS(key=key,root=root))
   def save(name,data):
    p=d/name;p.write_text(json.dumps(data));return hashlib.sha256(p.read_bytes()).hexdigest()
   retained={k:v for k,v in sizes.items() if k!='embedding-00'}
   first=[dict(type='load',key=k,file_bytes=v,load_ms=1.) for k,v in retained.items()]
   case=dict(index=0,all_models_released=False,models_retained_for_next_request=True,generation_state_retained=False,cache_policy=trace.POLICY,initial_loaded_contexts={},retained_contexts=retained,executor_stats=dict(loads=43,evictions=0,load_ms=43.,peak_loaded_models=43,peak_resident_file_bytes=1000),events_sha256=save('case-000-events.json',first))
   during=[dict(type='evict',key='vision-prefix',file_bytes=32),dict(type='load',key='embedding-00',file_bytes=32,load_ms=2.)]
   cleanup=[dict(type='evict',key=k,file_bytes=v) for k,v in sizes.items() if k!='vision-prefix']
   progress=dict(diagnostic_only=True,terminal_output=False,all_models_released=True,initial_loaded_contexts=retained,events_file='failed-case-events.json',events_sha256=save('failed-case-events.json',during+cleanup),actual_neural_calls=2,executor_stats=dict(loads=1,evictions=44))
   report=dict(status='failed',cases=[case],all_models_released=True,sdk_owner_tid=2,caller_tid=1,final_worker_state=dict(alive=False,cached_models=0,stopping=True),current=dict(index=1),neural_calls=7,actual_neural_calls_including_failed_case=9,failed_case_progress=progress,final_release_events_sha256=save('final-release-events.json',[]))
   self.assertTrue(trace.verify_shard_cache(report,d/'status.json',specs)['all_contexts_released'])
   bad=copy.deepcopy(report);bad['actual_neural_calls_including_failed_case']=7
   with self.assertRaises(AssertionError):trace.verify_shard_cache(bad,d/'status.json',specs)
   bad=copy.deepcopy(report);bad['failed_case_progress']['events_sha256']=save('failed-case-events.json',during+cleanup[:-1])
   with self.assertRaises(AssertionError):trace.verify_shard_cache(bad,d/'status.json',specs)
if __name__=='__main__':
 out=ROOT/'test/results/locateanything-compact-resident-failed-shard-controls-v1.json';assert not out.exists()
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(FailedShardControls))
 out.write_text(json.dumps(dict(status='passed' if result.wasSuccessful() else 'failed',source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),tests_run=result.testsRun,failures=[(t.id(),m) for t,m in result.failures],errors=[(t.id(),m) for t,m in result.errors],synthetic_only=True,neural_calls=0,checked=time.time()),indent=2)+'\n');assert result.wasSuccessful()
