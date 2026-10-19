"""Live tracking check on the existing gate channel (YOLO26x + tracking), then exact restore.

Bounded: switches the channel's model to the installed YOLO26x preset with analytics.enabled,
samples real results for a fixed window, and restores the complete original model,
preprocess, inference_fps and analytics in finally. Input/output SRS streams are untouched.
"""
from pathlib import Path
import json,sys,time,traceback,urllib.request,urllib.error,collections,statistics
ROOT=Path('/home/sunrise/ainvr');CH='2baec0a3-9941-47dc-b1bd-d3d284488097'
OUT=ROOT/'test/results/analytics/live-tracking-gate-v1.json'
KEY=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key']
WINDOW=int(sys.argv[1]) if len(sys.argv)>1 else 120
def call(method,path,body=None):
 req=urllib.request.Request('http://127.0.0.1:8000'+path,method=method,headers={'X-Api-Key':KEY,'Content-Type':'application/json'},
                            data=None if body is None else json.dumps(body).encode())
 try:
  with urllib.request.urlopen(req,timeout=30) as f:return f.status,json.load(f)
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read() or b'{}')
def channel():return call('GET',f'/api/v1/channels/{CH}')[1]
def wait_running(minimum=2,seconds=300):
 dl=time.monotonic()+seconds
 while time.monotonic()<dl:
  try:
   s=channel();st=s['stats']
   if s['state']=='running' and st['consecutive_errors']==0 and st['inference_count']>=minimum:return s
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('channel did not run cleanly')
YOLO={'model':{'name':'yolo26x','adapter':'yolo26_bpu','path':'models/derived/s100p/yolo26x.hbm','input_size':[640,640],'stride':32,
               'provider':'bpu','engine_cache':'','class_names':None,'prompts':None},
      'preprocess':{'letterbox':True,'interpolation':'bilinear','normalize':True,'mean':[0,0,0],'std':[255,255,255],'rgb_order':True},
      'inference_fps':5,'analytics':{'enabled':True}}
def main():
 assert not OUT.exists()
 before=channel();orig=before['config']
 restore={'model':orig['model'],'preprocess':{k:orig['preprocess'][k] for k in ('letterbox','interpolation','normalize','mean','std','rgb_order')},
          'inference_fps':orig['inference_fps'],'analytics':orig.get('analytics',{'enabled':False})}
 r=dict(status='running',started=time.time(),window_seconds=WINDOW,original_config=orig)
 def save():OUT.write_text(json.dumps(r,indent=1,ensure_ascii=False)+'\n')
 save()
 try:
  code,body=call('PUT',f'/api/v1/channels/{CH}/config',YOLO);r['apply']=dict(code=code,applied_via=body.get('applied_via'),error=body.get('error'))
  assert code==200,body
  s=wait_running(5);sei0=s['stats'].get('publish',{}).get('sei_injected',0);inf0=s['stats']['inference_count']
  frames=[];last=None;dl=time.monotonic()+WINDOW;sample=None
  while time.monotonic()<dl:
   _,lr=call('GET',f'/api/v1/channels/{CH}/results/latest');res=lr.get('result') or {}
   key=(res.get('frame_pts_ns'),res.get('timestamp'))
   if lr.get('has_result') and key!=last:
    last=key;dets=res.get('detections',[])
    if sample is None and any(d.get('track_id') for d in dets):sample=res
    frames.append(dict(pts=res.get('frame_pts_ns'),ts=res.get('timestamp'),
      dets=[dict(t=d.get('track_id'),c=d.get('class_name'),p=d.get('confidence'),b=d.get('bbox'),
                 s={k:v for k,v in d.items() if k.startswith('track') and k!='track_id'}) for d in dets],
      analytics=(res.get('model_extra') or {}).get('analytics')))
   time.sleep(0.1)
  s=channel();st=s['stats']
  ids=collections.defaultdict(list)
  for i,f in enumerate(frames):
   for d in f['dets']:
    if d['t']:ids[d['t']].append(i)
  life=[len(v) for v in ids.values()]
  r['observed']=dict(frames=len(frames),detections=sum(len(f['dets']) for f in frames),
    with_track_id=sum(1 for f in frames for d in f['dets'] if d['t']),distinct_tracks=len(ids),
    track_frames_median=statistics.median(life) if life else 0,track_frames_max=max(life) if life else 0,
    long_tracks=sum(1 for x in life if x>=10),inference_delta=st['inference_count']-inf0,
    sei_injected_delta=st.get('publish',{}).get('sei_injected',0)-sei0,consecutive_errors=st['consecutive_errors'],
    last_error=st.get('last_error'),analytics_stats=st.get('analytics'),inference_fps_actual=st.get('inference_fps_actual'))
  r['sample_result']=sample;r['frames']=frames;r['status']='observed'
 except BaseException:r.update(status='failed',error=traceback.format_exc());raise
 finally:
  try:
   code,body=call('PUT',f'/api/v1/channels/{CH}/config',restore)
   s=wait_running(2);now=s['config']
   diff={k:(now.get(k),orig.get(k)) for k in set(now)|set(orig) if now.get(k)!=orig.get(k)}
   r['restore']=dict(code=code,error=body.get('error'),config_identical=not diff,diff=diff,state=s['state'])
  except BaseException:r['restore_error']=traceback.format_exc()
  r['finished']=time.time();save()
 print(json.dumps({k:r.get(k) for k in ('status','apply','observed','restore','restore_error','error')},ensure_ascii=False)[:3000])
if __name__=='__main__':main()
