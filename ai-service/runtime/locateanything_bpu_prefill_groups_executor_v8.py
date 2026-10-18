# Candidate group0+group9 prefill O2 backend;not installed or constructor-tested.
# Class/protocol/owner-thread/generation bodies retained from verified v7.
# Private prefillO2 candidate only;original v6 implementation retained except explicit schema loader/pins.
# Experimental persistent static IO backend; W8 artifacts/generation are unchanged.
"""Evaluation-only complete76-program backend with bounded exact-input diagnostic capture.

Reuses the existing private framed protocol and one SDK owner thread. Model
contexts persist;image features,generation state and KV do not. No installer/UI
exposure or quality/speed/memory acceptance is implied by this source.
"""
from pathlib import Path
import argparse,json,math,os,signal,socket,stat,sys,threading,time,hashlib
import numpy as np
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'
sys.path.insert(0,str(CODE))
from locateanything_bpu_executor_v2 import prepare_socket_path,serve_connection
from locateanything_request_server import BoundedRequestServer
from locateanything_persistent_request_worker_v1 import PersistentRequestWorker
from locateanything_prompt import LocateAnythingPrompt
from locateanything_official_prefill_groups_v169 import load_official_generator
from locateanything_official_program_executor_reused_io_v1 import ReusedIOProgramExecutor as OfficialProgramExecutor

SOURCE_PINS={
 'test/model_conversion/locateanything_official_prefill_groups_v169.py':'ce065f1d3dd70e19c890bfe6b9c126dbaa454404896a885c776a5e63246a4313',
 'test/model_conversion/locateanything_prefill_g9_admission_v154.py':'4605d66d7ab5e521f34f81a03c907699f13aa641aaec708288ffbbe97de64886',
 'test/model_conversion/locateanything_official_family_prefill_optimization_v1.py':'223d0235e10fa4b13a7546d71b5b31d732af800f964748d7f24ca0614a16f3a8',
 'test/model_conversion/locateanything_prefill_component_admission_v1.py':'ba71bdf4e0c05725b511857e34e5dca43979a56b694bd7b7521b77aebb961cc0',
 'test/model_conversion/locateanything_official_program_executor_reused_io_v1.py':'f3e4770da36a491e6b5065646a798f285bdd593617ba89e7d14ccdb101121f37',
 'test/model_conversion/locateanything_reused_io_adapter_v1.py':'6e2d838bc8821c330d5660363acb76b07d9c26a08ebe832d30526addfadf0885',
 'test/model_conversion/locateanything_official_family_head_optimization_v1.py':'3ff3405fd38d2622e0cd2ac5b83f9d25b1d18450951dc32929453f5e261ce7a8',
 'test/model_conversion/locateanything_official_family_dispatch_v3.py':'ac1c51e1c6f4f2bc58ce7194d5b29258bc6483f42f77b39985037b65d63189e3',
 'test/model_conversion/locateanything_official_family_profile_optimization_v2.py':'bf3c7084ca8680ad9b55bbbd8f6857ce9ece9a813e33971d9d02ce11db01e07c',
 'test/model_conversion/locateanything_official_family_optimization_v1.py':'8d7f00d10a8e037328d29c6b9bb8f82eabcca6ac1d8b80b84c617af1b1bbcd39',
 'test/model_conversion/locateanything_official_family_profile_optimization_v1.py':'deae598806afa92ac8a114bb21edf721f4ad78dc8d8c7cb9390a1a5733941e05',
 'ai-service/runtime/locateanything_bpu_executor_v2.py':'bd99c0e13b62fdb4e22eeb2f4a24e0257d5efdf691db30a71c53d349d9b2db02',
 'ai-service/runtime/locateanything_request_server.py':'80c56b2f03482e6977eae27112fed3334f22fded7273d92894eabebba5ba74e1',
 'ai-service/runtime/locateanything_persistent_request_worker_v1.py':'1413aada82b992674080b6eaa42af370784f2f9fa2c0e7fa1e45784ece055bd5',
 'ai-service/runtime/locateanything_prompt.py':'d1adce4fa0c3bc55575b4a0505c050a96b4f633c59e2420497a3bb29b082f420',
 'test/model_conversion/locateanything_official_family_contract_v1.py':'94988129e3da8c7849316ef3f8ff372464418cdee809c32333e53927333d8c5f',
 'test/model_conversion/locateanything_official_program_executor_v1.py':'49a6b7d3ca95b354d60143e2b0400cc27966174c0ef6224af14d8347c7482d9d',
}
TOKENIZER_SHA='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40'
ARCHITECTURE='original36_qwen_moonvit27_shared_programs'

def verify_sources():
 for name,expected in SOURCE_PINS.items():
  if hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=expected:
   raise ValueError('Official evaluation backend source changed: '+name)

class OfficialEvaluationBackend:
 def __init__(self,contract,contract_sha256,tokenizer,tokenizer_sha256,mode='slow',maximum_seconds=900,trace_directory=None):
  if mode!='slow' or isinstance(maximum_seconds,bool) or not isinstance(maximum_seconds,(int,float)) or not math.isfinite(maximum_seconds) or not 0<maximum_seconds<=3600:
   raise ValueError('Invalid native generation bounds')
  if tokenizer_sha256!=TOKENIZER_SHA:raise ValueError('Original tokenizer identity required')
  verify_sources()
  self.generator,self.contract=load_official_generator(contract,contract_sha256)
  if len(self.generator.specs)!=76 or len({str(x.path) for x in self.generator.specs})!=46 or self.contract['architecture']!=ARCHITECTURE:
   raise ValueError('Complete official-family architecture required')
  self.prompt=LocateAnythingPrompt(tokenizer,tokenizer_sha256)
  self.contract_sha256=contract_sha256;self.mode=mode;self.maximum_seconds=maximum_seconds
  self.resident_models=46
  self._trace_directory=None;self._trace_lock=threading.Lock();self._trace_index=0
  if trace_directory is not None:
   trace_directory=Path(trace_directory)
   if not trace_directory.is_absolute() or trace_directory.is_symlink() or not trace_directory.is_dir() or not trace_directory.resolve().is_relative_to(Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')) or trace_directory.stat().st_uid!=os.getuid():
    raise ValueError('Evaluation trace directory identity differs')
   self._trace_directory=trace_directory.resolve()
  def factory():
   current=None
   try:
    started=time.perf_counter()
    current=OfficialProgramExecutor(self.generator.specs,budget_bytes=7*1024**3,minimum_available_bytes=2*1024**3,maximum_models=46,experimental_residency=True)
    current.preload_all()
    assert len(current.loaded)==46 and current.stats['loads']==46
    current.owner_preload_seconds=time.perf_counter()-started
    return current
   except BaseException:
    if current is not None:current.close()
    raise
  self._worker=PersistentRequestWorker(factory)

 def health(self):
  state=self._worker.snapshot()
  return dict(ready=state['alive'] and not state['stopping'],model_family='locateanything-3b',
   runtime_io_policy='persistent_static_io_v1',neural_provider='bpu',neural_cpu_fallback=False,input_size=[224,448],component_count=76,
   physical_hbm_files=46,architecture=ARCHITECTURE,generation_mode=self.mode,
   request_bound_seconds=self.maximum_seconds,resident_models=46,
   cache_policy='persistent_official_shared_programs_v1',persistent_worker=state,
   generation_state_retained=False,image_features_retained=False,
   evaluation_only=True,release_approved=False,memory_peak_verified=False,
   compiled_profiles=dict(prefill=256,decode=1,kv_capacity=512))

 def generate(self,pixels,ids,tokens,cancelled):
  started=time.monotonic();trace=None
  if self._trace_directory is not None:
   with self._trace_lock:
    index=self._trace_index;self._trace_index+=1
    if index>=16:raise RuntimeError('Evaluation trace request bound exceeded')
    trace=self._trace_directory/f'request-{index:03d}';trace.mkdir(exist_ok=False)
   np.save(trace/'pixel_values.npy',pixels,allow_pickle=False)
   np.save(trace/'input_ids.npy',ids,allow_pickle=False)
   (trace/'request.json').write_text(json.dumps(dict(tokens=tokens,contract_sha256=self.contract_sha256,mode=self.mode,prepared_pixels_sha256=hashlib.sha256((trace/'pixel_values.npy').read_bytes()).hexdigest(),input_ids_sha256=hashlib.sha256((trace/'input_ids.npy').read_bytes()).hexdigest()),indent=2)+'\n')
  def operation(executor):
   assert len(executor.loaded)==46
   before={k:executor.stats[k] for k in ['calls','loads','evictions','load_ms','inference_ms']}
   answer=self.generator.generate(executor,pixels,np.asarray([[16,32]],np.int64),ids,mode='slow',
    max_new_tokens=tokens,model_max_length=512,temperature=0.,maximum_seconds=self.maximum_seconds,cancelled=cancelled)
   stats={k:executor.stats[k]-v for k,v in before.items()}
   assert stats['loads']==stats['evictions']==0 and len(executor.loaded)==46
   stats.update(peak_loaded_models=executor.stats['peak_loaded_models'],peak_resident_file_bytes=executor.stats['peak_resident_file_bytes'],file_bytes_are_not_runtime_memory=True)
   generated=answer.pop('generated_ids').tolist();executor.stats['events'].clear()
   return dict(runtime_io_policy='persistent_static_io_v1',generated_ids=generated,response=self.prompt.decode(generated),**answer,
    executor_stats=stats,owner_preload_seconds=executor.owner_preload_seconds,
    wall_seconds=time.monotonic()-started,all_models_released=False,
    models_retained_for_next_request=True,generation_state_retained=False,image_features_retained=False,
    cache_policy='persistent_official_shared_programs_v1',evaluation_only=True,release_approved=False)
  result=self._worker.execute(operation,cancelled,self.maximum_seconds)
  if trace is not None:(trace/'result.json').write_text(json.dumps(result,indent=2)+'\n')
  return result

 def close(self):self._worker.close(timeout=25)

def main():
 p=argparse.ArgumentParser();p.add_argument('--contract',type=Path,required=True);p.add_argument('--contract-sha256',required=True)
 p.add_argument('--tokenizer',type=Path,required=True);p.add_argument('--tokenizer-sha256',required=True);p.add_argument('--socket',type=Path,required=True)
 p.add_argument('--trace-directory',type=Path);p.add_argument('--mode',choices=['slow'],default='slow');p.add_argument('--maximum-seconds',type=float,default=900);p.add_argument('--check-only',action='store_true');a=p.parse_args()
 backend=None;listener=None;identity=None;path=None
 try:
  backend=OfficialEvaluationBackend(a.contract,a.contract_sha256,a.tokenizer,a.tokenizer_sha256,a.mode,a.maximum_seconds,a.trace_directory)
  if a.check_only:
   print(json.dumps(dict(status='official_complete_evaluation_constructor_checked',health=backend.health(),neural_calls=0,release_approved=False)));return
  path=prepare_socket_path(a.socket,ROOT/'data/ai')
  stopping=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopping.set());signal.signal(signal.SIGHUP,lambda *_:stopping.set())
  listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);previous=os.umask(0o177)
  try:listener.bind(str(path))
  finally:os.umask(previous)
  identity=(path.lstat().st_dev,path.lstat().st_ino);os.chmod(path,0o600);listener.listen(8)
  BoundedRequestServer(listener,backend,serve_connection,stopping).serve()
 finally:
  if listener is not None:listener.close()
  try:
   if backend is not None:backend.close()
  finally:
   if identity is not None:
    try:
     current=path.lstat()
     if stat.S_ISSOCK(current.st_mode) and (current.st_dev,current.st_ino)==identity:path.unlink()
    except FileNotFoundError:pass

if __name__=='__main__':main()
