"""Bounded isolated official Omni image benchmark with AI-only finally recovery."""
from pathlib import Path
import hashlib,json,os,signal,subprocess,time,traceback,urllib.request
ROOT=Path('/home/sunrise/ainvr');BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/official-qwen-omni-3b-v1')
REPORT=ROOT/'test/results/official-qwen-omni-benchmark-guard-v1.json';BINARY=BASE/'official-omni-benchmark-v1';OUT=BASE/'benchmark-v1/result.json';PROMPT=BASE/'image-audit-prompt-v1.json'
assert not REPORT.exists() and not OUT.exists()
r=dict(status='checking',started=time.time(),production_pause_started=False,production_restored=False,recorder_or_ingest_or_miners_signalled=False,scope='Official frozen Q8 Omni image smoke/timing only;not fire detection quality or LocateAnything acceptance')
child=None;ticks=None;was_active=False
def save():
 t=REPORT.with_suffix('.json.tmp');t.write_text(json.dumps(r,indent=2)+'\n');t.replace(REPORT)
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as stream:
  for block in iter(lambda:stream.read(4*1024**2),b''):h.update(block)
 return h.hexdigest()
def unit(name):return subprocess.run(['systemctl','is-active',name],capture_output=True,text=True,timeout=10).stdout.strip()
def available():return int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024
def snapshot():
 def get(suffix):
  q=urllib.request.Request('http://127.0.0.1:8000/api/v1/channels/2baec0a3-9941-47dc-b1bd-d3d284488097'+suffix,headers={'X-Api-Key':key});return json.load(urllib.request.urlopen(q,timeout=5))
 state=get('');latest=get('/results/latest');return dict(inference_count=state['stats']['inference_count'],consecutive_errors=state['stats']['consecutive_errors'],latest_timestamp=latest.get('result',{}).get('timestamp'),checked=time.time())
def owned():
 if child is None:return False
 try:
  p=Path('/proc')/str(child.pid);fields=(p/'stat').read_text().split(') ',1)[1].split()
  return fields[19]==ticks and int(fields[2])==child.pid and str(BINARY).encode() in (p/'cmdline').read_bytes().split(bytes([0]))
 except OSError:return False
def cleanup():
 if child is not None and child.poll() is None and owned():
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=10)
  except subprocess.TimeoutExpired:
   if owned():os.killpg(child.pid,signal.SIGKILL)
   child.wait(timeout=10)
def stop(signum,frame):raise RuntimeError('Owned Omni guard interrupted '+str(signum))
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGHUP,stop)
try:
 save();download=json.loads((ROOT/'test/results/official-qwen-omni-download-v1.json').read_text());assert download['status']=='downloaded_and_checksums_verified' and len(download['assets'])==4
 for asset in download['assets']:
  p=BASE/'model'/asset['name'];assert p.stat().st_size==asset['bytes'] and digest(p)==asset['sha256']
 assert digest(BINARY)=='6f1678f2913a06b01e8a5924b4553ebc88a359e0caa92795ee1cd7a32746a6ea'
 assert available()>8*1024**3
 r.update(assets_reverified=True,prompt_sha256=digest(PROMPT),minimum_available_bytes=available());save()
 key=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key'];was_active=unit('ainvr-ai')=='active';assert was_active;r['before']=snapshot()
 r.update(status='hardware_running',production_pause_started=True,pause_started=time.time());save()
 subprocess.run(['systemctl','stop','ainvr-ai'],check=True,timeout=45);assert unit('ainvr-ai')=='inactive'
 args=['runuser','-u','sunrise','--','/usr/bin/env','LD_LIBRARY_PATH='+str(BASE/'runtime/lib'),str(BINARY),str(BASE),str(OUT),str(PROMPT),str(PROMPT)]
 with (BASE/'benchmark-v1/worker.log').open('xb') as stream:
  child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True);ticks=Path(f'/proc/{child.pid}/stat').read_text().split(') ',1)[1].split()[19];r.update(child_pid=child.pid,child_start_ticks=ticks);save();deadline=time.monotonic()+240
  while child.poll() is None:
   value=available();r['minimum_available_bytes']=min(value,r['minimum_available_bytes'])
   assert value>=6*1024**3,'Preserve6GiB ordinary memory'
   assert time.monotonic()<deadline,'Official benchmark exceeded240second bound'
   time.sleep(.5)
  r['worker_return']=child.returncode
 result=json.loads(OUT.read_text());r['hardware']=result
 assert child.returncode==0 and result['status']=='completed' and result['uid']==1000 and len(result['runs'])==2
 assert all(x['ended'] and not x['error'] and x['text'].strip() and x['first_text_callback_seconds']>=0 for x in result['runs'])
 r['hardware_passed']=True
except BaseException:r.update(status='failed',error=traceback.format_exc())
finally:
 try:cleanup()
 except BaseException:r['cleanup_error']=traceback.format_exc()
 if r['production_pause_started'] and was_active:
  try:
   subprocess.run(['systemctl','start','ainvr-ai'],check=True,timeout=45);deadline=time.monotonic()+40;first=None
   while time.monotonic()<deadline:
    try:
     value=snapshot()
     if first is None:first=value
     if value['inference_count']>first['inference_count'] and value['consecutive_errors']==0 and value['latest_timestamp'] is not None and time.time()-value['latest_timestamp']<10:r.update(production_restored=True,after_first=first,after=value);break
    except Exception:r['restore_probe']='API temporarily unavailable;no credentials recorded'
    time.sleep(.5)
  except BaseException:r['restore_error']=traceback.format_exc()
  r['pause_seconds']=time.time()-r['pause_started']
 r['services_after']={name:unit(name) for name in ['ainvr-ai','ainvr-recorder','ainvr-ingest']}
 if r.get('hardware_passed') and r['production_restored']:r['status']='completed'
 r['finished']=time.time();save()
print(json.dumps(r));assert r['status']=='completed'
