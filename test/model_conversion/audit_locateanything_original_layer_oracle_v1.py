"""Original model's unmodified layer code/weights on fixed captured states;no production CPU inference."""
from pathlib import Path
import os,sys,json,hashlib,time,traceback,types,importlib
os.environ['CUDA_VISIBLE_DEVICES']='';sys.path.insert(0,'/opt/locate-reference-deps')
import numpy as np
import torch
from safetensors import safe_open
out=Path('/work/official-llm-v1/locateanything-official-qwen-original-oracle-audit-v1.json');assert not out.exists();torch.set_num_threads(2)
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
r=dict(status='loading_original_layer',started=time.time(),source_sha256=sha(__file__),scope=__doc__,capture_provenance='GPTQ W4 v1 BF16 model;captured outputs are NOT original-weight reference',original_model_code_sha256=sha('/model/modeling_qwen2.py'),original_config_code_sha256=sha('/model/configuration_qwen2.py'),whole_model_verified=False,release_approved=False,neural_cpu_test_oracle_only=True,rows=[])
def persist():
 p=out.with_suffix('.json.tmp');p.write_text(json.dumps(r,indent=2)+chr(10));p.replace(out)
def metric(a,b):
 a=np.asarray(a,np.float64);b=np.asarray(b,np.float64);assert a.shape==b.shape and np.isfinite(a).all() and np.isfinite(b).all();return dict(rel_l2=float(np.linalg.norm(a-b)/max(np.linalg.norm(b),1e-12)),max_abs=float(np.abs(a-b).max()))
persist()
try:
 pkg=types.ModuleType('locate_original_layer_oracle');pkg.__path__=['/model'];sys.modules[pkg.__name__]=pkg
 C=importlib.import_module(pkg.__name__+'.configuration_qwen2').Qwen2Config;M=importlib.import_module(pkg.__name__+'.modeling_qwen2').Qwen2DecoderLayer
 from transformers.cache_utils import DynamicCache
 cfg=C(**json.loads(Path('/model/config.json').read_text())['text_config']);cfg._attn_implementation='sdpa';idx=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map'];prefix='language_model.model.layers.0.';state={}
 for shard in sorted({v for k,v in idx.items() if k.startswith(prefix)}):
  with safe_open('/model/'+shard,framework='pt',device='cpu') as f:
   for k,v in idx.items():
    if k.startswith(prefix) and v==shard:state[k[len(prefix):]]=f.get_tensor(k)
 r['original_parameter_hashes']={k:hashlib.sha256(v.float().numpy().tobytes()).hexdigest() for k,v in state.items()};models={}
 for name,dtype in [('bf16',torch.bfloat16),('fp32',torch.float32)]:
  m=M(cfg,0);m.load_state_dict(state,strict=True);m=m.to(dtype).eval();models[name]=m
 for seq in [1,256]:
  source=Path(f'/opt/locate-official-qwen-layer0-w8-s{seq}-v4');s=json.loads((source/'status.json').read_text());assert r['original_parameter_hashes']==s['original_parameter_hashes'];selected=[(im,'slow',call) for im in [1144,2444] for call in [1,2]] if seq==1 else [(im,mode,0) for im in [1144,2444] for mode in ['slow','hybrid']]
  for i,(image,mode,call) in enumerate(selected):
   d=Path('/work/all-decoder-layer-captures-v1')/f'gptq-bf16-{image}-{mode}'/f'block0-call-{call}';x=np.load(d/'hidden_states.npy',allow_pickle=False);position=np.load(d/'position_ids.npy',allow_pickle=False);mask=np.load(d/'attention_mask.npy',allow_pickle=False) if (d/'attention_mask.npy').exists() else None;gold={}
   with torch.inference_mode():
    for name,dtype in [('bf16',torch.bfloat16),('fp32',torch.float32)]:
     cache=DynamicCache()
     if (d/'past-0.npy').exists():cache.update(torch.from_numpy(np.load(d/'past-0.npy')).to(dtype),torch.from_numpy(np.load(d/'past-1.npy')).to(dtype),0)
     output=models[name](torch.from_numpy(x).to(dtype),attention_mask=torch.from_numpy(mask).to(dtype) if mask is not None else None,position_ids=torch.from_numpy(position).long(),past_key_value=cache,use_cache=True)[0];gold[name]=output.float().numpy()[0]
   compiled=np.load(source/'fixtures'/f'case-{i:02d}'/'compiler-00.npy')[:x.shape[1]];captured=np.load(d/'hidden_output.npy')[0];entry=dict(sequence=seq,fixture=i,image=image,mode=mode,call=call,input_sha256=sha(d/'hidden_states.npy'),capture_target_sha256=sha(d/'hidden_output.npy'),compiler_vs_original_bf16=metric(compiled,gold['bf16']),compiler_vs_original_fp32=metric(compiled,gold['fp32']),gptq_capture_vs_original_bf16=metric(captured,gold['bf16']),original_fp32_vs_original_bf16=metric(gold['fp32'],gold['bf16']));r['rows'].append(entry)
   np.save(source/'fixtures'/f'case-{i:02d}'/'original-weight-bf16-hidden-audit-v1.npy',gold['bf16']);np.save(source/'fixtures'/f'case-{i:02d}'/'original-weight-fp32-hidden-audit-v1.npy',gold['fp32']);persist()
 r.update(status='completed',actual_original_code_layer_calls=16,original_parameter_counts=sum(x.numel() for x in state.values()))
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:r['finished']=time.time();persist()
print(json.dumps({k:r.get(k) for k in ['status','rows','error']},indent=2))
