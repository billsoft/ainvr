"""v328: official instruction template vs raw description (single and 4-category), full answers kept for GT scoring.

Bounded multi-category probe on the installed LocateAnything BPU backend (no model/config change).

Sends official multi-category queries ("person</c>car</c>...", the README detect() form) for the
32 frozen-160 images and compares each category's boxes with that category's single-query answer
from the installed v14/v320 full-160 run. Production AI is stopped for the probe (BPU without
contention) and restarted in finally; recorder/ingest/backend stay running.
"""
from pathlib import Path
import argparse,json,os,socket,struct,subprocess,sys,time,traceback,statistics,urllib.request
import numpy as np
ROOT=Path('/home/sunrise/ainvr');RUNTIME=ROOT/'ai-service/runtime';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
REF=BASE/'independent-final-native-reference-v2-head-o2';SINGLE=BASE/'text-gptq8-o2-eval160-v321/status.json'
SIDECAR=ROOT/'ai-service/models/derived/s100p/locateanything-3b.hbm.ainvr.json';OUT=ROOT/'test/results/locateanything-prompt-template-probe-v328.json'
CHANNEL='2baec0a3-9941-47dc-b1bd-d3d284488097';TOKEN_SHA='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40'
REF_S,REF_E,BOX_S,BOX_E,COORD0,NONE,SEP,END=151672,151673,151668,151669,151677,4064,152680,151645
CATS=['person','car','bicycle','dog']
TPL='Locate all the instances that matches the following description: {}.'
VARIANTS={**{f'raw_{c}':[c] for c in CATS},**{f'tpl_{c}':[c] for c in CATS},'tpl_four':CATS}
def query(name,cats):return TPL.format('</c>'.join(cats)) if name.startswith('tpl') else '</c>'.join(cats)
def receive(s,n):
 b=[]
 while n:
  x=s.recv(n)
  if not x:raise ConnectionError('incomplete backend response')
  b.append(x);n-=len(x)
 return b''.join(b)
def rpc(sock,sha,header,payload=b''):
 header.update(schema_version=1,contract_sha256=sha,input_bytes=len(payload));raw=json.dumps(header).encode();t=time.monotonic()
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
  # The backend accepts only its own uid (SO_PEERCRED); connect as sunrise, keep root for systemctl.
  s.settimeout(300);os.seteuid(1000)
  try:s.connect(sock)
  finally:os.seteuid(0)
  s.sendall(struct.pack('!I',len(raw))+raw+payload)
  n=struct.unpack('!I',receive(s,4))[0];assert 0<n<=8*1024**2;a=json.loads(receive(s,n))
 return a,time.monotonic()-t
def groups(ids,decode):
 """[(ref text or None, [box...])] in generation order; box=[x1,y1,x2,y2] in 0..1000."""
 out=[];i=0;cur=None
 while i<len(ids):
  t=ids[i]
  if t==REF_S:
   j=ids.index(REF_E,i+1) if REF_E in ids[i+1:] else len(ids)
   cur=(decode(ids[i+1:j]).strip(),[]);out.append(cur);i=j+1;continue
  if t==BOX_S:
   j=i+1
   while j<len(ids) and ids[j]!=BOX_E:j+=1
   body=ids[i+1:j]
   if cur is None:cur=(None,[]);out.append(cur)
   if len(body)==4 and all(COORD0<=v<=COORD0+1000 for v in body):cur[1].append([v-COORD0 for v in body])
   elif body!=[NONE]:cur[1].append(('malformed',body))
   i=j+1;continue
  i+=1
 return out
def iou(a,b):
 w=max(0,min(a[2],b[2])-max(a[0],b[0]));h=max(0,min(a[3],b[3])-max(a[1],b[1]));i=w*h
 u=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i;return i/u if u>0 else 0
def matches(p,r,t):
 used=set();m=0
 for x in p:
  best=max(((iou(x,y),k) for k,y in enumerate(r) if k not in used),default=(0,None))
  if best[1] is not None and best[0]>=t:used.add(best[1]);m+=1
 return m
def channel(key):
 req=urllib.request.Request(f'http://127.0.0.1:8000/api/v1/channels/{CHANNEL}',headers={'X-Api-Key':key})
 with urllib.request.urlopen(req,timeout=5) as f:return json.load(f)
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--images',type=int,default=32);a=ap.parse_args()
 assert os.getuid()==0 and not OUT.exists()
 sys.path.insert(0,str(RUNTIME));from locateanything_prompt import LocateAnythingPrompt
 prompt=LocateAnythingPrompt(BASE/'tokenizer-original-v1.json',TOKEN_SHA);decode=lambda x:prompt.decode(x)
 gen=json.loads(SIDECAR.read_text())['generation'];sock,sha=gen['socket'],gen['contract_sha256']
 ref=json.loads((REF/'reference-index-v3.json').read_text())['cases'];single=json.loads(SINGLE.read_text())['cases']
 per={} # image_id -> {pixels, single:{cat:{boxes,seconds,tokens}}}
 for rc,sc in zip(ref,single):
  assert rc['index']==sc['index']
  if rc['kind']!='box' or rc['query'] not in CATS:continue
  e=per.setdefault(rc['image_id'],dict(pixels=rc['pixels'],single={}))
  e['single'][rc['query']]=dict(boxes=sc['candidate']['boxes'] if sc.get('candidate') else None,terminal=sc['terminal'],seconds=sc['rpc_seconds'],tokens=len(sc['answer']['generated_ids']))
 images=[k for k,v in per.items() if len(v['single'])==4][:a.images]
 key=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key']
 r=dict(status='running',started=time.time(),contract_sha256=sha,images=len(images),variants=VARIANTS,cases=[])
 def save():OUT.write_text(json.dumps(r,indent=1,ensure_ascii=False)+'\n')
 save();before=channel(key);r['channel_before']=dict(state=before['state'],inference_count=before['stats']['inference_count'])
 try:
  subprocess.check_call(['systemctl','stop','ainvr-ai'],timeout=120);time.sleep(2)
  h,_=rpc(sock,sha,dict(operation='health'));assert h['ok'] and h['ready'] and not h['busy'],h
  for image in images:
   e=per[image];px=np.load(REF/e['pixels'],allow_pickle=False)
   chw=np.ascontiguousarray(px.reshape(16,32,3,14,14).transpose(2,0,3,1,4).reshape(3,224,448)).astype('<f4',copy=False)
   for name,cats in VARIANTS.items():
    q=query(name,cats);ans,sec=rpc(sock,sha,dict(operation='generate',description=q,tokens=256,input_shape=[3,224,448],pixel_format='rgb-chw-f32le'),chw.tobytes())
    item=dict(image_id=image,variant=name,query=q,categories=cats,ok=ans.get('ok') is True,seconds=sec,error=None if ans.get('ok') else ans,
              answer={k:ans.get(k) for k in ['generated_ids','terminal','stopped_at_token_limit','response']})
    if item['ok']:
     ids=ans['generated_ids'];g=groups(ids,decode)
     item.update(terminal=ans['terminal'],stopped_at_token_limit=ans.get('stopped_at_token_limit'),tokens=len(ids),prompt_ok=True,
                 refs=[x[0] for x in g],response=ans.get('response'),neural_cpu_fallback=ans.get('neural_cpu_fallback'))
     item['refs']=[x[0] for x in g]
    r['cases'].append(item);save()
  r['status']='completed'
 except BaseException:r.update(status='failed',error=traceback.format_exc());raise
 finally:
  try:
   subprocess.check_call(['systemctl','start','ainvr-ai'],timeout=120);dl=time.monotonic()+240
   while True:
    try:
     s=channel(key)
     if s['state']=='running' and s['stats']['inference_count']>=2 and s['stats']['consecutive_errors']==0:break
    except Exception:pass
    if time.monotonic()>dl:r['restore_error']='channel did not resume';break
    time.sleep(1)
   r['channel_after']=dict(state=s['state'],inference_count=s['stats']['inference_count'],config_same=s['config']==before['config'])
  except BaseException:r['restore_error']=traceback.format_exc()
  r['finished']=time.time();save()
 print(json.dumps(dict(status=r['status'],cases=len(r['cases']),restore_error=r.get('restore_error'),after=r.get('channel_after')),ensure_ascii=False))
if __name__=='__main__':main()
