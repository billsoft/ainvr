"""Owned first2-layer selected-checkpoint SDK448 compiler guard;no production actions."""
from pathlib import Path
import os,time,json,hashlib,subprocess,signal,traceback,shutil
ROOT=Path('/work/official-llm-v1');SOURCE=ROOT/'official_build_selected_decoder_group_mask_centered_v3_sdk448.py';OUT=ROOT/'selected-decoder-group-0-1-s12-mask-centered-v3-guard.json';TARGET=Path('/opt/locate-oellm-research-v1/selected-decoder-group-0-1-s12-mask-centered-v3-sdk448')
assert not OUT.exists() and not TARGET.exists();assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()=='0eea0d7b2311ed8df373c79961a5704491144ed448e3d01fe84c503a6426fbae'
r=dict(status='starting',started=time.time(),scope=__doc__,source_sha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(),resource_floor_bytes=6*1024**3,maximum_seconds=1800,production_actions=False,target=str(TARGET));child=None;log=None

def mem():return int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024

def save():
 p=OUT.with_suffix('.json.tmp');p.write_text(json.dumps(r,indent=2)+'\n');p.replace(OUT)

def interrupted(*_):raise RuntimeError('Owned selected-checkpoint compiler guard interrupted')
signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
try:
 assert mem()>10*1024**3 and shutil.disk_usage('/opt').free>12*1024**3
 log=(ROOT/'selected-decoder-group-0-1-s12-mask-centered-v3.log').open('xb')
 child=subprocess.Popen(['python3','-u',str(SOURCE),'--layers','2','--start-layer','0','--seq','12'],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 ticks=Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split()[19];r.update(status='running',child_pid=child.pid,child_start_ticks=ticks,minimum_available_bytes=mem());save();start=time.monotonic()
 while child.poll() is None:
  available=mem();r['minimum_available_bytes']=min(r['minimum_available_bytes'],available);assert available>6*1024**3,'Preserve6GiB ordinary RAM';assert time.monotonic()-start<1800,'Owned1800second compiler limit';time.sleep(3)
 r['child_return']=child.returncode;report=TARGET/'status.json'
 if report.exists():
  j=json.loads(report.read_text());r['result_status']=j.get('status');r['hbm_sha256']=j.get('hbm_sha256');r['result_sha256']=hashlib.sha256(report.read_bytes()).hexdigest()
 assert child.returncode==0 and r.get('result_status')=='completed' and j.get('bpu_only') is True
 r['status']='completed'
except BaseException:r.update(status='failed',error=traceback.format_exc())
finally:
 if child is not None and child.poll() is None:
  current=Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split();assert current[19]==ticks and os.getpgid(child.pid)==child.pid
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
 if log is not None:log.close()
 r['finished']=time.time();save()
