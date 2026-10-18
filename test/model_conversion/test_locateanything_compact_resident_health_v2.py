from pathlib import Path
import sys,unittest,copy,hashlib,json,os,socket,struct,threading,tempfile
ROOT=Path('/home/sunrise/ainvr');sys.path.insert(0,str(ROOT/'ai-service/runtime'))
from locateanything_compact_resident_health_v2 import validate_health,request_health
CONTRACT='a'*64;PROOF='b'*64
class Controls(unittest.TestCase):
 def payload(self):return dict(ok=True,schema_version=1,contract_sha256=CONTRACT,ready=True,model_family='locateanything-3b',neural_provider='bpu',neural_cpu_fallback=False,input_size=[224,448],component_count=113,generation_mode='slow',architecture='original36_compact_affine_four_groups',evaluation_only=True,resident_models=43,request_bound_seconds=900,enabled_generation_modes=['slow'],cache_policy='persistent_compact_four_groups_heads_alias_v1',residency_proof_sha256=PROOF,residency_sampled_verified=True,generation_state_retained=False,persistent_worker=dict(alive=True,stopping=False,cached_models=0))
 def check(self,v,**kw):
  args=dict(contract_sha256=CONTRACT,mode='slow',maximum_seconds=900,component_count=113,resident_models=43,residency_sha256=PROOF);args.update(kw);return validate_health(v,**args)
 def test_valid_declared_synthetic_health(self):self.assertEqual(self.check(self.payload()),self.payload())
 def test_wrong_residency_proof_rejects(self):
  with self.assertRaises(ValueError):self.check(self.payload(),residency_sha256='c'*64)
 def test_wrong_cache_policy_rejects(self):
  v=self.payload();v['cache_policy']='one_or_two_request_owned_contexts_close_at_request_end'
  with self.assertRaises(ValueError):self.check(v)
 def test_generation_state_retention_rejects(self):
  v=self.payload();v['generation_state_retained']=True
  with self.assertRaises(ValueError):self.check(v)
 def test_dead_or_stopping_owner_rejects(self):
  for change in [dict(alive=False),dict(stopping=True)]:
   v=self.payload();v['persistent_worker'].update(change)
   with self.assertRaises(ValueError):self.check(v)
 def test_invalid_cached_context_count_rejects(self):
  for count in [True,-1,44]:
   v=self.payload();v['persistent_worker']['cached_models']=count
   with self.assertRaises(ValueError):self.check(v)
 def test_incomplete_or_other_mode_rejects(self):
  for change in [dict(component_count=117),dict(mode='hybrid'),dict(resident_models=1),dict(resident_models=True)]:
   with self.assertRaises(ValueError):self.check(self.payload(),**change)
 def test_unverified_or_fallback_flags_reject(self):
  for change in [dict(residency_sampled_verified=False),dict(neural_cpu_fallback=True),dict(evaluation_only=1)]:
   v=self.payload();v.update(change)
   with self.assertRaises(ValueError):self.check(v)
 def test_real_uid1000_private_socket_with_fragmented_synthetic_response(self):
  with tempfile.TemporaryDirectory(dir=ROOT/'data/ai',prefix='resident-health-control-') as d:
   os.chown(d,1000,1000);pid=os.fork()
   if pid==0:
    try:
     os.setgroups([]);os.setgid(1000);os.setuid(1000);path=Path(d)/'p.sock';listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(str(path));os.chmod(path,0o600);listener.listen(1);errors=[]
     def server():
      try:
       with listener.accept()[0] as c:
        def receive(n):
         b=b''
         while len(b)<n:b+=c.recv(n-len(b))
         return b
        size=struct.unpack('!I',receive(4))[0];q=json.loads(receive(size));assert q['operation']=='health' and q['input_bytes']==0
        data=json.dumps(self.payload()).encode();frame=struct.pack('!I',len(data))+data
        for offset in range(0,len(frame),7):c.sendall(frame[offset:offset+7])
      except BaseException as e:errors.append(e)
     t=threading.Thread(target=server);t.start();value=request_health(path,CONTRACT,'slow',900,113,43,PROOF);t.join(3);assert not t.is_alive() and not errors and value['resident_models']==43
     listener.close();path.unlink();os._exit(0)
    except BaseException:os._exit(1)
   _,status=os.waitpid(pid,0);self.assertEqual(os.waitstatus_to_exitcode(status),0)
if __name__=='__main__':
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Controls));p=ROOT/'test/results/locateanything-compact-resident-health-controls-v2.json';assert not p.exists()
 p.write_text(json.dumps(dict(status='passed' if result.wasSuccessful() else 'failed',tests=result.testsRun,neural_calls=0,synthetic_health=True,actual_uid1000_private_transport_tested=True,model_ready_or_deployed=False,source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()),indent=2)+'\n');assert result.wasSuccessful()
