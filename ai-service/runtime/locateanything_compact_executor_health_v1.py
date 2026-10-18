"""Wait for the exact complete COMPACT local BPU backend; no inference call."""
from pathlib import Path
import argparse,json,math,os,socket,stat,struct,time

def validate_health(value,contract_sha256,mode,maximum_seconds,component_count,resident_models):
 if type(component_count) is not int or component_count not in (113,117):raise ValueError('Invalid compact component count')
 if type(resident_models) is not int or resident_models not in (1,2):raise ValueError('Invalid expected compact residency')
 if not isinstance(value,dict) or any(value.get(k)!=v for k,v in {
  'ok':True,'schema_version':1,'contract_sha256':contract_sha256,'ready':True,
  'model_family':'locateanything-3b','neural_provider':'bpu','neural_cpu_fallback':False,
  'input_size':[224,448],'component_count':component_count,'generation_mode':mode,
  'architecture':'original36_compact_affine_four_groups','evaluation_only':True,
  'resident_models':resident_models,
  'request_bound_seconds':maximum_seconds}.items()):
  raise ValueError('Complete BPU backend identity/readiness differs')
 if type(value.get('component_count')) is not int or type(value.get('resident_models')) is not int:raise ValueError('Invalid compact counts')
 if any(value.get(k) is not v for k,v in {'ok':True,'ready':True,'neural_cpu_fallback':False,'evaluation_only':True}.items()):raise ValueError('Invalid compact readiness flags')
 modes=value.get('enabled_generation_modes')
 if not isinstance(modes,list) or not modes or any(not isinstance(x,str) for x in modes) or len(set(modes))!=len(modes) or not set(modes)<={'slow','hybrid','fast'} or mode not in modes:
  raise ValueError('Requested compact generation mode is unavailable')
 if mode!='slow' and component_count!=117:raise ValueError('Native MTP profile is missing')
 return value

def request_health(path,contract_sha256,mode,maximum_seconds,component_count,resident_models):
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
  return validate_health(json.loads(receive(size)),contract_sha256,mode,maximum_seconds,component_count,resident_models)

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--socket',type=Path,required=True);p.add_argument('--contract-sha256',required=True)
 p.add_argument('--mode',choices=['slow','hybrid','fast'],required=True)
 p.add_argument('--maximum-seconds',type=float,required=True);p.add_argument('--wait-seconds',type=float,default=60)
 p.add_argument('--component-count',type=int,choices=[113,117],required=True);p.add_argument('--resident-models',type=int,choices=[1,2],required=True)
 a=p.parse_args();root=Path('/home/sunrise/ainvr/data/ai').resolve()
 if a.socket.absolute().parent.resolve()!=root or len(str(a.socket).encode())>=108:
  raise ValueError('Readiness endpoint outside AI runtime directory')
 if len(a.contract_sha256)!=64 or any(c not in '0123456789abcdef' for c in a.contract_sha256):raise ValueError('Invalid contract hash')
 if not math.isfinite(a.maximum_seconds) or not 0<a.maximum_seconds<=3600 or not 0<=a.wait_seconds<=600:
  raise ValueError('Invalid declared wait/generation bound')
 deadline=time.monotonic()+a.wait_seconds
 while True:
  try:value=request_health(a.socket,a.contract_sha256,a.mode,a.maximum_seconds,a.component_count,a.resident_models);break
  except (OSError,ValueError,ConnectionError):
   if time.monotonic()>=deadline:raise RuntimeError('Complete BPU backend readiness was not established') from None
   time.sleep(min(.25,max(0,deadline-time.monotonic())))
 print(json.dumps(dict(status='ready',scope='Complete artifact constructor and local transport readiness;not inference quality',health=value,neural_calls=0)))

if __name__=='__main__':main()
