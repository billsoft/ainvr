"""Compact health identity/private-transport controls only;not model readiness proof."""
from pathlib import Path
import copy,hashlib,json,os,socket,stat,struct,subprocess,sys,threading,time,unittest
ROOT=Path('/home/sunrise/ainvr');RUNTIME=ROOT/'ai-service/runtime';sys.path.insert(0,str(RUNTIME))
import locateanything_compact_executor_health_v1 as health
SHA='0'*64

def fixture(count=113,resident=1):
 return dict(ok=True,schema_version=1,contract_sha256=SHA,ready=True,model_family='locateanything-3b',neural_provider='bpu',neural_cpu_fallback=False,
  input_size=[224,448],component_count=count,generation_mode='slow',request_bound_seconds=120,resident_models=resident,
  architecture='original36_compact_affine_four_groups',evaluation_only=True,enabled_generation_modes=['slow'])

def transport_child():
 assert os.getuid()==1000;path=ROOT/'data/ai/locateanything-compact-health-control-v1.sock';assert not path.exists() and not path.is_symlink()
 errors=[];identity=None;value=fixture()
 try:
  with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as server:
   server.bind(str(path));identity=(path.lstat().st_dev,path.lstat().st_ino);os.chmod(path,0o644);server.listen(1);server.settimeout(3)
   try:health.request_health(path,SHA,'slow',120,113,1)
   except ValueError:pass
   else:raise AssertionError('Unsafe endpoint permissions were accepted')
   os.chmod(path,0o600)
   def respond():
    try:
     conn,_=server.accept()
     with conn:
      conn.settimeout(2)
      def exact(n):
       result=b''
       while len(result)<n:
        b=conn.recv(n-len(result));assert b;result+=b
       return result
      size=struct.unpack('!I',exact(4))[0];request=json.loads(exact(size))
      assert request==dict(schema_version=1,operation='health',contract_sha256=SHA,input_bytes=0)
      raw=json.dumps(value).encode();conn.sendall(struct.pack('!I',len(raw))+raw)
    except BaseException as error:errors.append(type(error).__name__)
   thread=threading.Thread(target=respond,daemon=True);thread.start();observed=health.request_health(path,SHA,'slow',120,113,1)
   thread.join(timeout=4);assert not thread.is_alive() and not errors and observed==value
 finally:
  if identity is not None:
   now=path.lstat();assert stat.S_ISSOCK(now.st_mode) and (now.st_dev,now.st_ino)==identity;path.unlink()
 print(json.dumps(dict(status='passed',uid=os.getuid(),synthetic_readiness_fixture=True,actual_neural_calls=0,actual_model_constructor=False)))

class HealthControls(unittest.TestCase):
 def check(self,value,count=113,resident=1,mode='slow'):return health.validate_health(value,SHA,mode,120,count,resident)
 def test_declared_113_and_117_layouts(self):
  for count in [113,117]:
   for resident in [1,2]:self.assertEqual(self.check(fixture(count,resident),count,resident)['component_count'],count)
 def test_component_count_must_match_declared_contract(self):
  for count in [112,117,213]:
   value=fixture();value['component_count']=count
   with self.assertRaises(ValueError):self.check(value)
 def test_architecture_cannot_be_inferred_from_count(self):
  for architecture in [None,'original36_official_four_groups','individual_original36']:
   value=fixture();value['architecture']=architecture
   with self.assertRaises(ValueError):self.check(value)
 def test_common_identity_and_backend_flags(self):
  for key,value in [('ready',False),('ready',1),('ok',1),('neural_provider','cpu'),('neural_cpu_fallback',True),('evaluation_only',False),('contract_sha256','1'*64),('request_bound_seconds',121),('input_size',[448,224]),('generation_mode','fast')]:
   with self.subTest(key=key,value=value):
    candidate=fixture();candidate[key]=value
    with self.assertRaises(ValueError):self.check(candidate)
 def test_residency_must_match_declared_unit(self):
  for resident in [True,2,43]:
   candidate=fixture();candidate['resident_models']=resident
   with self.assertRaises(ValueError):self.check(candidate)
 def test_mode_list_requires_structured_compiled_modes(self):
  for modes in ['slow',[],['slow','slow'],['slow','unsupported'],[1],None]:
   candidate=fixture();candidate['enabled_generation_modes']=modes
   with self.assertRaises(ValueError):self.check(candidate)
 def test_mtp_requires_117_profile_layout(self):
  candidate=fixture();candidate.update(generation_mode='hybrid',enabled_generation_modes=['slow','hybrid'])
  with self.assertRaises(ValueError):self.check(candidate,mode='hybrid')
  candidate['component_count']=117;self.assertEqual(self.check(candidate,117,mode='hybrid')['component_count'],117)
 def test_bad_declared_counts_rejected(self):
  for count,resident in [(213,1),(True,1),(113,True),(113,43)]:
   with self.assertRaises(ValueError):self.check(fixture(),count,resident)
 def test_actual_uid1000_private_socket_framing(self):
  process=subprocess.run(['runuser','-u','sunrise','--',str(RUNTIME/'.venv-locateanything/bin/python'),str(Path(__file__).resolve()),'--transport-child'],capture_output=True,text=True,timeout=10)
  self.assertEqual(process.returncode,0,process.stderr);value=json.loads(process.stdout);self.assertEqual(value['uid'],1000);self.assertTrue(value['synthetic_readiness_fixture'])
 def test_legacy_helper_unchanged(self):self.assertEqual(hashlib.sha256((RUNTIME/'locateanything_executor_health.py').read_bytes()).hexdigest(),'429a583102d88e1224c1ced8b4dece1e03cfcfaad8a3085e7730059e2b7b29be')

if __name__=='__main__':
 if '--transport-child' in sys.argv:transport_child();sys.exit(0)
 out=ROOT/'test/results/locateanything-compact-health-controls-v1.json';assert not out.exists();begin=time.time();result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(HealthControls))
 r=dict(status='passed' if result.wasSuccessful() else 'failed',started=begin,finished=time.time(),tests_run=result.testsRun,
  failures=[dict(test=t.id(),traceback=m) for t,m in result.failures],errors=[dict(test=t.id(),traceback=m) for t,m in result.errors],
  source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),health_helper_sha256=hashlib.sha256((RUNTIME/'locateanything_compact_executor_health_v1.py').read_bytes()).hexdigest(),
  synthetic_readiness_fixture=True,actual_uid1000_transport_tested=True,actual_complete_constructor=False,neural_calls=0,model_installed=False,production_services_changed=False,ui_enabled=False)
 out.write_text(json.dumps(r,indent=2)+'\n');assert result.wasSuccessful()
