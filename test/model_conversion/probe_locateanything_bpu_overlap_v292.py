"""Bounded BPU saturation/overlap probe with the qualified MoonViT27 O2 HBM (production concurrent).

Phase A: one thread chains frozen cases for 20s. Phase B: two threads, each with its own
runtime instance of the same HBM, for 20s. /sys/devices/system/bpu/ratio is sampled every
20ms throughout. Every final output must equal the stored board tail byte-for-byte.
No model/service/configuration change; all runtimes released in finally.
"""
from pathlib import Path
import hashlib,json,os,threading,time,traceback,gc
import numpy as np
import hbm_runtime
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
O0=BASE/'official-vision-all27-native-v1-board-package';PKG=BASE/'vision-all27-o2-v283-board-package'
HBM=PKG/'official-q8/model.hbm';HBM_SHA='63c7e861ffd1007ddd09cc9febb0e499245fa7e4eb8830af9de5220b28f7cc9c'
REPORT=Path('/home/sunrise/ainvr/test/results/locateanything-bpu-overlap-probe-v292.json')
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
assert os.getuid()==1000 and not REPORT.exists() and sha(HBM)==HBM_SHA
programs=json.loads((O0/'manifest.json').read_text())['programs']
cases=[(np.load(O0/f'case-{i:02d}/input-00.npy',allow_pickle=False),np.load(O0/f'actual-case{i:02d}-tail.npy',allow_pickle=False).tobytes()) for i in range(18)]
r=dict(status='running',started=time.time(),source_sha256=sha(__file__),hbm_sha256=HBM_SHA,production_concurrent=True,phases={},mismatches=0,all_models_released=False)
stop=threading.Event();ratios=[]
def sampler():
 while not stop.is_set():ratios.append((time.time(),int(open('/sys/devices/system/bpu/ratio').read().split()[0])));time.sleep(.02)
def chain(rt,x):
 for p in programs:
  n=p['name'];x=np.asarray(rt.run({n:{p['inputs'][0]['name']:x}})[n][p['outputs'][0]['name']]).copy()
 return x
def worker(rt,seed,until,out):
 i=seed;done=0
 while time.time()<until:
  x,gold=cases[i%18];y=chain(rt,x);out['mismatch']+=int(y.tobytes()!=gold);done+=1;i+=1
 out['chains']=done
rts=[]
try:
 for _ in range(2):
  rt=hbm_runtime.HB_HBMRuntime(str(HBM));rt.set_scheduling_params(bpu_cores={n:[0] for n in rt.model_names});rts.append(rt)
 chain(rts[0],cases[0][0]);chain(rts[1],cases[1][0])
 th=threading.Thread(target=sampler,daemon=True);th.start()
 for name,n in [('single_thread',1),('two_threads',2)]:
  t0=time.time();until=t0+20;outs=[dict(mismatch=0) for _ in range(n)]
  ts=[threading.Thread(target=worker,args=(rts[k],k*9,until,outs[k])) for k in range(n)]
  [t.start() for t in ts];[t.join() for t in ts];t1=time.time()
  win=[v for (t,v) in ratios if t0<=t<=t1];chains=sum(o['chains'] for o in outs);r['mismatches']+=sum(o['mismatch'] for o in outs)
  r['phases'][name]=dict(seconds=t1-t0,chains=chains,chains_per_second=chains/(t1-t0),bpu_mean_ratio=sum(win)/len(win),bpu_samples=len(win),bpu_ratio_100_fraction=sum(v>=100 for v in win)/len(win))
 stop.set();r['status']='completed' if r['mismatches']==0 else 'completed_with_mismatch'
except BaseException:r.update(status='failed',error=traceback.format_exc())
finally:
 stop.set();rts.clear();gc.collect();r['all_models_released']=True;r['finished']=time.time()
 REPORT.write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({k:r.get(k) for k in ['status','phases','mismatches','error']},indent=1))
