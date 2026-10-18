from pathlib import Path
import sys,threading,time,unittest,json,hashlib
ROOT=Path('/home/sunrise/ainvr');sys.path.insert(0,str(ROOT/'ai-service/runtime'))
from locateanything_persistent_request_worker_v1 import PersistentRequestWorker
class FakeExecutor:
 def __init__(self,events):self.events=events;self.owner=threading.get_ident();self.loaded={};self.inflight=False;events.append(('create',self.owner))
 def run_ordered(self,key,values):
  assert threading.get_ident()==self.owner;self.loaded[key]=1;self.events.append(('run',self.owner));return values
 def close(self):
  assert threading.get_ident()==self.owner and not self.inflight;self.loaded.clear();self.events.append(('close',self.owner))
class Controls(unittest.TestCase):
 def setUp(self):self.events=[];self.worker=PersistentRequestWorker(lambda:FakeExecutor(self.events))
 def tearDown(self):self.worker.close();self.assertFalse(self.worker.snapshot()['alive'])
 def test_repeated_requests_retain_one_executor_on_owner_thread(self):
  values=[]
  for x in [1,2]:
   t=threading.Thread(target=lambda x=x:values.append(self.worker.execute(lambda e:e.run_ordered('m',[x]),None,2)));t.start();t.join(3);self.assertFalse(t.is_alive())
  self.assertEqual(values,[[1],[2]]);self.assertEqual([x[0] for x in self.events],['create','run','run'])
  self.assertEqual(len({x[1] for x in self.events}),1);self.assertEqual(self.worker.snapshot()['cached_models'],1)
 def test_failure_releases_then_next_request_creates_fresh_executor(self):
  def fail(e):e.run_ordered('m',[1]);raise ValueError('test')
  with self.assertRaises(ValueError):self.worker.execute(fail,None,2)
  self.assertEqual(self.events[-1][0],'close');self.assertEqual(self.worker.snapshot()['cached_models'],0)
  self.assertEqual(self.worker.execute(lambda e:e.run_ordered('m',[2]),None,2),[2]);self.assertEqual(sum(x[0]=='create' for x in self.events),2)
 def test_cancelled_request_never_constructs_sdk(self):
  with self.assertRaises(RuntimeError):self.worker.execute(lambda e:e.run_ordered('m',[]),lambda:True,2)
  self.assertEqual(self.events,[])
 def test_deadline_after_synchronous_call_releases_on_owner(self):
  def op(e):time.sleep(.03);return e.run_ordered('m',[])
  with self.assertRaises(TimeoutError):self.worker.execute(op,None,.01)
  self.assertEqual([x[0] for x in self.events],['create','close'])
 def test_second_concurrent_request_rejected_without_second_executor(self):
  entered=threading.Event();release=threading.Event();errors=[]
  def op(e):entered.set();assert release.wait(2);return e.run_ordered('m',[1])
  def run():
   try:self.worker.execute(op,None,2)
   except BaseException as error:errors.append(error)
  t=threading.Thread(target=run);t.start();self.assertTrue(entered.wait(1))
  try:
   with self.assertRaises(RuntimeError):self.worker.execute(lambda e:None,None,2)
  finally:release.set();t.join(3)
  self.assertFalse(errors);self.assertEqual(sum(x[0]=='create' for x in self.events),1)
 def test_close_never_unloads_under_an_outstanding_call(self):
  entered=threading.Event();release=threading.Event();errors=[]
  def op(e):
   e._executor.inflight=True;entered.set();assert release.wait(2);e._executor.inflight=False;return 1
  def run():
   try:self.worker.execute(op,None,2)
   except BaseException as error:errors.append(error)
  t=threading.Thread(target=run);t.start();self.assertTrue(entered.wait(1))
  try:
   with self.assertRaises(TimeoutError):self.worker.close(.01)
   self.assertFalse(any(x[0]=='close' for x in self.events))
  finally:release.set();t.join(3)
  self.assertTrue(errors);self.worker.close();self.assertEqual(self.events[-1][0],'close')
 def test_invalid_request_bounds_reject(self):
  for x in [True,0,-1,float('nan'),float('inf'),3601]:
   with self.assertRaises(ValueError):self.worker.execute(lambda e:None,None,x)
 def test_stopped_worker_rejects_new_request(self):
  self.worker.close()
  with self.assertRaises(RuntimeError):self.worker.execute(lambda e:None,None,2)
if __name__=='__main__':
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Controls))
 p=ROOT/'test/results/locateanything-persistent-worker-controls-v1.json';assert not p.exists()
 p.write_text(json.dumps(dict(status='passed' if result.wasSuccessful() else 'failed',tests=result.testsRun,neural_calls=0,real_threads=True,fake_executor=True,hardware_or_model_verified=False,source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()),indent=2)+'\n');assert result.wasSuccessful()
