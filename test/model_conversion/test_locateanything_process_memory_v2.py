"""Real bounded CPU-process ownership and synthetic heap/smaps parser controls.

No BPU/neural work and no production process signalling or memory claim.
"""
from pathlib import Path
import argparse,hashlib,json,os,select,subprocess,sys,time,unittest
from locateanything_process_memory_v1 import identity,find_owned_workers,require_owned,sample_owned_process,parse_owned_heap,parse_smaps,accumulate
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'

class MemoryControls(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.path=str(Path(__file__).resolve());python=ROOT/'ai-service/runtime/.venv-locateanything/bin/python'
  cls.child=subprocess.Popen(['runuser','-u','sunrise','--',str(python),cls.path,'--memory-child'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
  assert select.select([cls.child.stdout],[],[],5)[0],'Bounded memory child did not become ready'
  cls.ready=json.loads(cls.child.stdout.readline());cls.ident=identity(cls.ready['pid'])
  assert cls.ident['uid']==1000 and cls.ident['pgid']==cls.child.pid
 @classmethod
 def tearDownClass(cls):
  cls.child.communicate(timeout=10);assert cls.child.returncode==0
 def sample(self,**changes):
  args=dict(pid=self.ready['pid'],start_ticks=self.ident['start_ticks'],pgid=self.child.pid,argument=self.path,uid=1000,smaps=True);args.update(changes)
  return sample_owned_process(**args)
 def test_live_owned_uid1000_cpu_rss_hwm_and_smaps(self):
  s=self.sample();self.assertGreaterEqual(s['rss_bytes'],64*1024**2);self.assertGreaterEqual(s['rss_high_water_bytes'],s['rss_bytes'])
  self.assertGreaterEqual(s['smaps']['anonymous_rss_bytes'],64*1024**2)
  self.assertLess(abs(s['smaps']['total_rss_bytes']-s['rss_bytes']),4*1024**2)
 def test_reused_pid_identity_rejected(self):
  with self.assertRaises(AssertionError):self.sample(start_ticks=str(int(self.ident['start_ticks'])+1))
 def test_wrong_process_group_rejected(self):
  with self.assertRaises(AssertionError):self.sample(pgid=self.child.pid+1)
 def test_wrong_worker_argument_rejected(self):
  with self.assertRaises(AssertionError):self.sample(argument='/home/sunrise/ainvr/test/NOT-THIS-WORKER.py')
 def test_wrong_account_rejected(self):
  with self.assertRaises(AssertionError):self.sample(uid=0)
 def test_actual_worker_discovery_without_children_interface(self):
  found=find_owned_workers(self.child.pid,self.path,1000)
  self.assertEqual([v['pid'] for v in found],[self.ready['pid']])
  self.assertEqual(find_owned_workers(self.child.pid,'/NOT-THIS-WORKER.py',1000),[])
 def test_heap_rows_are_exact_owner_and_heap_only(self):
  t='cma_reserved client 111 1024\ncma_reserved client 222 8192\ncarveout client 111 4096\ncma_reserved x 111 2048\nallocations (0)\ncma_reserved x 111 99999\n'
  self.assertEqual(parse_owned_heap(t,'cma_reserved',111),3072);self.assertEqual(parse_owned_heap(t,'carveout',111),4096)
 def test_smaps_keeps_device_domains_separate(self):
  t='1000-2000 rw-p 00000000 00:00 0\nRss: 4 kB\nPss: 4 kB\nVmFlags: rd wr ac\n2000-3000 rw-s 00000000 00:01 1 /dev/ion\nRss: 8 kB\nPss: 8 kB\nVmFlags: rd wr io pf\n3000-4000 r-xp 00000000 00:02 2 /usr/lib/a.so\nRss: 12 kB\nPss: 6 kB\nVmFlags: rd ex\n'
  s=parse_smaps(t);self.assertEqual(s['anonymous_rss_bytes'],4096);self.assertEqual(s['device_or_pfnmap_rss_bytes'],8192)
  self.assertEqual(s['file_rss_bytes'],12288);self.assertEqual(s['total_rss_bytes'],24576);self.assertEqual(s['total_pss_bytes'],18432)
 def test_accumulation_never_claims_total_or_exact_peak(self):
  a=self.sample();s=accumulate({},a);self.assertEqual(s['sample_count'],1)
  for key in ['exact_allocator_peak_verified','deduplicated_total_memory_verified','memory_requirement_passed']:self.assertFalse(s[key])

if __name__=='__main__':
 if '--memory-child' in sys.argv:
  assert os.getuid()==1000;memory=bytearray(64*1024**2)
  for i in range(0,len(memory),4096):memory[i]=1
  print(json.dumps({'pid':os.getpid()}),flush=True);time.sleep(4);sys.exit(0)
 out=ROOT/'test/results/locateanything-process-memory-controls-v2.json';assert not out.exists();begin=time.time()
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(MemoryControls))
 d=dict(status='passed' if result.wasSuccessful() else 'failed',started=begin,finished=time.time(),tests_run=result.testsRun,
  failures=[dict(test=t.id(),traceback=m) for t,m in result.failures],errors=[dict(test=t.id(),traceback=m) for t,m in result.errors],
  source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),memory_sampler_sha256=hashlib.sha256((CODE/'locateanything_process_memory_v1.py').read_bytes()).hexdigest(),
  actual_owned_uid1000_cpu_process_tested=True,synthetic_ion_parser_cases=True,actual_neural_calls=0,production_processes_signalled=False,full_model_memory_requirement_passed=False)
 out.write_text(json.dumps(d,indent=2)+'\n');assert result.wasSuccessful()
