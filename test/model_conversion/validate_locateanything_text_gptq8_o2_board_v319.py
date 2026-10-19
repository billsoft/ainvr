"""v319:board component proof for one GPTQ decoder group:O2 versus O0 on the same compiler-reference fixtures.

Loads the O0 (v312) and O2 (v318) group HBMs in one process, alternates them per call (1 warmup + 8 timed
per case and profile). Every O0 and O2 output must be byte-identical to the converted.bc compiler reference.
Production is not paused (parity is load-independent;timing is a paired screen only). No service change.
"""
from pathlib import Path
import argparse,os,json,time,hashlib,gc,traceback,statistics
import numpy as np
import hbm_runtime
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
ap=argparse.ArgumentParser();ap.add_argument('--first',type=int,required=True,choices=[0,9,18,27]);ap.add_argument('--manifest-sha',required=True);a=ap.parse_args()
A,B=a.first,a.first+8;P2=BASE/f'text-gptq8-group-{A}-{B}-o2-v318-board-package';P0=BASE/f'text-gptq8-group-{A}-{B}-o0-v312-board-package'
assert os.getuid()==1000 and sha(P2/'manifest.json')==a.manifest_sha
m=json.loads((P2/'manifest.json').read_text());m0=json.loads((P0/'manifest.json').read_text())
for n,e in m['files'].items():
 q=P2/n;assert q.is_file() and not q.is_symlink() and q.stat().st_size==e['bytes'] and sha(q)==e['sha256']
assert sha(P0/'model.hbm')==m['o0_hbm_sha256']==m0['files']['model.hbm']['sha256']
OUT=P2/'board-proof-v319.json';assert not OUT.exists()
r=dict(status='loading',started=time.time(),source_sha256=sha(Path(__file__)),first=A,last=B,o0_hbm_sha256=m['o0_hbm_sha256'],o2_hbm_sha256=m['o2_hbm_sha256'],calls=0,comparisons=0,mismatches=0,profiles={},production_paused=False,all_models_released=False,release_approved=False)
def save():
 t=OUT.with_name(OUT.name+'.tmp');t.write_text(json.dumps(r,indent=2)+'\n');t.replace(OUT)
save();rt0=rt2=None
try:
 rt0=hbm_runtime.HB_HBMRuntime(str(P0/'model.hbm'));rt2=hbm_runtime.HB_HBMRuntime(str(P2/'model.hbm'))
 for rt in (rt0,rt2):rt.set_scheduling_params(bpu_cores={n:[0] for n in rt.model_names})
 r['status']='running';save()
 for prof in m['profiles']:
  name=prof['name'];ins=[x['name'] for x in prof['inputs']];outs=[x['name'] for x in prof['outputs']];times={'o0':[],'o2':[]};pairs=[]
  for case in prof['cases']:
   d=P2/f"s{prof['sequence']}"/case;inp=[np.load(d/f'input-{i:02d}.npy',allow_pickle=False) for i in range(len(ins))];ref=[np.load(d/f'compiler-{i:02d}.npy',allow_pickle=False) for i in range(len(outs))]
   for rep in range(9):
    order=['o0','o2'] if rep%2==0 else ['o2','o0'];t={}
    for v in order:
     rt=rt0 if v=='o0' else rt2;s=time.perf_counter();res=rt.run({name:dict(zip(ins,inp))})[name];t[v]=(time.perf_counter()-s)*1e3;r['calls']+=1
     for k,o in enumerate(outs):
      y=np.asarray(res[o]);r['comparisons']+=1;r['mismatches']+=int(y.shape!=ref[k].shape or y.tobytes()!=ref[k].tobytes())
    if rep:times['o0'].append(t['o0']);times['o2'].append(t['o2']);pairs.append(t['o0']/t['o2'])
  r['profiles'][str(prof['sequence'])]=dict(o0_median_ms=statistics.median(times['o0']),o2_median_ms=statistics.median(times['o2']),median_paired_speedup=statistics.median(pairs),timed_pairs=len(pairs));save()
 r['status']='completed' if r['mismatches']==0 else 'completed_with_mismatch'
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:rt0=rt2=None;gc.collect();r['all_models_released']=True;r['finished']=time.time();save()
print(json.dumps({k:r.get(k) for k in ['status','calls','comparisons','mismatches','profiles','error']}))
