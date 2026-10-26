from pathlib import Path
import json,subprocess,time,os,signal
ROOT=Path('/home/sunrise/ainvr/test/results/qwen-compare-20261026')
p=ROOT/'services-before.json'
if p.exists():
 # On an unexpected runner failure, release only this test unit's exact child
 # before loading production models. Never target unrelated Python processes.
 for resource in ROOT.glob('*-resources.jsonl'):
  try:
   last=resource.read_text().splitlines()[-1];pid=json.loads(last)['pid'];proc=Path(f'/proc/{pid}')
   args=(proc/'cmdline').read_bytes().split(b'\0');group=(proc/'cgroup').read_text()
   expected=[str(Path(__file__).parent/(name+'-safe.py')).encode() for name in ['vl','q35']]
   if 'ainvr-qwen-compare-20261026.service' not in group or not any(a in args for a in expected):continue
   if os.getpgid(pid)!=pid:continue
   os.killpg(pid,signal.SIGTERM)
   deadline=time.monotonic()+30
   while proc.exists() and time.monotonic()<deadline:time.sleep(.2)
   if proc.exists():os.killpg(pid,signal.SIGKILL)
  except (OSError,KeyError,ValueError,IndexError):pass
 before=json.loads(p.read_text());result={}
 for unit in ['ainvr-locateanything-official-bpu','ainvr-ai','ainvr-llm','ainvr-review-reference']:
  if before.get(unit)=='active':
   r=subprocess.run(['systemctl','start',unit],capture_output=True,timeout=100);result[unit]={'start_rc':r.returncode}
 for unit in before:
  result.setdefault(unit,{})['state']=subprocess.run(['systemctl','is-active',unit],capture_output=True,text=True).stdout.strip()
 (ROOT/'services-restored.json').write_text(json.dumps({'at':time.time(),'services':result},indent=2))
 print(json.dumps(result),flush=True)
