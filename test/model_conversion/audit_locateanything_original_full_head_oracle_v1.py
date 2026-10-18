"""Compare full Q8 head to original BF16 norm+BF16 tied projection on fixed inputs."""
from pathlib import Path
import os,sys,json,time,hashlib,types,importlib,traceback
os.environ['CUDA_VISIBLE_DEVICES']='';sys.path.insert(0,'/opt/locate-reference-deps')
import torch
import numpy as np
from safetensors import safe_open
torch.set_num_threads(2);out=Path('/work/official-llm-v1/locateanything-official-full-head-original-oracle-audit-v1.json');assert not out.exists()
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def metric(a,b):
 a=np.asarray(a,np.float64);b=np.asarray(b,np.float64);assert a.shape==b.shape and np.isfinite(a).all() and np.isfinite(b).all();return dict(rel_l2=float(np.linalg.norm(a-b)/max(np.linalg.norm(b),1e-12)),max_abs=float(np.abs(a-b).max()))
r=dict(status='loading_original_head',started=time.time(),source_sha256=sha(__file__),scope=__doc__,original_model_code_sha256=sha('/model/modeling_qwen2.py'),old_reference='Original F32 norm/projection,then BF16 output formatting;not native BF16 hidden norm and matmul arithmetic',new_reference='Original model Qwen2RMSNorm on BF16 input,original BF16 gamma,original BF16 tied embedding/projection and BF16 matmul',neural_cpu_test_oracle_only=True,whole_model_verified=False,release_approved=False,rows=[])
def persist():
 p=out.with_suffix('.json.tmp');p.write_text(json.dumps(r,indent=2)+chr(10));p.replace(out)
persist()
try:
 pkg=types.ModuleType('locate_original_head_oracle');pkg.__path__=['/model'];sys.modules[pkg.__name__]=pkg;N=importlib.import_module(pkg.__name__+'.modeling_qwen2').Qwen2RMSNorm;idx=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map'];name='language_model.model.embed_tokens.weight'
 with safe_open('/model/'+idx[name],framework='pt',device='cpu') as f:w=f.get_tensor(name)
 assert w.dtype==torch.bfloat16 and w.shape==(152681,2048);n=N(2048,eps=1e-6).bfloat16().eval();name='language_model.model.norm.weight'
 with safe_open('/model/'+idx[name],framework='pt',device='cpu') as f:n.weight.data.copy_(f.get_tensor(name))
 root=Path('/opt/locate-official-full-head-w8-v1')
 with torch.inference_mode():
  for case in range(8):
   d=root/'fixtures'/f'case-{case:02d}';x=np.load(d/'input-00.npy');native=torch.nn.functional.linear(n(torch.from_numpy(x).bfloat16()),w).float().numpy();candidate=np.load(d/'compiler-00.npy');old=np.load(d/'native-formatted.npy');a=int(native.argmax());b=int(candidate.argmax());r['rows'].append(dict(case=case,input_sha256=sha(d/'input-00.npy'),compiler_vs_original_native_bf16=metric(candidate,native),old_f32_rounded_vs_original_native_bf16=metric(old,native),native_token=a,candidate_token=b,native_top1_equal=a==b));np.save(d/'original-native-bf16-head-audit-v1.npy',native);persist()
 r.update(status='completed',actual_original_head_calls=8,native_top1_matches=sum(x['native_top1_equal'] for x in r['rows']))
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:r['finished']=time.time();persist()
print(json.dumps({k:r.get(k) for k in ['status','native_top1_matches','rows','error']},indent=2))
