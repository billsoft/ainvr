"""Local complete-model BPU executor. No neural or image-processing CPU fallback.

The socket becomes ready only after the complete immutable213-component
contract validates. The caller supplies hardware-prepared RGB CHW pixels.
Tokenization, patch array placement, grammar and JSON are CPU control only.
"""
from pathlib import Path
import argparse,json,os,signal,socket,stat,struct,sys,time
import numpy as np
from locateanything_prompt import LocateAnythingPrompt,patchify_prepared_chw

INPUT_BYTES=3*224*448*4
MAX_HEADER=65536
MAX_RESPONSE=1024*1024
RUNTIME_ROOT=Path('/home/sunrise/ainvr/test/model_conversion')

def receive_exact(connection,size):
 parts=[];remaining=size
 while remaining:
  part=connection.recv(min(remaining,1024*1024))
  if not part:raise ConnectionError('Request ended before complete payload')
  parts.append(part);remaining-=len(part)
 return b''.join(parts)

def send_json(connection,value):
 data=json.dumps(value,separators=(',',':'),allow_nan=False).encode('utf-8')
 if not 0<len(data)<=MAX_RESPONSE:raise ValueError('Response exceeds protocol capacity')
 connection.sendall(struct.pack('!I',len(data))+data)

def peer_disconnected(connection):
 try:return connection.recv(1,socket.MSG_PEEK|socket.MSG_DONTWAIT)==b''
 except BlockingIOError:return False
 except OSError:return True

def prepare_socket_path(value,root):
 """Recover only a stale private socket in the declared runtime directory."""
 path=Path(value).absolute()
 if path.parent.resolve()!=root.resolve() or path.is_symlink() or len(str(path).encode())>=108:
  raise ValueError('Socket must be a direct child of the authorized AI runtime directory')
 try:before=path.lstat()
 except FileNotFoundError:return path
 if not stat.S_ISSOCK(before.st_mode) or before.st_uid!=os.getuid() or stat.S_IMODE(before.st_mode)!=0o600:
  raise ValueError('Existing endpoint is not an owned private runtime socket')
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as probe:
  probe.settimeout(.25)
  try:probe.connect(str(path))
  except FileNotFoundError:return path
  except ConnectionRefusedError:
   try:current=path.lstat()
   except FileNotFoundError:return path
   if ((current.st_dev,current.st_ino)!=(before.st_dev,before.st_ino) or
       not stat.S_ISSOCK(current.st_mode) or current.st_uid!=os.getuid() or stat.S_IMODE(current.st_mode)!=0o600):
    raise ValueError('Runtime endpoint changed during stale-socket inspection')
   path.unlink();return path
  except OSError as error:raise ValueError('Cannot prove the runtime endpoint is stale') from error
 raise ValueError('A runtime listener is already active at this endpoint')

def request_bound_executor_type(executor_type,cancelled,deadline):
 """Keep request cancellation/deadline checks around each synchronous SDK call.

 This wraps control boundaries only;the parent executes every neural operation.
 An in-flight SDK call cannot be interrupted safely by this cooperative bound.
 """
 class RequestBoundExecutor(executor_type):
  def run_ordered(self,key,values):
   def check():
    if cancelled is not None and cancelled():raise RuntimeError('Inference request cancelled')
    if time.monotonic()>deadline:raise TimeoutError('Inference request exceeded its explicit bound')
   check();result=super().run_ordered(key,values);check();return result
 return RequestBoundExecutor

def serve_connection(connection,backend):
 """One bounded framed request. Also exercised with explicit control-only probes."""
 connection.settimeout(10)
 try:
  length=struct.unpack('!I',receive_exact(connection,4))[0]
  if not 0<length<=MAX_HEADER:raise ValueError('Invalid request header length')
  request=json.loads(receive_exact(connection,length))
  if not isinstance(request,dict) or request.get('schema_version')!=1:raise ValueError('Unsupported protocol version')
  operation=request.get('operation')
  if operation not in ('health','validate','generate'):raise ValueError('Unsupported operation')
  if request.get('contract_sha256')!=backend.contract_sha256:raise ValueError('Executor/model contract mismatch')
  if operation=='health':
   if request.get('input_bytes',0)!=0:raise ValueError('Health does not accept pixels')
   result=backend.health()
  else:
   ids=backend.prompt.encode(request.get('description'),request.get('tokens',128),backend.mode)
   if operation=='validate':
    if request.get('input_bytes',0)!=0:raise ValueError('Prompt validation does not accept pixels')
    result=dict(valid=True,prompt_tokens=len(ids),input_size=[224,448],generation_mode=backend.mode)
   else:
    if request.get('input_bytes')!=INPUT_BYTES or request.get('input_shape')!=[3,224,448] or request.get('pixel_format')!='rgb-chw-f32le':
     raise ValueError('Compiled model requires hardware-prepared RGB CHW float32[3,224,448]')
    payload=receive_exact(connection,INPUT_BYTES)
    chw=np.frombuffer(payload,dtype='<f4').reshape(3,224,448)
    pixels=patchify_prepared_chw(chw)
    result=backend.generate(pixels,ids,request.get('tokens',128),lambda:peer_disconnected(connection))
  send_json(connection,dict(ok=True,schema_version=1,contract_sha256=backend.contract_sha256,**result))
 except (ValueError,AssertionError,KeyError,RuntimeError,OSError) as error:
  # A cancelled/failed request releases SDK models in the backend's context
  # manager. Fail this connection explicitly,keeping the listener available;
  # no partial output enters archive/SEI and no neural fallback is selected.
  try:send_json(connection,dict(ok=False,schema_version=1,error=type(error).__name__))
  except (OSError,ValueError):pass

class CompleteBpuBackend:
 def __init__(self,contract,contract_sha256,tokenizer,tokenizer_sha256,mode,maximum_seconds,resident_models):
  if mode not in ('slow','hybrid','fast') or not 0<maximum_seconds<=3600 or resident_models not in (1,2):raise ValueError('Invalid declared execution bounds')
  sys.path.insert(0,str(RUNTIME_ROOT))
  from locateanything_bpu_contract_v1 import load_complete_generator
  # Missing components/source or weight identity mismatch prevents any ready socket.
  self.generator,self.contract=load_complete_generator(contract,contract_sha256)
  self.prompt=LocateAnythingPrompt(tokenizer,tokenizer_sha256)
  self.contract_sha256=contract_sha256;self.mode=mode
  self.maximum_seconds=maximum_seconds;self.resident_models=resident_models

 def health(self):
  return dict(ready=True,model_family='locateanything-3b',neural_provider='bpu',
      neural_cpu_fallback=False,input_size=[224,448],component_count=len(self.generator.specs),
      generation_mode=self.mode,request_bound_seconds=self.maximum_seconds,
      bound_kind='Cooperative before/after every component;SDK calls are synchronous',
      resident_models=self.resident_models)

 def generate(self,pixels,ids,tokens,cancelled):
  from locateanything_bpu_components_v2 import ComponentExecutor
  started=time.monotonic()
  # Release all SDK models at request end, including cancellation/failure.
  executor_type=request_bound_executor_type(ComponentExecutor,cancelled,started+self.maximum_seconds)
  with executor_type(self.generator.specs,budget_bytes=1536*1024**2,
       maximum_models=self.resident_models,minimum_available_bytes=2*1024**3) as executor:
   answer=self.generator.generate(executor,pixels,np.array([[16,32]],np.int64),ids,
       mode=self.mode,max_new_tokens=tokens,model_max_length=512,temperature=0.,
       maximum_seconds=self.maximum_seconds,cancelled=cancelled)
  if executor.loaded:raise RuntimeError('BPU executor retained models after request completion')
  # Only aggregate diagnostics belong in the bounded response. Per-load event
  # traces may grow past MAX_RESPONSE and stay in explicit evaluation artifacts.
  stats={key:value for key,value in executor.stats.items() if key!='events'}
  ids=answer.pop('generated_ids').tolist()
  return dict(generated_ids=ids,response=self.prompt.decode(ids),**answer,
      executor_stats=stats,wall_seconds=time.monotonic()-started,all_models_released=True)

def main():
 def terminate(_signum,_frame):raise SystemExit(0)
 # SystemExit passes through request handlers and context managers,so SDK
 # models and the owned socket are released on a normal service stop.
 signal.signal(signal.SIGTERM,terminate);signal.signal(signal.SIGHUP,terminate)
 p=argparse.ArgumentParser()
 p.add_argument('--contract',type=Path,required=True);p.add_argument('--contract-sha256',required=True)
 p.add_argument('--tokenizer',type=Path,required=True);p.add_argument('--tokenizer-sha256',required=True)
 p.add_argument('--socket',type=Path,required=True);p.add_argument('--mode',choices=['slow','hybrid','fast'],default='slow')
 p.add_argument('--maximum-seconds',type=float,required=True);p.add_argument('--resident-models',type=int,choices=[1,2],default=1)
 a=p.parse_args();root=Path('/home/sunrise/ainvr/data/ai').resolve()
 path=prepare_socket_path(a.socket,root)
 backend=CompleteBpuBackend(a.contract,a.contract_sha256,a.tokenizer,a.tokenizer_sha256,a.mode,a.maximum_seconds,a.resident_models)
 listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);bound_identity=None
 try:
  previous_umask=os.umask(0o177)
  try:listener.bind(str(path))
  finally:os.umask(previous_umask)
  bound_identity=(path.lstat().st_dev,path.lstat().st_ino);os.chmod(path,0o600)
  listener.listen(1)
  while True:
   connection,_=listener.accept()
   with connection:
    _,uid,_=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))
    if uid!=os.getuid():continue
    serve_connection(connection,backend)
 finally:
  listener.close()
  if bound_identity is not None:
   try:
    current=path.lstat()
    if stat.S_ISSOCK(current.st_mode) and (current.st_dev,current.st_ino)==bound_identity:path.unlink()
   except FileNotFoundError:pass

if __name__=='__main__':main()
