"""Control-only compact decoder layout/cache tests;zero HBM/neural calls.

Tests original causal/MTP visibility and cache ownership across AR1/MTP12 and
prefill256. They do not establish actual compact component construction or model
quality;the real compiled groups must still be staged and tested on S100P.
"""
from pathlib import Path
import argparse,hashlib,json,sys,time,unittest
import numpy as np
from locateanything_generation_control_v1 import step_layout
from locateanything_bpu_compact_grouped_decoder_v1 import (
 prepare_compact_group_arrays,commit_compact_group_arrays,CompactBpuDecoderGroup,CompactGroupedFullBpuGenerator)
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'

class Rope:
 def padded(self,positions,length):
  assert len(positions)<=length
  cos=np.zeros((1,length,128),np.float32);sin=np.zeros_like(cos)
  cos[0,:len(positions)]=np.asarray(positions,np.float32)[:,None]
  return cos,sin

def pair(p):
 a=np.arange(2*p*128,dtype=np.float32).reshape(2,p,128)/1000.
 return a,a.copy()*-1

def outputs(length,count):
 return [np.full((length,2048),3.,np.float32)]+[np.full((2,length,128),i+1.,np.float32) for i in range(count)]+[np.full((2,length,128),-(i+1.),np.float32) for i in range(count)]

class LayoutTests(unittest.TestCase):
 def test_ar1_places_full_original_cache_and_current_token(self):
  layout=step_layout(156,155,False);caches=tuple(pair(155) for _ in range(9));hidden=np.ones((1,2048),np.float32)
  values=prepare_compact_group_arrays(hidden,caches,layout,1,Rope())
  self.assertEqual(len(values),22);self.assertTrue(all(v.dtype==np.float32 and v.flags.c_contiguous for v in values))
  np.testing.assert_array_equal(values[0],hidden);np.testing.assert_array_equal(values[4][:,357:],caches[0][0]);self.assertTrue(np.all(values[4][:,:357]==0))
  self.assertTrue(np.all(values[3][:,:356]==-32767.));self.assertTrue(np.all(values[3][:,356:]==0.))
  self.assertEqual(float(values[1][0,0]),155.)

 def test_ar1_uses_last_real_kv_slot_without_truncation(self):
  layout=step_layout(512,511,False);caches=(pair(511),)
  values=prepare_compact_group_arrays(np.ones((1,2048),np.float32),caches,layout,1,Rope())
  self.assertTrue(np.all(values[3]==0.));np.testing.assert_array_equal(values[4][:,1:],caches[0][0])
  _,updated=commit_compact_group_arrays(outputs(1,1),caches,layout,1)
  self.assertEqual(updated[0][0].shape,(2,512,128));np.testing.assert_array_equal(updated[0][0][:,:511],caches[0][0])

 def test_prefill256_keeps_causal_mask_and_discarded_rows_neutral(self):
  layout=step_layout(155,0,False);hidden=np.ones((155,2048),np.float32)
  values=prepare_compact_group_arrays(hidden,(None,)*9,layout,256,Rope())
  self.assertTrue(np.all(values[0][:155]==1.) and np.all(values[0][155:]==0.))
  self.assertTrue(np.all(values[3][:155,:256]==-32767.))
  self.assertEqual(float(values[3][0,256]),0.);self.assertEqual(float(values[3][0,257]),-32767.)
  self.assertEqual(float(values[3][154,410]),0.);self.assertEqual(float(values[3][154,411]),-32767.)
  self.assertTrue(np.all(values[3][155:,0]==0.) and np.all(values[3][155:,1:]==-32767.))
  hidden,updated=commit_compact_group_arrays(outputs(256,9),(None,)*9,layout,256)
  self.assertEqual(hidden.shape,(155,2048));self.assertEqual(updated[8][1].shape,(2,155,128))

 def test_mtp_preserves_bidirectional_future_and_hides_previous_query(self):
  layout=step_layout(156,155,True);self.assertEqual(layout.query_length,7)
  values=prepare_compact_group_arrays(np.ones((7,2048),np.float32),(pair(155),)*9,layout,12,Rope())
  self.assertTrue(np.all(values[3][1:7,500]==-32767.))
  self.assertTrue(np.all(values[3][1:7,501:507]==0.))
  self.assertTrue(np.all(values[3][0,501:507]==-32767.))
  np.testing.assert_array_equal(values[1][:7,0],layout.positions)

 def test_mtp_commit_discards_all_six_speculative_slots(self):
  layout=step_layout(156,155,True);caches=tuple(pair(155) for _ in range(9))
  hidden,updated=commit_compact_group_arrays(outputs(12,9),caches,layout,12)
  self.assertEqual(hidden.shape,(7,2048))
  for i,(key,value) in enumerate(updated):
   self.assertEqual(key.shape,(2,156,128));np.testing.assert_array_equal(key[:,:155],caches[i][0])
   self.assertTrue(np.all(key[:,155:]==i+1.) and np.all(value[:,155:]==-(i+1.)))

 def test_committed_hidden_and_cache_own_their_memory(self):
  layout=step_layout(2,1,False);caches=(pair(1),);original=caches[0][0].copy();result=outputs(1,1)
  hidden,updated=commit_compact_group_arrays(result,caches,layout,1)
  for array in result:array.fill(-999.)
  self.assertTrue(np.all(hidden==3.) and np.all(updated[0][0][:,1:]==1.))
  np.testing.assert_array_equal(caches[0][0],original)

 def test_wrong_query_or_cache_shape_is_rejected(self):
  layout=step_layout(157,155,False)
  with self.assertRaises(AssertionError):prepare_compact_group_arrays(np.ones((2,2048),np.float32),(pair(155),)*9,layout,1,Rope())
  layout=step_layout(156,155,False)
  with self.assertRaises(AssertionError):prepare_compact_group_arrays(np.ones((1,2048),np.float32),(pair(154),)*9,layout,1,Rope())
  with self.assertRaises(AssertionError):prepare_compact_group_arrays(np.ones((1,2048),np.float64),(pair(155),)*9,layout,1,Rope())

 def test_missing_mtp_profile_fails_before_any_executor_call(self):
  group=object.__new__(CompactBpuDecoderGroup);group.specs={'ar':None,'prefill':None}
  with self.assertRaisesRegex(ValueError,'has not been compiled'):group.forward(None,None,None,None,'mtp',None)

 def test_unvalidated_native_mode_fails_before_generation(self):
  generator=object.__new__(CompactGroupedFullBpuGenerator);generator.enabled_modes=frozenset(['slow'])
  with self.assertRaisesRegex(ValueError,'has not been validated'):generator.generate(None,None,None,None,mode='hybrid')

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--report',type=Path,required=True);args=parser.parse_args()
 assert args.report.parent.resolve()==(ROOT/'test/results').resolve() and not args.report.exists()
 started=time.time();suite=unittest.defaultTestLoader.loadTestsFromTestCase(LayoutTests)
 result=unittest.TextTestRunner(verbosity=2).run(suite)
 names=['locateanything_bpu_compact_grouped_decoder_v1.py','locateanything_bpu_grouped_decoder_v1.py','locateanything_bpu_generation_v1.py','locateanything_generation_control_v1.py']
 report=dict(status='passed' if result.wasSuccessful() else 'failed',started=started,finished=time.time(),tests_run=result.testsRun,failures=[dict(test=t.id(),traceback=m) for t,m in result.failures],errors=[dict(test=t.id(),traceback=m) for t,m in result.errors],
  source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),runtime_source_sha256={n:hashlib.sha256((CODE/n).read_bytes()).hexdigest() for n in names},
  board_calls=0,neural_calls=0,whole_model_verified=False,compact_component_constructor_executed=False,release_approved=False)
 args.report.write_text(json.dumps(report,indent=2)+'\n');sys.exit(0 if result.wasSuccessful() else 1)
if __name__=='__main__':main()
