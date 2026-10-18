"""Native full Qwen group with official W8/A16 modules,prefill256+AR1 shared HBM."""
from pathlib import Path
from types import SimpleNamespace
import os,sys,json,time,hashlib,argparse,traceback,subprocess,gc,types,importlib,fcntl
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
BASE=Path('/opt/locate-oellm-research-v1');sys.path.insert(0,str(BASE/'sdk448-isolated/python'));sys.path.insert(0,str(BASE/'leap-source-overlay'));sys.path.insert(0,'/opt/locate-reference-deps')
import numpy as np
import torch
from safetensors import safe_open
from hbdk4.compiler import leap
from leap_llm.nn.utils import Model
from leap_llm.nn.modules.linear import FakeQuantLinear
from leap_llm.nn.modules.const_fake_quant import ConstFakeQuant
from leap_llm.models.qwen2_5_omni.blocks.transformer_block import Qwen2_5OmniDecoderLayer

def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def metric(a,b):
 a=np.asarray(a,np.float64);b=np.asarray(b,np.float64);assert a.shape==b.shape and np.isfinite(a).all() and np.isfinite(b).all();return dict(rel_l2=float(np.linalg.norm(a-b)/max(np.linalg.norm(b),1e-12)),max_abs=float(np.abs(a-b).max()))
def original_state(index):
 idx=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map'];prefix=f'language_model.model.layers.{index}.';state={}
 for shard in sorted({v for k,v in idx.items() if k.startswith(prefix)}):
  with safe_open('/model/'+shard,framework='pt',device='cpu') as f:
   for k,v in idx.items():
    if k.startswith(prefix) and v==shard:state[k[len(prefix):]]=f.get_tensor(k)
 return state
class Group(Model):
 def __init__(self,first,count):
  super().__init__();self.first=first;self.count=count;self.layers=torch.nn.ModuleList();self.parameter_hashes={};config=SimpleNamespace(**json.loads(Path('/model/config.json').read_text())['text_config'])
  assert config.hidden_size==2048 and config.num_hidden_layers==36 and config.vocab_size==152681
  for index in range(first,first+count):
   m=Qwen2_5OmniDecoderLayer(config,index);state=original_state(index);m.load_state_dict({n:v.float() for n,v in state.items()},strict=True);self.parameter_hashes[str(index)]={n:hashlib.sha256(v.float().numpy().tobytes()).hexdigest() for n,v in state.items()};del state
   for norm in [m.input_layernorm,m.post_attention_layernorm]:norm.fp16_tiny=False;norm.preserve_precision=True
   attn=m.self_attn
   for proj in [attn.q_proj,attn.k_proj,attn.v_proj]:proj.quant_bits=16;proj.out_fake_quant.bits=16
   attn.qk.x_bits=16;attn.qk.y_bits=16;attn.qk.x_fake_quant.bits=16;attn.qk.y_fake_quant.bits=16;attn.sv.y_bits=16;attn.sv.y_fake_quant.bits=16;attn.key_out_fq.bits=16;self.layers.append(m)
  self.set_children_parent()
 def forward(self,hidden,cos,sin,mask,*cache):
  h=hidden[None];result=[]
  for i,layer in enumerate(self.layers):
   h,k,v=layer(h,attention_mask=mask[None,None],position_embeddings=(cos[None,None],sin[None,None]),cache_k=cache[2*i][None],cache_v=cache[2*i+1][None]);result.extend([k[0],v[0]])
  return h[0],*result
 def build(self,hidden,cos,sin,mask,*cache):
  q=hidden.type.shape[0];h=leap.reshape(hidden,[1,q,2048]);c=leap.reshape(cos,[1,1,q,128]);s=leap.reshape(sin,[1,1,q,128]);mask=leap.reshape(mask,[1,1,q,512]);result=[]
  for i,layer in enumerate(self.layers):
   h,k,v=layer(h,attention_mask=mask,position_embeddings=(c,s),cache_k=leap.reshape(cache[2*i],[1,2,512,128]),cache_v=leap.reshape(cache[2*i+1],[1,2,512,128]));result.extend([leap.reshape(k,[2,q,128]),leap.reshape(v,[2,q,128])])
  return leap.reshape(h,[q,2048]),*result

def prepare(case,call,first,count,capacity=None):
 def read(d,n):return np.load(d/(n+'.npy'),allow_pickle=False)
 root=Path(case);d=root/f'block{first}-call-{call}';hidden=read(d,'hidden_states')[0].astype(np.float32);position=read(d,'position_ids').reshape(-1);q=hidden.shape[0];assert 0<q<=256;cap=q if capacity is None else capacity;assert q<=cap
 angle=position.astype(np.float32)[:,None]*(1/(1000000.**(np.arange(0,128,2,dtype=np.float32)/128)))[None];angle=np.concatenate([angle,angle],-1);x=np.zeros((cap,2048),np.float32);x[:q]=hidden;c=np.ones((cap,128),np.float32);s=np.zeros_like(c);c[:q]=np.cos(angle);s[:q]=np.sin(angle);cache=[];raw=[];oldlen=None;native_mask=read(d,'attention_mask') if (d/'attention_mask.npy').exists() else None
 for index in range(first,first+count):
  ld=root/f'block{index}-call-{call}';k=read(ld,'past-0')[0].astype(np.float32) if (ld/'past-0.npy').exists() else np.zeros((2,0,128),np.float32);v=read(ld,'past-1')[0].astype(np.float32) if (ld/'past-1.npy').exists() else np.zeros_like(k);old=k.shape[1];assert old+cap<=512 and k.shape==v.shape
  if oldlen is None:oldlen=old
  assert old==oldlen and np.array_equal(read(ld,'position_ids').reshape(-1),position)
  layer_mask=read(ld,'attention_mask') if (ld/'attention_mask.npy').exists() else None;assert (layer_mask is None)==(native_mask is None) and (native_mask is None or np.array_equal(layer_mask,native_mask));paddedk=np.zeros((2,512,128),np.float32);paddedv=np.zeros_like(paddedk)
  if old:paddedk[:,512-old:]=k;paddedv[:,512-old:]=v
  cache.extend([paddedk,paddedv]);raw.append((k,v))
 mask=np.zeros((q,oldlen+q),np.float32) if native_mask is None else np.where(native_mask[0,0]==0,0.,-512.).astype(np.float32);assert mask.shape==(q,oldlen+q);m=np.full((cap,512),-512.,np.float32);m[:q,512-cap-oldlen:512-cap]=mask[:,:oldlen];m[:q,512-cap:512-cap+q]=mask[:,oldlen:]
 if q<cap:m[q:,512-cap]=0.
 return [x,c,s,m,*cache],dict(hidden=hidden,position=position,native_mask=native_mask,past=raw),q

p=argparse.ArgumentParser();p.add_argument('--first',type=int,required=True);p.add_argument('--layers',type=int,required=True,choices=[3,9]);p.add_argument('--out',type=Path,required=True);a=p.parse_args();assert 0<=a.first and a.first+a.layers<=36 and a.first%a.layers==0 and a.out.parent==Path('/opt') and a.out.name.startswith('locate-official-qwen-group-') and not a.out.exists() and os.getpgrp()==os.getpid();torch.set_num_threads(2);a.out.mkdir();torch.backends.cuda.matmul.allow_tf32=False
r=dict(status='checking',started=time.time(),pid=os.getpid(),source_sha256=sha(__file__),scope=__doc__,first=a.first,layer_count=a.layers,last=a.first+a.layers-1,weight_bits=8,attention_activation_bits=16,high_precision_qpp=True,original_norm_epsilon_preserved=True,cache_input_layout='past right-aligned at end before official query-row shift',official_quantized_linear_build_unmodified=True,quantized_io_removed=False,gpu_calibration_only=True,conditional_reference_input_provenance='GPTQ W4 BF16 captured incoming states;references recomputed with unmodified original code and weights,not whole original trajectories',neural_cpu_or_gpu_production_fallback=False,maximum_compile_seconds=None,calibration=[],profiles=[],whole_model_verified=False,release_approved=False)
def persist():
 p=a.out/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+chr(10));p.replace(a.out/'status.json')
persist()
try:
 pins={'nn/modules/linear.py':'7c68836051e9b065b3e43bf291a13db0261d094d7faa42b7ceccbf3cd6395054','models/qwen2_5_omni/blocks/attention.py':'65d35ebe32a05cf931d20545387eaecaef16dbcd386ed15eef66eb1392bf041f'}
 for name,h in pins.items():assert sha(BASE/'leap-source-overlay/leap_llm'/name)==h
 r['official_sources']=pins;assert torch.cuda.is_available() and torch.cuda.mem_get_info()[0]>12*1024**3,'Preserve miner/GPU headroom before calibration';r['gpu_free_before']=torch.cuda.mem_get_info()[0];m=Group(a.first,a.layers).eval();m.compile_mode(False);r['original_parameter_hashes']=m.parameter_hashes;r['original_model_code_sha256']=sha('/model/modeling_qwen2.py');m=m.cuda();calroot=Path('/work/selected-decoder-layer-captures-v2');calmeta=json.loads((calroot/'status.json').read_text());assert calmeta['status']=='completed' and calmeta['calibration_images']==32 and len(calmeta['cases'])==64;r['calibration_source_status_sha256']=sha(calroot/'status.json');r['calibration_provenance']='32-image candidate88 FP32 captured incoming states for range calibration only;original checkpoint weights always used';used=set();hooks=[x.register_forward_hook(lambda mod,args,out,n=n:used.add(n)) for n,x in m.named_modules() if isinstance(x,ConstFakeQuant) and x.quantized];r['status']='gpu_calibrating_original_weights';persist()
 with torch.inference_mode():
  for item in calmeta['cases']:
   case=Path(item['directory']);assert case.resolve().is_relative_to(calroot)
   for call in range(3):
    assert torch.cuda.mem_get_info()[0]>=4*1024**3,'Preserve4GiB GPU headroom';values,raw,q=prepare(case,call,a.first,a.layers);output=m(*[torch.from_numpy(v).cuda() for v in values]);assert all(torch.isfinite(x).all() for x in output);r['calibration'].append(dict(image=item['image_id'],mode=item['generation_mode'],call=call,query_rows=q,input_sha256=sha(case/f'block{a.first}-call-{call}'/'hidden_states.npy')))
   persist()
 for h in hooks:h.remove()
 assert len(r['calibration'])==192;r['ranges']={n:dict(bits=x.bits,absmax=float(x.absmax)) for n,x in m.named_modules() if isinstance(x,ConstFakeQuant) and n in used};assert r['ranges'] and all(np.isfinite(x['absmax']) and x['absmax']>0 for x in r['ranges'].values());r['range_hash']=hashlib.sha256(json.dumps(r['ranges'],sort_keys=True).encode()).hexdigest();r['status']='building_original_bf16_oracle';persist()
 pkg=types.ModuleType('locate_group_original_oracle');pkg.__path__=['/model'];sys.modules[pkg.__name__]=pkg;C=importlib.import_module(pkg.__name__+'.configuration_qwen2').Qwen2Config;N=importlib.import_module(pkg.__name__+'.modeling_qwen2').Qwen2DecoderLayer
 from transformers.cache_utils import DynamicCache
 cache_probe=DynamicCache();cache_probe.update(torch.zeros(1,2,3,128),torch.zeros(1,2,3,128),0);assert len(cache_probe)==1 and cache_probe[0][0].shape==(1,2,3,128) and cache_probe[0][1].shape==(1,2,3,128);del cache_probe
 cfg=C(**json.loads(Path('/model/config.json').read_text())['text_config']);cfg._attn_implementation='sdpa';native=[]
 for relative,index in enumerate(range(a.first,a.first+a.layers)):
  assert torch.cuda.mem_get_info()[0]>=4*1024**3;layer=N(cfg,relative);layer.load_state_dict(original_state(index),strict=True);native.append(layer.to(device='cuda',dtype=torch.bfloat16).eval())
 r['status']='native_original_bf16_reference';persist();fixture_meta={}
 with torch.inference_mode():
  for seq in [1,256]:
   selected=[(im,'slow',call) for im in [1144,2444] for call in [1,2]] if seq==1 else [(im,mode,0) for im in [1144,2444] for mode in ['slow','hybrid']];d=a.out/f's{seq}';d.mkdir();fixture_meta[seq]=[]
   for case,(image,mode,call) in enumerate(selected):
    src=Path('/work/all-decoder-layer-captures-v1')/f'gptq-bf16-{image}-{mode}';values,raw,q=prepare(src,call,a.first,a.layers,seq);cache=DynamicCache()
    for i,(k,v) in enumerate(raw['past']):
     if k.shape[1]:cache.update(torch.from_numpy(k[None]).to('cuda',torch.bfloat16),torch.from_numpy(v[None]).to('cuda',torch.bfloat16),i)
    hidden=torch.from_numpy(raw['hidden'][None]).to('cuda',torch.bfloat16);pos=torch.from_numpy(raw['position'][None]).to('cuda');mask=torch.from_numpy(raw['native_mask']).to('cuda',torch.bfloat16) if raw['native_mask'] is not None else None
    for layer in native:hidden=layer(hidden,attention_mask=mask,position_ids=pos,past_key_value=cache,use_cache=True)[0]
    target=[hidden[0].float().cpu().numpy()]
    for i in range(a.layers):target.extend([cache[i][0][0,:,-q:,:].float().cpu().numpy(),cache[i][1][0,:,-q:,:].float().cpu().numpy()])
    qdir=d/f'case-{case:02d}';qdir.mkdir()
    for i,v in enumerate(values):np.save(qdir/f'input-{i:02d}.npy',v)
    for i,v in enumerate(target):np.save(qdir/f'original-bf16-{i:02d}.npy',v)
    fixture_meta[seq].append(dict(case=case,image=image,mode=mode,call=call,valid_query_rows=q))
 r['gpu_peak_allocated_bytes']=torch.cuda.max_memory_allocated();del native,layer,cache,hidden,mask,pos,target,output;gc.collect();r['status']='waiting_cpu_compiler_admission';r['cpu_admission_policy']='GPU calibration may overlap;one CPU export/reference/compiler group at a time';persist();cpu_admission_path=Path('/work/locate-official-qwen-cpu-admission-v1.lock');assert not cpu_admission_path.is_symlink();cpu_admission=cpu_admission_path.open('a+b');fcntl.flock(cpu_admission.fileno(),fcntl.LOCK_EX);r['cpu_admission_acquired']=time.time();m=m.cpu();torch.cuda.empty_cache();r['gpu_free_after_calibration']=torch.cuda.mem_get_info()[0];r['status']='exporting_profiles';persist();m.compile_mode(True);hbos=[]

 for seq in [1,256]:
  d=a.out/f's{seq}';entry=dict(sequence_capacity=seq,status='exporting',range_hash=r['range_hash'],regression=[]);r['profiles'].append(entry);r['status']=f'exporting_s{seq}';persist();types_=[leap.TensorType([seq,2048],leap.float32),leap.TensorType([seq,128],leap.float32),leap.TensorType([seq,128],leap.float32),leap.TensorType([seq,512],leap.float32)]+[leap.TensorType([2,512,128],leap.float32) for _ in range(2*a.layers)];bc=m.export_module(types_,name=f'locate_official_qwen_group_{a.first}_{a.first+a.layers-1}_s{seq}',save_path=str(d/'export.bc'),high_precision_qpp=True);assert bc._llm_extra and bc._high_precision_qpp;r['status']=f'converting_s{seq}';entry['status']='converting';persist();lowered=m.convert_mlir(bc,save_path=str(d/'converted.bc'),enable_vpu=True,march='nash-m');f=lowered.functions[0];entry['converted_bc_sha256']=sha(d/'converted.bc');entry['status']='compiler_reference';r['status']=f'compiler_reference_s{seq}';persist()
  for meta in fixture_meta[seq]:
   case=meta['case'];q=meta['valid_query_rows'];qdir=d/f'case-{case:02d}';values=[np.load(qdir/f'input-{i:02d}.npy',allow_pickle=False) for i in range(4+2*a.layers)];outputs=[np.asarray(v).copy() for v in f(*values)];assert len(outputs)==1+2*a.layers and all(np.isfinite(v).all() for v in outputs);row=dict(meta,outputs=[])
   for i,value in enumerate(outputs):
    np.save(qdir/f'compiler-{i:02d}.npy',value);gold=np.load(qdir/f'original-bf16-{i:02d}.npy',allow_pickle=False);valid=value[:q] if i==0 else value[:,:q,:];row['outputs'].append(dict(output=i,compiler_vs_original_bf16=metric(valid,gold)))
   entry['regression'].append(row);persist()
  ports=dict(name=f.name,inputs=[dict(name=x.name,shape=list(x.type.shape)) for x in f.inputs],outputs=[dict(name=x.name,shape=list(x.type.shape)) for x in f.outputs]);(d/'ports.json').write_text(json.dumps(ports,indent=2)+chr(10));entry['ports_sha256']=sha(d/'ports.json');entry['status']='compiling_hbo';r['status']=f'compiling_hbo_s{seq}';persist();start=time.monotonic();hbo=m.compile_hbo(lowered,save_path=str(d/'model.hbo'),march='nash-m',opt=0,jobs=1);entry.update(status='compiled_hbo',compile_seconds=time.monotonic()-start,hbo_sha256=sha(d/'model.hbo'));hbos.append(hbo);del bc,lowered,f,outputs,values;gc.collect();persist()
 r['status']='linking_shared_profiles';persist();m.link_models(hbos,str(a.out/'model.hbm'));tool=BASE/'sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas';disas=json.loads(subprocess.check_output([str(tool),'--json',str(a.out/'model.hbm')],text=True));(a.out/'disas.json').write_text(json.dumps(disas,indent=2)+chr(10));devices=[n['device'] for g in disas['graphs'] for n in g['nodes']];assert len(disas['graphs'])==2 and devices and all(x=='DEVICE_CATEGORY_BPU' for x in devices),'Reject neural CPU fallback';assert len({x['range_hash'] for x in r['profiles']})==1;r.update(status='compiled_original_group_shared_profiles_bpu_only',bpu_only=True,hbm_sha256=sha(a.out/'model.hbm'),hbm_bytes=(a.out/'model.hbm').stat().st_size,devices=devices,compiler_memory=[g['modelMemoryRequirement'] for g in disas['graphs']],actual_board_verified=False)
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:
 if torch.cuda.is_available():torch.cuda.empty_cache()
 r['finished']=time.time();persist()
print(json.dumps({k:r.get(k) for k in ['status','hbm_sha256','hbm_bytes','error']},indent=2))
