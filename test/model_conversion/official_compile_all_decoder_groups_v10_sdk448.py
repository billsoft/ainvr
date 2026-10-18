import os,signal,subprocess,time,json,hashlib
from pathlib import Path
r=Path('/opt/locate-oellm-research-v1');source=r/'build-original-decoder-group-v10-sdk448.py';report={'status':'running','pid':os.getpid(),'started':time.time(),'scope':'all36 original decoder layers as four nine-layer groups with decode12/prefill256; existing full BPU heads retain final norm','source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'completed':[],'board_calls':0,'whole_model_verified':False,'jobs_per_compile':1,'minimum_available_gib':6,'max_seconds_per_group':1800};child=None
status=r/'all-decoder-groups-v10-sdk448.json';assert not status.exists()
def save():status.write_text(json.dumps(report,indent=2))
def terminate_owned(reason):
 report['stop_reason']=reason
 if child.poll() is None:
  assert Path('/proc/'+str(child.pid)+'/stat').read_text().split()[21]==ticks
  assert str(source).encode() in Path('/proc/'+str(child.pid)+'/cmdline').read_bytes()
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
save()
try:
 for seq in [12,256]:
  for start in [0,9,18,27]:
   target=r/('original-decoder-group-'+str(start)+'-'+str(start+8)+'-s'+str(seq)+'-v10-sdk448');assert not target.exists(),str(target)
   log=target.with_suffix('.log');assert not log.exists()
   with log.open('xb') as stream:child=subprocess.Popen(['python3',str(source),'--layers','9','--start-layer',str(start),'--seq',str(seq)],stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
   ticks=Path('/proc/'+str(child.pid)+'/stat').read_text().split()[21];began=time.monotonic();report.update(current={'start':start,'end':start+8,'sequence':seq,'pid':child.pid,'start_ticks':ticks,'directory':str(target)});save()
   while child.poll() is None:
    available=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024;report.update(last_available_bytes=available,last_checked=time.time());save()
    if available<6*1024**3:terminate_owned('memory_headroom');break
    if time.monotonic()-began>1800:terminate_owned('group_deadline');break
    time.sleep(1)
   assert child.returncode==0,('compile process failed',child.returncode)
   data=json.loads((target/'status.json').read_text());assert data['status']=='completed' and set(data['devices'])=={'DEVICE_CATEGORY_BPU'};assert [x['index'] for x in data['layers']]==list(range(start,start+9));assert data['final_norm_location']=='existing complete BPU vocabulary head'
   report['completed'].append({'start':start,'end':start+8,'sequence':seq,'directory':str(target),'hbm_sha256':data['hbm_sha256'],'source_status_sha256':hashlib.sha256((target/'status.json').read_bytes()).hexdigest()});report['current']=None;save()
 report.update(status='all_groups_compiled',finished=time.time());save()
except BaseException:
 import traceback
 if child is not None and child.poll() is None:terminate_owned('controller_exception')
 report.update(status='failed',error=traceback.format_exc(),finished=time.time());save();raise
