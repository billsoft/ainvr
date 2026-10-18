"""Synthetic shard-evidence rejection controls;no model accuracy or BPU claims."""
from pathlib import Path
from types import SimpleNamespace as NS
import copy,hashlib,json,time,unittest
from merge_locateanything_compact_heldout_v1 import verify_case,verify_header,WORKER_SHA,REFERENCE_SHA,POLICY_SHA
from test_locateanything_compact_prefill_chunks_v1 import coverage_fixture
from locateanything_compact_quality_v1 import verify_slow_call_coverage,parse_response

ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'

def fixture():
 g,counts,answer,ids=coverage_fixture(12);g.token_ids={'im_end_token_id':2}
 for i,step in enumerate(answer['steps']):
  step.update(pattern='im_end' if i==1 else 'continue_ar',past_length=0 if i==0 else 155,kept_cache_length=155+i,seconds=.01)
 response='<box>none</box>';parsed=parse_response(response)
 native=dict(index=0,image_id=1144,query='person',kind='box',response=response,boxes=[],points=[])
 prompt=NS(decode=lambda values:response if values==[1,2] else 'CHANGED_TOKEN_TEXT')
 c=dict(index=0,image_id=1144,query='person',kind='box',response=response,reference=copy.deepcopy(parsed),candidate=copy.deepcopy(parsed),
  generated_ids=[1,2],token_logprobs=[-.1,-.2],terminal=True,stopped_at_token_limit=False,all_models_released=True,
  architecture_coverage_verified=True,executor_stats=dict(calls=sum(counts.values()),loads=3),successful_component_calls=dict(counts),
  model_loads=3,wall_seconds=.2,**answer)
 c['architecture_coverage']=verify_slow_call_coverage(g,counts,c,ids)
 return c,native,g,prompt,ids

class ShardControls(unittest.TestCase):
 def test_consistent_synthetic_trace_only(self):self.assertTrue(verify_case(*fixture())['verified'])
 def test_missing_chunk_even_when_totals_rewritten(self):
  c,n,g,p,i=fixture();key=g.decoder.groups[1].specs['prefill'].key;c['successful_component_calls'][key]-=1
  c['bpu_calls']-=1;c['executor_stats']['calls']-=1
  with self.assertRaises(AssertionError):verify_case(c,n,g,p,i)
 def test_changed_reference_boxes(self):
  c,n,g,p,i=fixture();c['reference']['boxes']=[[1,2,3,4]]
  with self.assertRaises(AssertionError):verify_case(c,n,g,p,i)
 def test_changed_query_or_case_identity(self):
  for key,value in [('query','car'),('image_id',2444),('kind','point'),('index',1)]:
   c,n,g,p,i=fixture();c[key]=value
   with self.assertRaises(AssertionError):verify_case(c,n,g,p,i)
 def test_tokens_must_equal_each_accepted_step(self):
  c,n,g,p,i=fixture();c['steps'][0]['accepted_tokens']=[3]
  with self.assertRaises(AssertionError):verify_case(c,n,g,p,i)
 def test_decoded_text_must_match_ids(self):
  c,n,g,p,i=fixture();c['response']='<box><1><2><3><4></box>';c['candidate']=parse_response(c['response'])
  with self.assertRaises(AssertionError):verify_case(c,n,g,p,i)
 def test_terminal_requires_native_eos_pattern(self):
  c,n,g,p,i=fixture();c['steps'][-1]['pattern']='continue_ar'
  with self.assertRaises(AssertionError):verify_case(c,n,g,p,i)
 def test_wrong_retained_cache_length(self):
  for key in ['past_length','kept_cache_length']:
   c,n,g,p,i=fixture();c['steps'][1][key]-=1
   with self.assertRaises(AssertionError):verify_case(c,n,g,p,i)
 def test_fallback_or_unreleased_models_rejected(self):
  for key,value in [('neural_cpu_fallback',True),('all_models_released',False),('architecture_coverage_verified',False)]:
   c,n,g,p,i=fixture();c[key]=value
   with self.assertRaises(AssertionError):verify_case(c,n,g,p,i)
 def test_coverage_flag_cannot_replace_call_evidence(self):
  c,n,g,p,i=fixture();c['architecture_coverage']['decoder_layers']=35
  with self.assertRaises(AssertionError):verify_case(c,n,g,p,i)
 def header(self):
  c,*_=fixture()
  return dict(status='completed',evaluation_family='compact_original36',source_sha256=WORKER_SHA,contract_sha256='a'*64,
   reference_sha256=REFERENCE_SHA,quality_policy_sha256=POLICY_SHA,constructor_validated=True,component_count=113,check_only=False,
   runtime_uid=1000,mode='slow',resident_models=1,required_cases=72,selected_indices=[0],cases=[c],neural_calls=c['bpu_calls'],
   actual_complete_architecture_generation_executed=True)
 def test_header_does_not_accept_check_only_or_changed_source(self):
  for key,value in [('check_only',True),('source_sha256','0'*64),('constructor_validated',False),('component_count',213),('reference_sha256','0'*64)]:
   r=self.header();r[key]=value
   with self.assertRaises(AssertionError):verify_header(r,'a'*64,113)
 def test_failed_later_shard_keeps_successful_prefix_only(self):
  r=self.header();r.update(status='failed',selected_indices=[0,1]);self.assertEqual(verify_header(r,'a'*64,113),[0])
  r['cases'][0]['index']=1
  with self.assertRaises(AssertionError):verify_header(r,'a'*64,113)
 def test_real_official_smoke_cannot_be_compact_quality(self):
  r=json.loads((ROOT/'test/results/official-qwen-omni-benchmark-guard-v1.json').read_text())
  with self.assertRaises((AssertionError,KeyError)):verify_header(r,'a'*64,113)

if __name__=='__main__':
 out=ROOT/'test/results/locateanything-compact-shard-controls-v1.json';assert not out.exists();started=time.time()
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ShardControls))
 d=dict(status='passed' if result.wasSuccessful() else 'failed',started=started,finished=time.time(),tests_run=result.testsRun,
  failures=[dict(test=t.id(),traceback=m) for t,m in result.failures],errors=[dict(test=t.id(),traceback=m) for t,m in result.errors],
  source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),merger_sha256=hashlib.sha256((CODE/'merge_locateanything_compact_heldout_v1.py').read_bytes()).hexdigest(),
  synthetic_trace_controls_only=True,actual_neural_calls=0,actual_compact_constructor_executed=False,actual_independent_final_quality_measured=False,release_approved=False)
 out.write_text(json.dumps(d,indent=2)+'\n');assert result.wasSuccessful()
