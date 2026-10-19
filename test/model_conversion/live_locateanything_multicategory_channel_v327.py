"""v327: live multi-category check on the existing gate channel, then exact restore.

Temporarily sets three label slots (person/car/bicycle) through the normal config API,
observes real results/SEI/archive labels, checks an over-long label set is rejected with
422 before saving, and restores the channel's original model fields in finally.
"""
from pathlib import Path
import json,time,traceback,urllib.request,urllib.error,collections
ROOT=Path('/home/sunrise/ainvr');CH='2baec0a3-9941-47dc-b1bd-d3d284488097'
OUT=ROOT/'test/results/locateanything-multicategory-live-channel-v327.json'
KEY=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key']
def call(method,path,body=None):
 req=urllib.request.Request('http://127.0.0.1:8000'+path,method=method,headers={'X-Api-Key':KEY,'Content-Type':'application/json'},
                            data=None if body is None else json.dumps(body).encode())
 try:
  with urllib.request.urlopen(req,timeout=30) as f:return f.status,json.load(f)
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read() or b'{}')
def channel():return call('GET',f'/api/v1/channels/{CH}')[1]
def wait_running(after_count=None,seconds=300):
 dl=time.monotonic()+seconds
 while time.monotonic()<dl:
  try:
   s=channel();st=s['stats']
   if s['state']=='running' and st['consecutive_errors']==0 and st['inference_count']>=(after_count or 2):return s
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('channel did not run cleanly')
SLOTS=[{'description':'person','label_id':'person','label_name':'人'},
       {'description':'car','label_id':'car','label_name':'汽车'},
       {'description':'bicycle','label_id':'bicycle','label_name':'自行车'}]
def main():
 assert not OUT.exists()
 before=channel();orig={k:before['config']['model'].get(k) for k in ('description','label_id','label_name','prompts','class_names','max_new_tokens')}
 r=dict(status='running',started=time.time(),original_model_fields=orig,original_inference_fps=before['config']['inference_fps'])
 def save():OUT.write_text(json.dumps(r,indent=1,ensure_ascii=False)+'\n')
 save()
 try:
  code,body=call('PUT',f'/api/v1/channels/{CH}/config',{'model':{'prompts':SLOTS,'description':'person','label_id':'person','label_name':'人','class_names':None}})
  r['apply']=dict(code=code,body=body);assert code==200,body
  s=wait_running(4);start=time.time();seen=collections.Counter();frames=0;meta=[];sei0=s['stats'].get('publish',{}).get('sei_injected',0)
  last=None;dl=time.monotonic()+120
  while time.monotonic()<dl:
   _,lr=call('GET',f'/api/v1/channels/{CH}/results/latest')
   res=lr.get('result') or {}
   stamp=res.get('frame_pts_ns') or res.get('timestamp') or json.dumps(res.get('detections'))[:200]
   if lr.get('has_result') and stamp!=last:
    last=stamp;frames+=1
    for d in res.get('detections',[]):seen[(d['label_id'],d['class_name'],d['query_description'],d['class_id'])]+=1
    meta.append(res.get('model_extra',{}).get('grounding'))
   time.sleep(1)
  s=channel();r['observed']=dict(frames=frames,labels=[dict(label_id=a,class_name=b,query=c,class_id=d,count=n) for (a,b,c,d),n in seen.items()],
    grounding_samples=meta[-3:],inference_count=s['stats']['inference_count'],consecutive_errors=s['stats']['consecutive_errors'],
    sei_injected_delta=s['stats'].get('publish',{}).get('sei_injected',0)-sei0,last_error=s.get('last_error') or s['stats'].get('last_error'),
    median_inference_ms=s['stats'].get('inference_ms_p50') or s['stats'].get('avg_inference_ms'))
  _,snap=call('GET',f'/api/v1/channels/{CH}/snapshots?limit=200')
  recent=[x for x in snap.get('items',[]) if x.get('timestamp',0)>=start-5]
  r['archived']=dict(collections.Counter(x['label_id'] for x in recent))
  for lid in ('person','car'):
   code,body=call('GET',f'/api/v1/channels/{CH}/snapshots?limit=50&label_id={lid}')
   r.setdefault('archive_label_filter',{})[lid]=dict(code=code,all_match=all(x.get('label_id')==lid for x in body.get('items',[])),items=len(body.get('items',[])))
  long=[{'description':('a person wearing a bright safety vest and a hard hat number %d near the gate '%i)*2,'label_id':f'long{i}','label_name':f'长{i}'} for i in range(8)]
  code,body=call('PUT',f'/api/v1/channels/{CH}/config',{'model':{'prompts':long,'description':long[0]['description'],'label_id':'long0','label_name':'长0','class_names':None}})
  r['overlong']=dict(code=code,body=body,channel_state_after=channel()['state'],config_still_three=len(channel()['config']['model'].get('prompts') or [])==3)
  r['status']='observed'
 except BaseException:r.update(status='failed',error=traceback.format_exc());raise
 finally:
  try:
   code,body=call('PUT',f'/api/v1/channels/{CH}/config',{'model':{'prompts':None,'description':orig['description'],'label_id':orig['label_id'],'label_name':orig['label_name'],'class_names':orig['class_names']}})
   s=wait_running(2);m=s['config']['model']
   r['restore']=dict(code=code,model_fields_restored={k:m.get(k) for k in orig}==orig or {k:(m.get(k),orig[k]) for k in orig if m.get(k)!=orig[k]},
                     inference_fps_same=s['config']['inference_fps']==r['original_inference_fps'],state=s['state'])
  except BaseException:r['restore_error']=traceback.format_exc()
  r['finished']=time.time();save()
 print(json.dumps({k:r.get(k) for k in ('status','apply','observed','archived','archive_label_filter','overlong','restore','restore_error','error')},ensure_ascii=False)[:4000])
if __name__=='__main__':main()
