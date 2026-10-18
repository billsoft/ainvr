import subprocess,os,signal,time,json,hashlib
from pathlib import Path
r=Path('/opt/locate-oellm-research-v1');script=r/'build-original-decoder-stack-v3.py';log=(r/'original-decoder-stack-36-v3.log').open('xb');child=subprocess.Popen(['python3',str(script),'--layers','36'],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
pid=child.pid;ticks=Path('/proc/'+str(pid)+'/stat').read_text().split()[21];start=time.monotonic();report={'status':'running','guard_pid':os.getpid(),'child_pid':pid,'child_start_ticks':ticks,'script':str(script),'script_sha256':hashlib.sha256(script.read_bytes()).hexdigest(),'deadline_seconds':3600,'minimum_available_gib':4,'production_signalled':False,'started':time.time()}
def save():(r/'original-decoder-stack-36-v3-guard.json').write_text(json.dumps(report,indent=2))
save()
while child.poll() is None:
 available=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024;report['last_available_bytes']=available;report['last_checked']=time.time();save()
 reason='memory_headroom' if available<4*1024**3 else ('deadline' if time.monotonic()-start>3600 else None)
 if reason:
  assert Path('/proc/'+str(pid)+'/stat').read_text().split()[21]==ticks
  assert str(script).encode() in Path('/proc/'+str(pid)+'/cmdline').read_bytes()
  os.killpg(pid,signal.SIGTERM)
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:os.killpg(pid,signal.SIGKILL);child.wait()
  report['stop_reason']=reason;break
 time.sleep(5)
report.update(status='exited',exit_code=child.returncode,finished=time.time());save()
