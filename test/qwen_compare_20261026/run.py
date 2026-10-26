from pathlib import Path
import subprocess,json,time,os,sys,threading
ROOT=Path('/home/sunrise/ainvr/test/results/qwen-compare-20261026')
SCRIPTS=Path(__file__).parent
UNITS=['ainvr-review-reference','ainvr-ai','ainvr-llm','ainvr-locateanything-official-bpu']
def state(u):return subprocess.run(['systemctl','is-active',u],capture_output=True,text=True).stdout.strip()
def sample(pid):
 record={'at':time.time(),'pid':pid}
 try:
  record['memory']={l.split(':')[0]:int(l.split()[1])*1024 for l in Path(f'/proc/{pid}/status').read_text().splitlines() if l.startswith(('VmRSS:','VmHWM:'))}
  seen={}
  for fd in Path(f'/proc/{pid}/fd').iterdir():
   try:
    if not os.readlink(fd).startswith('/dmabuf'):continue
    fields=dict(l.split(':',1) for l in Path(f'/proc/{pid}/fdinfo/{fd.name}').read_text().splitlines() if ':' in l)
    if fields.get('exp_name','').strip()=='ion':seen[int(fields['ino'])]=int(fields['size'])
   except (OSError,KeyError,ValueError):pass
  record['ion_lower_bound_bytes']=sum(seen.values())
 except OSError:pass
 record['mem_available_bytes']=next(int(l.split()[1])*1024 for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
 record['temperatures_mC']={p.parent.name:int(p.read_text()) for p in Path('/sys/class/thermal').glob('thermal_zone*/temp')}
 return record
def run_model(name,kind):
 out=ROOT/f'{name}-{kind}-out.jsonl';log=ROOT/f'{name}-{kind}.log'
 cmd=['/usr/bin/python3',str(SCRIPTS/f'{name}-safe.py'),str(ROOT/f'{name}-manifest.json'),str(ROOT/f'{name}-{kind}.jsonl'),str(out)]
 print('START',name,kind,time.time(),flush=True)
 with log.open('w') as f, (ROOT/f'{name}-{kind}-resources.jsonl').open('w') as metrics:
  child=subprocess.Popen(cmd,stdout=f,stderr=subprocess.STDOUT,env={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','PYTHONUNBUFFERED':'1'},start_new_session=True)
  start=time.monotonic()
  while child.poll() is None:
   r=sample(child.pid);metrics.write(json.dumps(r)+'\n');metrics.flush()
   if time.monotonic()-start>4200 or r['mem_available_bytes']<750*1024**2 or max(r['temperatures_mC'].values(),default=0)>90000:
    os.killpg(child.pid,15)
    try:child.wait(30)
    except subprocess.TimeoutExpired:os.killpg(child.pid,9);child.wait()
    raise RuntimeError('Resource or timeout guard stopped '+name)
   time.sleep(.5)
  if child.returncode:raise RuntimeError(f'{name} exit {child.returncode}; see {log}')
 print('DONE',name,kind,time.time(),flush=True)
before={u:state(u) for u in UNITS+['ainvr-recorder','ainvr-ingest','ainvr-alarm']}
assert not (ROOT/'services-before.json').exists(),'Do not overwrite an existing guard snapshot'
(ROOT/'services-before.json').write_text(json.dumps(before,indent=2))
try:
 for u in UNITS:
  if before[u]=='active':subprocess.run(['systemctl','stop',u],check=True,timeout=100)
 (ROOT/'baseline-resources.json').write_text(json.dumps(sample(os.getpid()),indent=2))
 for name in ['vl','q35']:run_model(name,'final')
 for name in ['vl','q35']:
  if (ROOT/f'{name}-dialog.jsonl').exists():run_model(name,'dialog')
 (ROOT/'completed.json').write_text(json.dumps({'at':time.time(),'ok':True}))
finally:
 subprocess.run(['/usr/bin/python3',str(SCRIPTS/'restore.py')],timeout=420)
