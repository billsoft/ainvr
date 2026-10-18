"""Same-process O0 versus same-BC O2 MoonViT27 chain:per-stage byte parity and A/B timing.

Both linked HBMs are loaded once. Every one of 18 frozen cases runs twice per
variant in alternating order; at every stage the O2 output must be byte-equal to
the O0 output for the same input, and final O0 tails must equal the stored
production board tails. No model, service or configuration is changed.
"""
from pathlib import Path
import argparse,os,json,time,hashlib,gc,traceback
import numpy as np
import hbm_runtime
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
O0=BASE/'official-vision-all27-native-v1-board-package';O0_MANIFEST='e99a294b02082fdb81c9e0f0ad64ce6a79e54c5dc7a1aee6767b7f085e8b26b3';O0_HBM='8020083c93cea4d1e3d00e7c316a8b268b05c598c2b4b601088e3a13c9961da1'
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def ticks():return Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]
p=argparse.ArgumentParser();p.add_argument('--package-root',type=Path,required=True);p.add_argument('--manifest-sha',required=True);a=p.parse_args()
root=a.package_root.resolve();assert root.parent==BASE and os.getuid()==1000 and sha(root/'manifest.json')==a.manifest_sha
m=json.loads((root/'manifest.json').read_text());assert m['schema']=='locateanything_vision_all27_o2_board_v283' and m['reference_manifest_sha256']==O0_MANIFEST
assert sha(O0/'manifest.json')==O0_MANIFEST;ref=json.loads((O0/'manifest.json').read_text());assert ref['stage_count']==27 and ref['case_count']==18
for n,e in ref['files'].items():
 q=O0/n;assert q.is_file() and not q.is_symlink() and q.stat().st_size==e['bytes'] and sha(q)==e['sha256']
assert sha(O0/'official-q8/model.hbm')==O0_HBM
for n,e in m['files'].items():
 q=root/n;assert q.is_file() and not q.is_symlink() and q.stat().st_size==e['bytes'] and sha(q)==e['sha256']
programs=ref['programs'];names=[x['name'] for x in programs];assert [x['name'] for x in m['programs']]==names
r=dict(status='loading',started=time.time(),source_sha256=sha(Path(__file__)),o0_hbm_sha256=O0_HBM,o2_hbm_sha256=m['o2_hbm_sha256'],board_calls=0,
 stage_comparisons=0,stage_byte_mismatches=0,o0_tail_matches_production_board=True,repeats_bitwise_exact=True,all_models_released=False,whole_model_verified=False,release_approved=False)
def persist():
 q=root/'board-proof-v283.json.tmp';q.write_text(json.dumps(r,indent=2)+'\n');q.replace(root/'board-proof-v283.json')
def phase(stage):(root/'phase-v283.json').write_text(json.dumps(dict(stage=stage,pid=os.getpid(),start_ticks=ticks()))+'\n')
persist();rt0=rt2=None;x=None;answer=None
try:
 phase('load');t=time.perf_counter();rt0=hbm_runtime.HB_HBMRuntime(str(O0/'official-q8/model.hbm'));rt2=hbm_runtime.HB_HBMRuntime(str(root/'official-q8/model.hbm'))
 for rt in (rt0,rt2):assert set(rt.model_names)==set(names);rt.set_scheduling_params(bpu_cores={n:[0] for n in rt.model_names})
 r['load_seconds']=time.perf_counter()-t;r['status']='running';phase('chains');persist()
 per={v:{n:[] for n in names} for v in ['o0','o2']};chain={'o0':[],'o2':[]}
 def run(rt,name,program,x):
  s=time.perf_counter();ans=rt.run({name:{program['inputs'][0]['name']:x}})[name];y=np.asarray(ans[program['outputs'][0]['name']]).copy();ms=(time.perf_counter()-s)*1e3
  assert y.shape==(512,1152) and y.dtype==np.float32 and np.isfinite(y).all();r['board_calls']+=1;return y,ms
 for case in range(18):
  d=O0/f'case-{case:02d}';initial=np.load(d/'input-00.npy',allow_pickle=False);prod=np.load(O0/f'actual-case{case:02d}-tail.npy',allow_pickle=False);first={}
  for repeat in range(2):
   order=['o0','o2'] if (case+repeat)%2==0 else ['o2','o0'];x0=x2=initial;tot={'o0':0.,'o2':0.}
   for stage,program in enumerate(programs):
    name=program['name']
    for v in order:
     if v=='o0':x0,ms=run(rt0,name,program,x0)
     else:x2,ms=run(rt2,name,program,x2)
     tot[v]+=ms
     if repeat:per[v][name].append(ms)
    r['stage_comparisons']+=1;r['stage_byte_mismatches']+=int(x0.tobytes()!=x2.tobytes())
    if x0.tobytes()!=x2.tobytes():x2=x0.copy()  # keep later stages comparing identical inputs
   r['o0_tail_matches_production_board'] &= x0.tobytes()==prod.tobytes()
   if repeat==0:first=dict(o0=x0.copy(),o2=x2.copy())
   else:
    r['repeats_bitwise_exact'] &= x0.tobytes()==first['o0'].tobytes()
    for v in tot:chain[v].append(tot[v])
  persist()
 r['per_stage_median_ms']={v:{n:float(np.median(per[v][n])) for n in names} for v in per}
 r['chain_median_ms']={v:float(np.median(chain[v])) for v in chain};r['chain_p95_ms']={v:float(np.percentile(chain[v],95)) for v in chain}
 r['chain_speed_ratio_o0_over_o2']=r['chain_median_ms']['o0']/r['chain_median_ms']['o2']
 r['status']='completed' if r['stage_byte_mismatches']==0 and r['o0_tail_matches_production_board'] and r['repeats_bitwise_exact'] else 'completed_with_mismatch'
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:rt0=rt2=None;x=None;answer=None;gc.collect();r['all_models_released']=True;r['finished']=time.time();persist();phase('released')
print(json.dumps({k:r.get(k) for k in ['status','board_calls','stage_comparisons','stage_byte_mismatches','o0_tail_matches_production_board','chain_median_ms','chain_speed_ratio_o0_over_o2']}))
