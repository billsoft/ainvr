"""UID-owned candidate private health observation;no generation/hardware calls."""
from pathlib import Path
import argparse,json,os,socket,stat,struct
ROOT=Path('/home/sunrise/ainvr/data/ai');CONTRACT='ddf40b566faa841b3ff3aa658d7beb31b44576f7895db93adb3476b41fe6d101'
def main():
 path=ROOT/'locateanything-official-bpu.sock';info=path.lstat()
 assert os.getuid()==1000 and stat.S_ISSOCK(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o600
 def receive(s,n):
  out=[]
  while n:
   b=s.recv(n)
   if not b:raise ConnectionError('Incomplete health response')
   out.append(b);n-=len(b)
  return b''.join(out)
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
  s.settimeout(5);s.connect(str(path));pid,uid,gid=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));assert uid==os.getuid()
  raw=json.dumps(dict(schema_version=1,operation='health',contract_sha256=CONTRACT,input_bytes=0)).encode();s.sendall(struct.pack('!I',len(raw))+raw)
  size=struct.unpack('!I',receive(s,4))[0];assert 0<size<=1024**2;value=json.loads(receive(s,size))
 assert all(value.get(k)==v for k,v in dict(ok=True,ready=True,schema_version=1,contract_sha256=CONTRACT,neural_provider='bpu',neural_cpu_fallback=False,component_count=76,physical_hbm_files=46,request_bound_seconds=90).items())
 assert value['runtime_io_policy']=='persistent_static_io_v1'
 value['observed_peer_pid']=pid;value['health_probe_neural_calls']=0;print(json.dumps(value))
if __name__=='__main__':main()
