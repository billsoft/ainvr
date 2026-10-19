"""Review false-positive triage: offline Pillow oracle tensor -> installed BPU executor.

Test-only. Bypasses JPU/GLES entirely so a remaining false positive is attributable to the
model/prompt rather than preprocessing. Does not pause production: retries while the
executor reports a busy generation. Draws generated boxes on the 448x224 model input.
"""
from pathlib import Path
import json,socket,struct,sys,time,hashlib
import numpy as np
from PIL import Image,ImageDraw
ROOT=Path('/home/sunrise/ainvr');SRC=Path('/mnt/ainvr-ssd/analytics-validation')
OUT=ROOT/'test/results/analytics/review-oracle-v1';SIDECAR=ROOT/'ai-service/models/derived/s100p/locateanything-3b.hbm.ainvr.json'
IMAGES={'review-empty':'22b9c7837a929603f8a261a62a3a0e6ac6748f8a3eb0febdb10ce51f33531157','review-person':'6a7b029dc90b526a587b428892a99698fe8dca82a14aa83b3232b6aa1b9cfe49'}
QUERIES=['a person','person','people','dog','car']
def recv(s,n):
 b=b''
 while len(b)<n:
  x=s.recv(n-len(b))
  if not x:raise ConnectionError('closed')
  b+=x
 return b
def rpc(gen,header,payload=b''):
 header.update(schema_version=1,contract_sha256=gen['contract_sha256'],input_bytes=len(payload));raw=json.dumps(header).encode()
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
  s.settimeout(120);s.connect(gen['socket']);s.sendall(struct.pack('!I',len(raw))+raw+payload)
  return json.loads(recv(s,struct.unpack('!I',recv(s,4))[0]))
def oracle(path):
 rgb=Image.open(path).convert('RGB');small=rgb.resize((448,224),Image.BICUBIC)
 return rgb.size,small,(np.asarray(small,dtype=np.float32)/127.5-1.0).transpose(2,0,1).copy()
def main():
 assert not OUT.exists();OUT.mkdir(parents=True)
 gen=json.loads(SIDECAR.read_text())['generation'];r=dict(scope=__doc__,pillow=Image.__version__,cases=[])
 for name,digest in IMAGES.items():
  p=SRC/(name+'.jpg');assert hashlib.sha256(p.read_bytes()).hexdigest()==digest
  size,small,chw=oracle(p);small.save(OUT/(name+'-model-input.png'));np.save(OUT/(name+'-oracle-chw.npy'),chw)
  for q in QUERIES:
   for attempt in range(600):
    a=rpc(gen,dict(operation='generate',description=q,tokens=256,input_shape=[3,224,448],pixel_format='rgb-chw-f32le'),chw.astype('<f4').tobytes())
    if a.get('ok') or a.get('error')!='RuntimeError':break
    time.sleep(.2)
   boxes=[]
   ids=a.get('generated_ids',[]);i=0
   while i<len(ids):
    if ids[i]==151668:
     j=ids.index(151669,i) if 151669 in ids[i:] else len(ids);body=ids[i+1:j]
     if len(body)==4:boxes.append([v-151677 for v in body])
     i=j
    i+=1
   im=small.copy();d=ImageDraw.Draw(im)
   for b in boxes:d.rectangle([b[0]*448/1000,b[1]*224/1000,b[2]*448/1000,b[3]*224/1000],outline=(255,0,0),width=2)
   im.save(OUT/f'{name}-{q.replace(" ","_")}-boxes.png')
   r['cases'].append(dict(image=name,source_size=size,query=q,ok=a.get('ok'),attempts=attempt+1,boxes=boxes,response=a.get('response'),
     terminal=a.get('terminal'),token_logprobs=a.get('token_logprobs'),generated_ids=ids))
   print(name,q,a.get('ok'),len(boxes),boxes[:4],flush=True)
 (OUT/'result.json').write_text(json.dumps(r,indent=1,ensure_ascii=False)+'\n')
if __name__=='__main__':main()
