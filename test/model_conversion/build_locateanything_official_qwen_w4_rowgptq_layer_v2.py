"""Controlled original layer0 W4 per-row export through unchanged official FQLinear.build; W8A16 ranges and math frozen. Not the published whole-model Q4 recipe or full quality."""
from pathlib import Path
from types import SimpleNamespace
import os,sys,json,time,hashlib,argparse,traceback,subprocess
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
BASE=Path('/opt/locate-oellm-research-v1')
sys.path.insert(0,str(BASE/'sdk448-isolated/python'))
sys.path.insert(0,str(BASE/'leap-source-overlay'))
import numpy as np
import torch
from safetensors import safe_open
from hbdk4.compiler import leap,save,convert,compile,link
from leap_llm.nn.utils import Model
from leap_llm.nn.modules.linear import FakeQuantLinear
from leap_llm.nn.modules.const_fake_quant import ConstFakeQuant
from leap_llm.models.qwen2_5_omni.blocks.transformer_block import Qwen2_5OmniDecoderLayer

def digest(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def metric(a,b):
 a=np.asarray(a,dtype=np.float64);b=np.asarray(b,dtype=np.float64)
 assert a.shape==b.shape and np.isfinite(a).all() and np.isfinite(b).all()
 return dict(rel_l2=float(np.linalg.norm(a-b)/max(np.linalg.norm(b),1e-12)),max_abs=float(np.abs(a-b).max()))

class Probe(Model):
 def __init__(self,config,bits):
  super().__init__();self.layer=Qwen2_5OmniDecoderLayer(config,0)
  for norm in [self.layer.input_layernorm,self.layer.post_attention_layernorm]:norm.fp16_tiny=False;norm.preserve_precision=True
  for m in self.layer.modules():
   if isinstance(m,FakeQuantLinear):m.w_bits=bits
  attn=self.layer.self_attn
  for proj in [attn.q_proj,attn.k_proj,attn.v_proj]:proj.quant_bits=16;proj.out_fake_quant.bits=16
  attn.qk.x_bits=16;attn.qk.y_bits=16;attn.qk.x_fake_quant.bits=16;attn.qk.y_fake_quant.bits=16
  attn.sv.y_bits=16;attn.sv.y_fake_quant.bits=16;attn.key_out_fq.bits=16
  self.set_children_parent()
 def build(self,hidden,cos,sin,mask,key,value):
  q=hidden.type.shape[0]
  out,k,v=self.layer(leap.reshape(hidden,[1,q,2048]),attention_mask=leap.reshape(mask,[1,1,q,512]),position_embeddings=(leap.reshape(cos,[1,1,q,128]),leap.reshape(sin,[1,1,q,128])),cache_k=leap.reshape(key,[1,2,512,128]),cache_v=leap.reshape(value,[1,2,512,128]))
  return leap.reshape(out,[q,2048]),leap.reshape(k,[2,q,128]),leap.reshape(v,[2,q,128])
 def forward(self,hidden,cos,sin,mask,key,value):
  q=hidden.shape[0]
  out,k,v=self.layer(hidden[None],attention_mask=mask[None,None],position_embeddings=(cos[None,None],sin[None,None]),cache_k=key[None],cache_v=value[None])
  return out[0],k[0],v[0]

def capture(image,mode,call,capacity=None):
 root=Path('/work/all-decoder-layer-captures-v1')/f'gptq-bf16-{image}-{mode}'/f'block0-call-{call}'
 def read(n):return np.load(root/(n+'.npy'),allow_pickle=False)
 hidden=read('hidden_states')[0].astype(np.float32);pos=read('position_ids').reshape(-1);q=hidden.shape[0];assert 0<q<=256
 angle=pos.astype(np.float32)[:,None]*(1/(1000000.**(np.arange(0,128,2,dtype=np.float32)/128)))[None];angle=np.concatenate([angle,angle],-1)
 oldk=read('past-0')[0].astype(np.float32) if (root/'past-0.npy').exists() else np.zeros((2,0,128),np.float32)
 oldv=read('past-1')[0].astype(np.float32) if (root/'past-1.npy').exists() else np.zeros((2,0,128),np.float32)
 native_mask=read('attention_mask')[0,0] if (root/'attention_mask.npy').exists() else np.zeros((q,oldk.shape[1]+q),np.float32)
 mask=np.where(native_mask==0,0.,-512.).astype(np.float32)
 assert mask.shape==(q,oldk.shape[1]+q)
 if capacity is None:capacity=q
 assert q<=capacity and oldk.shape[1]+capacity<=512
 # Padded rows are unused and have one finite visible key so softmax is well-defined.
 padded=np.zeros((capacity,2048),np.float32);padded[:q]=hidden
 cos=np.ones((capacity,128),np.float32);sin=np.zeros_like(cos);cos[:q]=np.cos(angle);sin[:q]=np.sin(angle)
 k=np.zeros((2,512,128),np.float32);v=np.zeros_like(k);old=oldk.shape[1]
 if old:k[:,512-old:]=oldk;v[:,512-old:]=oldv
 m=np.full((capacity,512),-512.,np.float32)
 if old:m[:q,512-old-capacity:512-capacity]=mask[:,:old]
 m[:q,512-capacity:512-capacity+q]=mask[:,old:]
 if q<capacity:m[q:,512-capacity]=0.
 return [padded,cos,sin,m,k,v],read('hidden_output')[0].astype(np.float32),q,root

p=argparse.ArgumentParser();p.add_argument('--bits',type=int,choices=[4],required=True);p.add_argument('--seq',type=int,choices=[1],required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
assert a.out.parent==Path('/opt') and a.out.name.startswith('locate-official-qwen-') and not a.out.exists() and os.getpgrp()==os.getpid()
torch.set_num_threads(2);a.out.mkdir();r=dict(status='calibrating',started=time.time(),pid=os.getpid(),source_sha256=digest(__file__),scope=__doc__,bits=a.bits,sequence_capacity=a.seq,baseline_builder_sha256='1390575d032d30df00bc7b9493d5880d20577de452dc4e82dc0781cae41a2b49',layer_count=1,layer_index=0,calibration_cases=[],regression=[],official_quantized_linear_unmodified=True,official_mask_value=-512,high_precision_qpp=True,original_norm_epsilon_preserved=True,cache_input_layout='past right-aligned at end before official module drops query_capacity rows',capture_output_reference_provenance='GPTQ W4 v1 BF16 captured output;NOT original-weight target',fp16_tiny=False,norm_preserve_precision=True,attention_activation_bits=16,weight_bits=4,precision_change_scope="Only the seven original layer0 Linear weight exports change from8 to4 bits;attention activations remain16. Prepared per-row signed-grid GPTQ weights/scales come from the pinned CPU control;no norm fusion or activation/mask change.",remove_quantized_io_pending=True,neural_cpu_production_fallback=False,whole_model_verified=False,release_approved=False,maximum_compile_seconds=None)
def persist():
 p=a.out/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+chr(10));p.replace(a.out/'status.json')
persist()

try:
 src=BASE/'leap-source-overlay/leap_llm'
 pins={'nn/modules/linear.py':'7c68836051e9b065b3e43bf291a13db0261d094d7faa42b7ceccbf3cd6395054','models/qwen2_5_omni/blocks/attention.py':'65d35ebe32a05cf931d20545387eaecaef16dbcd386ed15eef66eb1392bf041f'}
 for n,h in pins.items():assert digest(src/n)==h
 r['official_sources']=dict(pins)
 c=json.loads(Path('/model/config.json').read_text())['text_config'];assert c['num_hidden_layers']==36 and c['hidden_size']==2048 and c['vocab_size']==152681
 config=SimpleNamespace(**c);m=Probe(config,a.bits);index=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map'];prefix='language_model.model.layers.0.';state={}
 for shard in sorted({index[k] for k in index if k.startswith(prefix)}):
  with safe_open('/model/'+shard,framework='pt',device='cpu') as f:
   for n in index:
    if n.startswith(prefix) and index[n]==shard:state[n[len(prefix):]]=f.get_tensor(n).float()
 r['original_parameter_hashes']={n:hashlib.sha256(x.numpy().tobytes()).hexdigest() for n,x in state.items()}
 m.layer.load_state_dict(state,strict=True)
 baseline=Path('/opt/locate-official-qwen-layer0-w8a16-s1-v6');baseline_status=json.loads((baseline/'status.json').read_text())
 assert baseline_status['status']=='compiled_bpu_only' and baseline_status['source_sha256']==r['baseline_builder_sha256']
 assert baseline_status['original_parameter_hashes']==r['original_parameter_hashes']
 r['frozen_w8_status_sha256']=digest(baseline/'status.json');r['frozen_w8_hbm_sha256']=digest(baseline/'model.hbm')
 control_path=Path('/work/official-llm-v1/official-qwen-w4-row-gptq-controls-v1.json')
 assert digest(control_path)=='bd24b5b63dc75b77e7facf908b1a49fd78d0804c8a897315680851373c3de66d'
 control=json.loads(control_path.read_text());assert control['status']=='completed' and control['source_sha256']=='871b608b26f72d65d03b9550c79a118c5fd785850c300299fe17fc4e994fc458' and control['bpu_calls']==0
 selected=next(c for c in control['candidates'] if c['recipe']=='row_mse_clip_gptq_actorder');assert selected['screen_passed']
 r['weight_preparation_control_sha256']=digest(control_path);r['weight_scale_recipe']='Pinned row-MSE clip plus GPTQ activation-order,error-feedback block128,damping.01,grid20/norm2.4,signed[-7,7],zero0,no deployment input permutation;not official published Q4 reproduction'
 prepared_weights={};r['weight_modules']=[]
 for name,module in m.named_modules():
  if isinstance(module,FakeQuantLinear):
   artifact=Path('/opt/locate-w4-row-gptq-controls-v1/row_mse_clip_gptq_actorder')/(name+'.npz');proof=next(x for x in selected['modules'] if x['name']==name)
   assert str(artifact)==proof['artifact'] and digest(artifact)==proof['sha256']
   with np.load(artifact,allow_pickle=False) as arrays:codes=arrays['codes'].copy();scales=arrays['scales'].copy()
   assert codes.dtype==np.int8 and scales.dtype==np.float32 and codes.shape==tuple(module.weight.shape) and scales.shape==(codes.shape[0],1) and codes.min()>=-7 and codes.max()<=7
   scale=torch.from_numpy(scales);assert torch.isfinite(scale).all() and (scale>0).all()
   module.register_buffer('scales',scale);module.has_scale=True
   restored=torch.from_numpy(codes).float()*scale;assert torch.equal(torch.round(restored/scale).clamp(-7,7).to(torch.int8),torch.from_numpy(codes))
   prepared_weights[name]=restored
   r['weight_modules'].append(dict(name=name,shape=list(module.weight.shape),weights=module.weight.numel(),scale_sha256=hashlib.sha256(scales.tobytes()).hexdigest(),codes_sha256=hashlib.sha256(codes.tobytes()).hexdigest(),prepared_artifact_sha256=digest(artifact),weight_rel_l2=metric(restored.numpy(),module.weight.detach().numpy())['rel_l2']))
 assert len(r['weight_modules'])==7
 r['linear_weight_count']=sum(item['weights'] for item in r['weight_modules'])
 r['linear_ideal_w4_payload_bytes']=r['linear_weight_count']//2
 m.eval();m.compile_mode(False)
 used=set();hooks=[x.register_forward_hook(lambda mod,args,out,n=n:used.add(n)) for n,x in m.named_modules() if isinstance(x,ConstFakeQuant) and x.quantized]
 for image in [1144,2444]:
  for mode in ['slow','hybrid']:
   for call in range(3):
    values,target,q,root=capture(image,mode,call)
    with torch.inference_mode():out=m(*[torch.from_numpy(x) for x in values])[0].numpy()
    r['calibration_cases'].append(dict(image=image,mode=mode,call=call,query_rows=q,input_sha256=digest(root/'hidden_states.npy'),torch_float_reference_vs_gptq_captured_output=metric(out,target)))
 for h in hooks:h.remove()
 all_ranges={n:dict(bits=x.bits,absmax=float(x.absmax),executed_in_calibration=n in used) for n,x in m.named_modules() if isinstance(x,ConstFakeQuant) and x.quantized}
 ranges={n:x for n,x in all_ranges.items() if n in used};r['ranges']=ranges;r['all_observer_states']=all_ranges;assert ranges==baseline_status['ranges'] and all_ranges==baseline_status['all_observer_states'];r['observer_ranges_exactly_equal_frozen_w8']=True;persist()
 assert ranges and all(np.isfinite(x['absmax']) and x['absmax']>0 for x in ranges.values())
 # Calibrate on the unchanged original float layer,then freeze those observer
 # states exactly as W8. Only now substitute the prepared W4 weight grid.
 for name,module in m.named_modules():
  if name in prepared_weights:module.weight.data.copy_(prepared_weights[name])
 observer_flags=[(x,x.quantized) for x in m.modules() if isinstance(x,ConstFakeQuant)]
 for x,enabled in observer_flags:x.quantized=False
 prepared_float={}
 for image in [1144,2444]:
  for call in [1,2]:
   values,target,q,root=capture(image,'slow',call,a.seq)
   with torch.inference_mode():prepared_float[(image,'slow',call)]=[x.detach().numpy().copy() for x in m(*[torch.from_numpy(v) for v in values])]
 for x,enabled in observer_flags:x.quantized=enabled
 assert {n:dict(bits=x.bits,absmax=float(x.absmax),executed_in_calibration=n in used) for n,x in m.named_modules() if isinstance(x,ConstFakeQuant) and x.quantized}==all_ranges
 m.compile_mode(True);r['status']='exporting_official_module';persist()
 types=[leap.TensorType([a.seq,2048],leap.float32),leap.TensorType([a.seq,128],leap.float32),leap.TensorType([a.seq,128],leap.float32),leap.TensorType([a.seq,512],leap.float32),leap.TensorType([2,512,128],leap.float32),leap.TensorType([2,512,128],leap.float32)]
 bc=m.export_module(types,name=f'locate_official_qwen_layer0_w{a.bits}_s{a.seq}',save_path=str(a.out/'export.bc'),high_precision_qpp=True)
 assert bc._llm_extra and bc._high_precision_qpp;r['status']='converting_official_module';persist()
 lowered=m.convert_mlir(bc,save_path=str(a.out/'converted.bc'),enable_vpu=True,march='nash-m');f=lowered.functions[0]
 r['converted_bc_sha256']=digest(a.out/'converted.bc');r['status']='compiler_reference';persist()
 fixtures=a.out/'fixtures';fixtures.mkdir();selected=[(im,'slow',call) for im in [1144,2444] for call in [1,2]] if a.seq==1 else [(im,mode,0) for im in [1144,2444] for mode in ['slow','hybrid']]
 for case,(image,mode,call) in enumerate(selected):
  values,target,q,root=capture(image,mode,call,a.seq);outputs=[np.asarray(x).copy() for x in f(*values)];assert len(outputs)==3 and all(np.isfinite(x).all() for x in outputs)
  d=fixtures/f'case-{case:02d}';d.mkdir()
  for i,x in enumerate(values):np.save(d/f'input-{i:02d}.npy',x)
  for i,x in enumerate(outputs):np.save(d/f'compiler-{i:02d}.npy',x)
  for i,x in enumerate(prepared_float[(image,mode,call)]):np.save(d/f'prepared-float-{i:02d}.npy',x)
  np.save(d/'native-hidden.npy',target)
  goldroot=Path(f'/opt/locate-official-qwen-layer0-w8-s{a.seq}-v4')/'fixtures'/f'case-{case:02d}';truebf=np.load(goldroot/'original-weight-bf16-hidden-audit-v1.npy');truefp=np.load(goldroot/'original-weight-fp32-hidden-audit-v1.npy')
  old=baseline/'fixtures'/f'case-{case:02d}'
  for i in range(6):assert digest(d/f'input-{i:02d}.npy')==digest(old/f'input-{i:02d}.npy')
  w8_hidden=np.load(old/'compiler-00.npy',allow_pickle=False)
  r['regression'].append(dict(compiler_vs_same_prepared_float=[metric(a,b) for a,b in zip(outputs,prepared_float[(image,mode,call)])],case=case,image=image,mode=mode,call=call,valid_query_rows=q,compiler_vs_gptq_captured_output=metric(outputs[0][:q],target),compiler_vs_original_bf16=metric(outputs[0][:q],truebf),compiler_vs_original_fp32=metric(outputs[0][:q],truefp),compiler_vs_frozen_w8=metric(outputs[0],w8_hidden)))
 thresholds=[2*x['compiler_vs_original_bf16']['rel_l2'] for x in baseline_status['regression']]
 r['compiler_reference_component_screen_passed']=all(x['compiler_vs_original_bf16']['rel_l2']<=t for x,t in zip(r['regression'],thresholds));persist()
 assert r['compiler_reference_component_screen_passed'],'Reject new HBM compile:prepared weight compiler reference exceeds frozen component screen'
 ports=dict(inputs=[dict(name=x.name,shape=list(x.type.shape)) for x in f.inputs],outputs=[dict(name=x.name,shape=list(x.type.shape)) for x in f.outputs]);(a.out/'ports.json').write_text(json.dumps(ports,indent=2)+chr(10))
 r['status']='compiling_hbo';persist();start=time.monotonic();hbo=m.compile_hbo(lowered,save_path=str(a.out/'model.hbo'),march='nash-m',opt=0,jobs=1);m.link_models([hbo],str(a.out/'model.hbm'))
 tool=BASE/'sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas';d=json.loads(subprocess.check_output([str(tool),'--json',str(a.out/'model.hbm')],text=True));devices=[n['device'] for g in d['graphs'] for n in g['nodes']];assert devices and all(x=='DEVICE_CATEGORY_BPU' for x in devices),'Reject neural CPU fallback'
 (a.out/'disas.json').write_text(json.dumps(d,indent=2)+chr(10));r.update(status='compiled_bpu_only',compile_seconds=time.monotonic()-start,bpu_only=True,devices=devices,hbm_sha256=digest(a.out/'model.hbm'),hbm_bytes=(a.out/'model.hbm').stat().st_size,compiler_memory=d['graphs'][0]['modelMemoryRequirement'],actual_board_verified=False,baseline_w8_static_memory=baseline_status['compiler_memory']['staticMemory'],observed_static_bytes_saved=baseline_status['compiler_memory']['staticMemory']-d['graphs'][0]['modelMemoryRequirement']['staticMemory'])
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:r['finished']=time.time();persist()
print(json.dumps({k:r.get(k) for k in ['status','hbm_bytes','hbm_sha256','regression','error']}))
