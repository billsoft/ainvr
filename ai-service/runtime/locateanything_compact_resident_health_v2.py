"""Wait for the exact complete COMPACT local BPU backend; no inference call."""
from pathlib import Path
import argparse,json,math,os,socket,stat,struct,time,hashlib
from locateanything_compact_executor_health_v1 import validate_health as validate_common

def validate_health(value,contract_sha256,mode,maximum_seconds,component_count,resident_models,residency_sha256):
 if type(component_count) is not int or component_count!=113 or type(resident_models) is not int or resident_models!=43 or mode!='slow':raise ValueError('Invalid complete persistent layout')
 if not isinstance(residency_sha256,str) or len(residency_sha256)!=64 or any(c not in '0123456789abcdef' for c in residency_sha256):raise ValueError('Missing actual complete residency proof identity')
 if hashlib.sha256(Path(__file__).with_name('locateanything_compact_executor_health_v1.py').read_bytes()).hexdigest()!='af9a0ba9ddd8d40dd39ce19717d37e8e605024990196ef1d3c84e552a747b62d':raise ValueError('Common health validation changed')
 if not isinstance(value,dict) or type(value.get('resident_models')) is not int or value['resident_models']!=43:raise ValueError('Persistent context count differs')
 # Apply the unchanged common protocol checks;validate actual43 separately.
 validate_common(dict(value,resident_models=1),contract_sha256,mode,maximum_seconds,component_count,1)
 if value.get('cache_policy')!='persistent_compact_four_groups_heads_alias_v1' or value.get('residency_proof_sha256')!=residency_sha256 or value.get('residency_sampled_verified') is not True or value.get('generation_state_retained') is not False:raise ValueError('Persistent runtime policy/evidence differs')
 state=value.get('persistent_worker')
 if not isinstance(state,dict) or state.get('alive') is not True or state.get('stopping') is not False:raise ValueError('SDK owner thread is unavailable')
 if type(state.get('cached_models')) is not int or not 0<=state['cached_models']<=43:raise ValueError('Invalid persistent context observation')
 return value

def request_health(path,contract_sha256,mode,maximum_seconds,component_count,resident_models,residency_sha256):
 info=path.lstat()
 if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600:
  raise ValueError('Backend endpoint ownership/permissions differ')
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
  connection.settimeout(2);connection.connect(str(path))
  if struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=os.getuid():
   raise ValueError('Backend peer account differs')
  request=json.dumps(dict(schema_version=1,operation='health',contract_sha256=contract_sha256,input_bytes=0)).encode()
  connection.sendall(struct.pack('!I',len(request))+request)
  def receive(size):
   parts=[]
   while size:
    block=connection.recv(size)
    if not block:raise ConnectionError('Backend closed the readiness response')
    parts.append(block);size-=len(block)
   return b''.join(parts)
  size=struct.unpack('!I',receive(4))[0]
  if not 0<size<=1024*1024:raise ValueError('Invalid readiness response size')
  return validate_health(json.loads(receive(size)),contract_sha256,mode,maximum_seconds,component_count,resident_models,residency_sha256)

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--socket',type=Path,required=True);p.add_argument('--contract-sha256',required=True)
 p.add_argument('--mode',choices=['slow'],required=True)
 p.add_argument('--maximum-seconds',type=float,required=True);p.add_argument('--wait-seconds',type=float,default=60)
 p.add_argument('--component-count',type=int,choices=[113],required=True);p.add_argument('--resident-models',type=int,choices=[43],required=True)
 p.add_argument('--residency-proof-sha256',required=True)
 a=p.parse_args();root=Path('/home/sunrise/ainvr/data/ai').resolve()
 if a.socket.absolute().parent.resolve()!=root or len(str(a.socket).encode())>=108:
  raise ValueError('Readiness endpoint outside AI runtime directory')
 if len(a.contract_sha256)!=64 or any(c not in '0123456789abcdef' for c in a.contract_sha256):raise ValueError('Invalid contract hash')
 if not math.isfinite(a.maximum_seconds) or not 0<a.maximum_seconds<=3600 or not 0<=a.wait_seconds<=600:
  raise ValueError('Invalid declared wait/generation bound')
 deadline=time.monotonic()+a.wait_seconds
 while True:
  try:value=request_health(a.socket,a.contract_sha256,a.mode,a.maximum_seconds,a.component_count,a.resident_models,a.residency_proof_sha256);break
  except (OSError,ValueError,ConnectionError):
   if time.monotonic()>=deadline:raise RuntimeError('Complete BPU backend readiness was not established') from None
   time.sleep(min(.25,max(0,deadline-time.monotonic())))
 print(json.dumps(dict(status='ready',scope='Complete artifact constructor and local transport readiness;not inference quality',health=value,neural_calls=0)))

if __name__=='__main__':main()
