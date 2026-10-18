"""Complete compact43-context backend;actual complete residency proof is mandatory.

The original stateless backend remains unchanged. This backend has one SDK
owner thread and keeps ONLY immutable model contexts across requests.
"""
from pathlib import Path
import argparse,json,os,signal,socket,stat,threading,time
import numpy as np
from locateanything_bpu_compact_executor_v1 import CompactEvaluationBackend,ROOT,CODE,prepare_socket_path,serve_connection,BoundedRequestServer
from locateanything_persistent_request_worker_v1 import PersistentRequestWorker
from locateanything_compact_resident_executor_v1 import ExperimentalCompactResidentExecutor
from locateanything_compact_residency_admission_v1 import load_residency_evidence,digest
POLICY='persistent_compact_four_groups_heads_alias_v1'
WORKER_SHA='e20fc3989566868cc698791450d2e2ac3d06f01e1c62ac2910db30beddc6e25c'
EXECUTOR_SHA='8f1d360b5eff65d7a2ba7548d7fa4ab6d626b78868cd82385237e9827ed284b8'

def verify_sources():
 for path,expected in [(CODE/'locateanything_compact_residency_admission_v1.py','292974cb57d3530dbf0797d85e17ef84f4571af08eecc0d5c44541f84ddd902b'),(CODE/'locateanything_compact_resident_executor_v1.py',EXECUTOR_SHA),(ROOT/'ai-service/runtime/locateanything_persistent_request_worker_v1.py','1413aada82b992674080b6eaa42af370784f2f9fa2c0e7fa1e45784ece055bd5'),(ROOT/'ai-service/runtime/locateanything_bpu_compact_executor_v1.py','29f382fc00cc669ac51c7b4f739752902b3e3b871a96a0f8b6a67eb63fea6067')]:
  if digest(path)!=expected:raise ValueError('Qualified compact residency source changed')

class ResidentCompactBackend(CompactEvaluationBackend):
 def __init__(self,contract,contract_sha256,tokenizer,tokenizer_sha256,mode,maximum_seconds,resident_models,residency_proof,residency_sha256):
  verify_sources()
  if resident_models!=43 or type(resident_models) is not int or mode!='slow':raise ValueError('Only complete compact slow43 residency is supported')
  super().__init__(contract,contract_sha256,tokenizer,tokenizer_sha256,mode,maximum_seconds,1)
  if len(self.generator.specs)!=113 or self.contract['profile_sequence_capacities']!={'ar':1,'prefill':1}:raise ValueError('Residency requires all4 same-graph AR1/prefill1 groups')
  evaluation=self.contract.get('deployment',{}).get('evaluation_contract_sha256',contract_sha256)
  self.residency=load_residency_evidence(residency_proof,residency_sha256,evaluation,self.generator.specs,WORKER_SHA,EXECUTOR_SHA)
  self.resident_models=43
  self._worker=PersistentRequestWorker(lambda:ExperimentalCompactResidentExecutor(self.generator.specs,budget_bytes=7*1024**3,minimum_available_bytes=2*1024**3,maximum_models=1,experimental_residency=True))
 def health(self):
  state=self._worker.snapshot()
  return dict(super().health(),ready=state['alive'] and not state['stopping'],cache_policy=POLICY,
   residency_proof_sha256=self.residency['guard_sha256'],residency_sampled_verified=True,
   exact_memory_peak_verified=False,generation_state_retained=False,persistent_worker=state)
 def generate(self,pixels,ids,tokens,cancelled):
  started=time.monotonic()
  def operation(executor):
   before={k:executor.stats[k] for k in ['calls','loads','evictions','load_ms','inference_ms']}
   answer=self.generator.generate(executor,pixels,np.array([[16,32]],np.int64),ids,mode=self.mode,max_new_tokens=tokens,model_max_length=512,temperature=0.,maximum_seconds=self.maximum_seconds,cancelled=cancelled)
   stats={k:executor.stats[k]-v for k,v in before.items()}
   stats.update(peak_loaded_models=executor.stats['peak_loaded_models'],peak_resident_file_bytes=executor.stats['peak_resident_file_bytes'])
   generated=answer.pop('generated_ids').tolist();executor.stats['events'].clear()
   return dict(generated_ids=generated,response=self.prompt.decode(generated),**answer,executor_stats=stats,wall_seconds=time.monotonic()-started,all_models_released=False,models_retained_for_next_request=True,generation_state_retained=False,cache_policy=POLICY)
  return self._worker.execute(operation,cancelled,self.maximum_seconds)
 def close(self):self._worker.close(timeout=25)

def main():
 p=argparse.ArgumentParser();p.add_argument('--contract',type=Path,required=True);p.add_argument('--contract-sha256',required=True)
 p.add_argument('--tokenizer',type=Path,required=True);p.add_argument('--tokenizer-sha256',required=True);p.add_argument('--socket',type=Path,required=True)
 p.add_argument('--mode',choices=['slow'],default='slow');p.add_argument('--maximum-seconds',type=float,default=900);p.add_argument('--resident-models',type=int,choices=[43],default=43)
 p.add_argument('--residency-proof',type=Path,required=True);p.add_argument('--residency-proof-sha256',required=True);p.add_argument('--check-only',action='store_true');a=p.parse_args()
 backend=None;listener=None;identity=None;path=prepare_socket_path(a.socket,ROOT/'data/ai')
 try:
  backend=ResidentCompactBackend(a.contract,a.contract_sha256,a.tokenizer,a.tokenizer_sha256,a.mode,a.maximum_seconds,a.resident_models,a.residency_proof,a.residency_proof_sha256)
  if a.check_only:
   print(json.dumps(dict(status='complete_compact_resident_constructor_checked',health=backend.health(),neural_calls=0,release_approved=False)));return
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
