# Derived from immutable v124 transfer helper;same direct-stream/hash/incoming discipline.
"""Transfer terminal same-BC candidate into a new SSD package,without a PC tar archive."""
from pathlib import Path
import argparse,subprocess,shlex
from locateanything_owned_container_transport_v113 import start
p=argparse.ArgumentParser();p.add_argument('--manifest-sha',required=True);a=p.parse_args();assert len(a.manifest_sha)==64 and all(x in '0123456789abcdef' for x in a.manifest_sha)
producer="""from pathlib import Path
import hashlib,json,sys,tarfile
p=Path('/opt/locate-official-w8-prefill-o2-v130-board-package/manifest.json');assert hashlib.sha256(p.read_bytes()).hexdigest()==sys.argv[1];m=json.loads(p.read_text());assert m['schema']=='locateanything_same_bc_w8_prefill_board_v1'
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as t:
 t.add(p,arcname='manifest.json',recursive=False)
 for name,item in m['files'].items():t.add(p.parent/name,arcname=name,recursive=False)
"""
receiver="""from pathlib import Path
import hashlib,json,sys,tarfile,os,time
base=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1');root=base/'official-w8-prefill-o2-v130-board-package';stage=base/'.official-w8-prefill-o2-v130-board-package.incoming';report=Path('/home/sunrise/ainvr/test/results/locateanything-w8-prefill-o2-transfer-v130.json');assert not root.exists() and not stage.exists() and not report.exists();stage.mkdir();seen=set();total=0
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as t:
 for e in t:
  assert e.isfile() and not e.issym() and not e.islnk() and e.name not in seen;seen.add(e.name);dst=stage/e.name;assert dst.resolve().is_relative_to(stage.resolve())
  if e.name=='manifest.json':
   assert len(seen)==1 and e.size<1000000;data=t.extractfile(e).read();assert hashlib.sha256(data).hexdigest()==sys.argv[1];m=json.loads(data);assert m['schema']=='locateanything_same_bc_w8_prefill_board_v1' and not m['release_approved'] and set(m['files'])=={'model.hbm','disas.json','source-status.json','baseline-status.json','same-bc-provenance.json','ports.json'};dst.write_bytes(data)
  else:
   item=m['files'][e.name];assert e.size==item['bytes'] and e.size<1500000000;h=hashlib.sha256();count=0
   with t.extractfile(e) as src,dst.open('xb') as out:
    for data in iter(lambda:src.read(4194304),b''):out.write(data);h.update(data);count+=len(data)
   assert count==item['bytes'] and h.hexdigest()==item['sha256'];total+=count
  os.chown(dst,1000,1000)
assert seen==set(m['files'])|{'manifest.json'};os.chown(stage,1000,1000);stage.rename(root);r=dict(status='terminal_same_bc_candidate_all_files_transferred_hash_verified',manifest_sha256=sys.argv[1],files=len(seen),bytes=total,root=str(root),finished=time.time(),actual_board_verified=False);report.write_text(json.dumps(r,indent=2)+'\\n');print(json.dumps(r))
"""
cmd='cd /home/sunrise/ainvr && python3 -c '+shlex.quote(receiver)+' '+shlex.quote(a.manifest_sha)
log=Path(__file__).with_name('w8-prefill-o2-v130-transfer.stderr.log').open('xb');x=start(['/usr/bin/python3','-c',producer,a.manifest_sha],stdout=subprocess.PIPE,stderr=log);y=subprocess.Popen(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','root@192.168.100.189',cmd],stdin=x.stdout);x.stdout.close();yr=y.wait();xr=x.wait();log.close();assert xr==yr==0,(xr,yr)
