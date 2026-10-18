"""Observe the user-chosen 2s target (0.5fps, adaptive) on the 大门 channel for 10 minutes.

Overload skips are adaptive pacing and only recorded. Restore 0.1fps only on errors,
archive backpressure or SEI lateness. Otherwise keep 0.5fps. SIGTERM is handled.
"""
from pathlib import Path
import json,signal,time,traceback,urllib.request
ROOT=Path('/home/sunrise/ainvr');CH='2baec0a3-9941-47dc-b1bd-d3d284488097'
REPORT=ROOT/'test/results/locateanything-2s-target-observation-v291.json'
key=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key']
def call(method,path,body=None):
 r=urllib.request.Request('http://127.0.0.1:8000'+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={'X-Api-Key':key,'Content-Type':'application/json'})
 with urllib.request.urlopen(r,timeout=10) as f:return json.load(f)
def snap():
 s=call('GET',f'/api/v1/channels/{CH}');st=s['stats'];pub=st.get('publish',{})
 return dict(t=time.time(),state=s['state'],fps=s['config']['inference_fps'],inference_count=st['inference_count'],consecutive_errors=st['consecutive_errors'],last_error=st.get('last_error'),
  overload=st.get('overload_drop_count'),archive_skip=st.get('archive_backpressure_skip_count'),sei=pub.get('sei_injected'),too_late=pub.get('buffer',{}).get('too_late'),
  inference=st['timing']['inference'],capture_to_result=st['timing']['capture_to_result'])
def ratio(seconds):
 vals=[];end=time.time()+seconds
 while time.time()<end:vals.append(int(open('/sys/devices/system/bpu/ratio').read().split()[0]));time.sleep(.02)
 return sum(vals)/len(vals)
def save(r):
 t=REPORT.with_name('.'+REPORT.name+'.incoming');t.write_text(json.dumps(r,indent=2,ensure_ascii=False)+'\n');t.replace(REPORT)
def term(*_):raise KeyboardInterrupt('SIGTERM')
signal.signal(signal.SIGTERM,term)
assert not REPORT.exists()
r=dict(status='observing_0.5fps',scope=__doc__,started=time.time(),samples=[],problems=[],restored_to_10s=False)
try:
 base=snap();assert base['fps']==0.5 and base['state']=='running';r['base']=base;save(r);end=time.time()+600
 while time.time()<end:
  m=ratio(15);s=snap();s['bpu_mean_ratio']=m;r['samples'].append(s);save(r);p=[]
  if s['state']!='running' or s['fps']!=0.5:p.append('channel_not_running_at_0.5')
  if s['consecutive_errors']>0 or s['last_error']:p.append('errors')
  if (s['archive_skip'] or 0)>(base['archive_skip'] or 0):p.append('archive_backpressure')
  if (s['too_late'] or 0)>(base['too_late'] or 0):p.append('sei_too_late')
  if p:r['problems']=p;break
 r['after']=snap();dt=r['after']['t']-base['t']
 r['actual_fps']=(r['after']['inference_count']-base['inference_count'])/dt;r['overload_delta']=r['after']['overload']-base['overload']
 r['bpu_mean_ratio']=sum(x['bpu_mean_ratio'] for x in r['samples'])/len(r['samples'])
 if r['problems']:call('PUT',f'/api/v1/channels/{CH}/config',{'inference_fps':0.1});r['restored_to_10s']=True;r['status']='problem_restored_10s'
 else:r['status']='completed_0.5fps_kept'
except BaseException:
 r.update(status='interrupted_or_failed_0.5fps_left_unchanged',error=traceback.format_exc())
finally:r['finished']=time.time();save(r)
print(json.dumps({k:r.get(k) for k in ['status','problems','actual_fps','overload_delta','bpu_mean_ratio','error']},ensure_ascii=False))
