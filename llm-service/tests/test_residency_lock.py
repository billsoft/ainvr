"""Cross-language lifecycle lock tests; no hardware allocations."""
import sys,subprocess,tempfile,json,os,stat,resource,signal,pwd
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'ai-service/runtime'))
from large_model_reservation import LargeModelReservation,ReservedExecutor
probe=sys.argv[1] if len(sys.argv)>1 else '/mnt/ainvr-ssd/llm-build/reservation_probe'
with tempfile.TemporaryDirectory() as tmp:
 def start():
  p=subprocess.Popen([probe,tmp],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  assert p.stdout.readline().strip()=='locked';return p
 def rejected():
  p=subprocess.run([probe,tmp],input='',capture_output=True,text=True);assert p.returncode==2
 a=LargeModelReservation(tmp);rejected();a.close()
 p=start()
 try:
  try:LargeModelReservation(tmp)
  except RuntimeError as e:assert str(e)=='large_model_busy'
  else:raise AssertionError('concurrent model admitted')
 finally:p.communicate('done\n',timeout=5)
 a=LargeModelReservation(tmp);a.loaded();a.close()
 p=start();p.kill();p.wait();a=LargeModelReservation(tmp);a.close()
 assert subprocess.run([probe,tmp,'insufficient'],capture_output=True).returncode==2
 a=LargeModelReservation(tmp);a.close()
 Path(tmp,'bpu-reservations.json').write_text('{invalid')
 rejected()
 try:LargeModelReservation(tmp)
 except json.JSONDecodeError:pass
 else:raise AssertionError('corruption ignored')
 Path(tmp,'bpu-reservations.json').write_text('{"holders":[]}')
 a=LargeModelReservation(tmp)
 class Broken:
  def close(self):raise RuntimeError('cleanup failed')
 wrapper=ReservedExecutor(Broken(),a)
 try:wrapper.close()
 except RuntimeError:pass
 rejected();a.close()
 print('PASS: bidirectional exclusion, release, crash recovery, budget, corruption, failed cleanup')

# A privileged manual probe must not replace the service-owned 0600 registry
# with a root-owned inode. All paths below are isolated fixture directories.
with tempfile.TemporaryDirectory(prefix='ainvr-registry-owner-') as tmp:
 target=pwd.getpwnam('nobody') if os.geteuid()==0 else None
 uid=target.pw_uid if target else os.geteuid()
 gid=target.pw_gid if target else os.getegid()
 if target:os.chown(tmp,uid,gid)
 registry=Path(tmp,'bpu-reservations.json')
 for name in ('bpu-admission.lock','bpu-reservation.lock'):
  p=Path(tmp,name);p.touch(mode=0o600)
  if target:os.chown(p,uid,gid)
 def demote():
  if target:os.setgroups([]);os.setgid(gid);os.setuid(uid)
 def holder(nonroot=False):
  p=subprocess.Popen([probe,tmp,'coexist-small'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                     preexec_fn=demote if nonroot else None)
  line=p.stdout.readline().strip()
  assert line=='locked',(line,p.stderr.read())
  return p
 def finish(p):
  out,err=p.communicate('done\n',timeout=5)
  assert p.returncode==0,(out,err)
 def owner():
  info=registry.stat()
  assert (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(uid,gid,0o600)
 # Missing registry inherits the existing admission lock identity, even when
 # the first writer is root; a later service process can read/update/remove it.
 root_holder=holder();owner();finish(root_holder);owner()
 child=holder(True)
 root_holder=holder();owner()
 assert len(json.loads(registry.read_text())['holders'])==2
 finish(root_holder);owner()
 assert len(json.loads(registry.read_text())['holders'])==1
 finish(child);owner()
 assert json.loads(registry.read_text())['holders']==[]
 # Legacy read-only group/other bits are narrowed on the next atomic write.
 registry.chmod(0o644);root_holder=holder();owner();finish(root_holder)
 before=registry.read_bytes()
 # Neither a pre-existing temporary nor a temporary symlink may be opened or
 # unlinked by a failed writer. Its original target must remain unchanged.
 for mode in ('collision','collision-symlink'):
  target_file=Path(tmp,'collision-target');target_file.write_text('target-unchanged')
  p=subprocess.run([probe,tmp,mode],input='',capture_output=True,text=True,timeout=5)
  assert p.returncode==2 and p.stderr=='reservation_write_failed',p.stderr
  assert registry.read_bytes()==before
  entries=list(Path(tmp).glob('bpu-reservations.json.*.tmp'));assert len(entries)==1
  entry=entries[0]
  if mode=='collision':assert entry.read_text()=='not-ours'
  else:assert entry.is_symlink() and target_file.read_text()=='target-unchanged'
  entry.unlink();target_file.unlink()
 # Short/failed writes cannot replace the old registry or leak a temporary.
 def limited_write():
  signal.signal(signal.SIGXFSZ,signal.SIG_IGN)
  resource.setrlimit(resource.RLIMIT_FSIZE,(1,1))
 p=subprocess.run([probe,tmp,'coexist-small'],input='',capture_output=True,text=True,timeout=5,preexec_fn=limited_write)
 assert p.returncode==2 and p.stderr=='reservation_write_failed',p.stderr
 assert registry.read_bytes()==before and not list(Path(tmp).glob('bpu-reservations.json.*.tmp'))
 # A registry symlink is never followed, even for a privileged writer.
 registry.unlink();other=Path(tmp,'other.json');other.write_bytes(before)
 registry.symlink_to(other.name)
 p=subprocess.run([probe,tmp,'coexist-small'],input='',capture_output=True,text=True,timeout=5)
 assert p.returncode==2 and p.stderr=='reservation_registry_unavailable',p.stderr
 assert other.read_bytes()==before
 registry.unlink();other.rename(registry);registry.chmod(0o600)
 if target:
  # Existing root-owned 0600 registry gives the nonroot service an actionable
  # read error rather than passing an unopened ifstream into JSON parsing.
  os.chown(registry,0,0)
  p=subprocess.run([probe,tmp,'coexist-small'],input='',capture_output=True,text=True,timeout=5,preexec_fn=demote)
  assert p.returncode==2 and p.stderr=='reservation_registry_unavailable',p.stderr
  os.chown(registry,uid,gid)
  child=holder(True);finish(child);owner()
 print('PASS: owner-preserving root/nonroot coexistence, secure temporary, failed-write preservation, explicit read error')
