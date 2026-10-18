"""Bounded decode-shaped two-stream overlap prototype on one official hbm_runtime instance.

Each step reproduces the real per-token CPU/BPU rhythm of four 9-layer groups: unchanged
production routing prepare (CPU) -> AR1 group call (BPU) -> routing commit (CPU), four times.
Phase A: one stream. Phase B: two Python threads sharing the same runtime (officially
supported concurrent run()). BPU ratio sampled every 20ms. Seeded stream outputs must be
byte-identical between phases. Synthetic finite inputs:timing/parity only, not quality.
The 大门 channel is lowered to 0.1fps during the probe and restored to its prior fps in finally.
"""
from pathlib import Path
import hashlib,json,os,sys,threading,time,traceback,gc,urllib.request
from types import SimpleNamespace
import numpy as np
ROOT=Path('/home/sunrise/ainvr');sys.path.insert(0,str(ROOT/'test/model_conversion'))
from locateanything_official_group_routing_v1 import prepare_official_group_arrays,commit_official_group_arrays,OfficialRopeArrays
import hbm_runtime
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1');PKG=BASE/'prefill-g27-o2-v236-board-package'
HBM_SHA='3ea8f1717e87500cff670a21f67043558b3d5058d2ea9541f5d2dfe27cc8b655';NAME='locate_official_qwen_group_27_35_s1'
REPORT=ROOT/'test/results/locateanything-decode-overlap-probe-v294.json';CH='2baec0a3-9941-47dc-b1bd-d3d284488097'
key=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key']
def call(method,path,body=None):
 r=urllib.request.Request('http://127.0.0.1:8000'+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={'X-Api-Key':key,'Content-Type':'application/json'})
 with urllib.request.urlopen(r,timeout=10) as f:return json.load(f)
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
ports=next(x for x in json.loads((PKG/'ports.json').read_text()) if x['name']==NAME);IN=[x['name'] for x in ports['inputs']];OUT=[x['name'] for x in ports['outputs']]
rope=OfficialRopeArrays();ratios=[];stop=threading.Event()
def sampler():
 while not stop.is_set():ratios.append((time.time(),int(open('/sys/devices/system/bpu/ratio').read().split()[0])));time.sleep(.02)
class Stream:
 def __init__(self,seed):
  self.rng=np.random.default_rng(seed);self.reset()
 def reset(self):
  self.p=170;self.caches=[tuple((self.rng.standard_normal((2,170,128))*.1).astype(np.float32) for _ in range(2)) for _ in range(9)]
  self.hidden=(self.rng.standard_normal((1,2048))*.1).astype(np.float32)
 def step(self,rt):
  for g in range(4):
   layout=SimpleNamespace(query_length=1,past_length=self.p,keep_cache_length=self.p+1,positions=np.array([self.p]),visibility=np.ones((1,self.p+1),bool))
   arrays=prepare_official_group_arrays(self.hidden,tuple(self.caches),layout,1,rope)
   out=rt.run({NAME:dict(zip(IN,arrays))})[NAME];outs=[np.asarray(out[n]) for n in OUT]
   h,caches=commit_official_group_arrays(outs,tuple(self.caches),layout,1)
   if g<3:self.hidden=np.ascontiguousarray(h*0+self.hidden)  # keep stream bounded:reuse input hidden across groups
  self.caches=[tuple(np.ascontiguousarray(v) for v in pair) for pair in caches];self.p+=1
  last=np.ascontiguousarray(h,np.float32)
  if self.p>=240:self.reset()
  return last
def run_phase(rt,n,seconds,record):
 streams=[Stream(1000+k) for k in range(n)];counts=[0]*n;first=[[] for _ in range(n)];t0=time.time();until=t0+seconds
 def work(k):
  while time.time()<until:
   y=streams[k].step(rt);counts[k]+=1
   if len(first[k])<record:first[k].append(hashlib.sha256(y.tobytes()).hexdigest())
 ts=[threading.Thread(target=work,args=(k,)) for k in range(n)];[t.start() for t in ts];[t.join() for t in ts];t1=time.time()
 win=[v for t,v in ratios if t0<=t<=t1]
 return dict(seconds=t1-t0,steps=sum(counts),steps_per_second=sum(counts)/(t1-t0),bpu_mean_ratio=sum(win)/len(win),samples=len(win)),first
assert os.getuid()==1000 and not REPORT.exists() and sha(PKG/'model.hbm')==HBM_SHA
r=dict(status='starting',scope=__doc__,started=time.time(),source_sha256=sha(__file__),hbm_sha256=HBM_SHA,phases={},parity_equal=None,restored_fps=None)
prior=None;rt=None
try:
 s=call('GET',f'/api/v1/channels/{CH}');prior=s['config']['inference_fps'];assert s['state']=='running' and s['stats']['consecutive_errors']==0;r['prior_fps']=prior
 call('PUT',f'/api/v1/channels/{CH}/config',{'inference_fps':0.1});time.sleep(12)
 rt=hbm_runtime.HB_HBMRuntime(str(PKG/'model.hbm'));rt.set_scheduling_params(bpu_cores={n:[0] for n in rt.model_names})
 Stream(1).step(rt)
 th=threading.Thread(target=sampler,daemon=True);th.start()
 a,fa=run_phase(rt,1,25,20);b,fb=run_phase(rt,2,25,20)
 r['phases']=dict(single_stream=a,two_streams=b);r['throughput_ratio']=b['steps_per_second']/a['steps_per_second']
 n=min(len(fa[0]),len(fb[0]));r['parity_steps_compared']=n;r['parity_equal']=fa[0][:n]==fb[0][:n]
 r['status']='completed'
except BaseException:r.update(status='failed',error=traceback.format_exc())
finally:
 stop.set();rt=None;gc.collect()
 try:
  if prior is not None:call('PUT',f'/api/v1/channels/{CH}/config',{'inference_fps':prior});r['restored_fps']=call('GET',f'/api/v1/channels/{CH}')['config']['inference_fps']
 except BaseException:r['restore_error']=traceback.format_exc()
 r['finished']=time.time();REPORT.write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({k:r.get(k) for k in ['status','phases','throughput_ratio','parity_steps_compared','parity_equal','restored_fps','error','restore_error']},indent=1))
