"""Two-layer selected-checkpoint compiler comparison against unchanged original Qwen source.

Six old tuning activation/cache profiles only. CPU is an explicit development oracle;
not production fallback,whole-model P/R,or board evidence. Save full BPU fixtures.
"""
from pathlib import Path
import sys,types,importlib,json,time,hashlib,traceback
sys.path.insert(0,'/opt/locate-reference-deps');sys.path.insert(0,'/opt/locate-oellm-research-v1/sdk448-isolated/python')
import numpy as np,torch
from safetensors import safe_open
from hbdk4.compiler import load
ROOT=Path('/opt/locate-oellm-research-v1/selected-decoder-group-0-1-s12-mask-centered-qkf32-v4-sdk448');OUT=ROOT/'qualification-v1';assert not OUT.exists();OUT.mkdir()
r=dict(status='checking',scope=__doc__,started=time.time(),source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),cases=[],board_calls=0,release_approved=False)
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for x in iter(lambda:f.read(4*1024**2),b''):h.update(x)
 return h.hexdigest()
def save():
 p=OUT/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+'\n');p.replace(OUT/'status.json')
def metric(a,b):
 a=np.asarray(a,np.float64);b=np.asarray(b,np.float64);assert a.shape==b.shape and np.isfinite(a).all() and np.isfinite(b).all();d=a-b
 return dict(maxabs=float(np.abs(d).max()),relative_l2=float(np.linalg.norm(d)/max(np.linalg.norm(b),1e-20)),array_equal=bool(np.array_equal(a,b)))
class Cache:
 def __init__(self,i,k,v):self.i=i;self.k=k;self.v=v
 def get_seq_length(self,i):assert i==self.i;return self.k.shape[2]
 def update(self,k,v,i,kwargs):assert i==self.i;self.k=torch.cat([self.k,k],2);self.v=torch.cat([self.v,v],2);return self.k,self.v
try:
 save();torch.set_num_threads(2);state=json.loads((ROOT/'status.json').read_text());assert state['status']=='completed' and state['bpu_only'] and state['layer_count']==2 and state['start_layer']==0 and state['sequence_capacity']==12
 assert sha(ROOT/'stack.hbm')==state['hbm_sha256'] and sha(ROOT/'stack-converted.bc')==state['converted_bc_sha256'];assert len(state['selected_modules'])==14
 selected={x['name']:x for x in state['selected_modules']};prior_root=Path('/opt/locate-oellm-research-v1/selected-decoder-group-0-1-s12-v1-sdk448');prior_state=json.loads((prior_root/'status.json').read_text());prior_selected={v['name']:v for v in prior_state['selected_modules']};assert all(v['represented_file_sha256']==prior_selected[k]['represented_file_sha256'] for k,v in selected.items());r['same_selected_weights_as_v1']=True;assert state['mask_addition_kept_float32'] and state['centered_mask_quant_absmax']==64. and state['attention_qk_output_f32'];r['compiler_status_sha256']=sha(ROOT/'status.json');r['hbm_sha256']=state['hbm_sha256'];r['numeric_reference']='Original Qwen source FP32 SDPA with selected historicalv9 represented weights and native BF16-represented RoPE caches;not native BF16 arithmetic'
 package=types.ModuleType('locate_selected_reference_source');package.__path__=['/model'];sys.modules[package.__name__]=package;module=importlib.import_module(package.__name__+'.modeling_qwen2');configmodule=importlib.import_module(package.__name__+'.configuration_qwen2');cfg=configmodule.Qwen2Config(**json.loads(Path('/model/config.json').read_text())['text_config']);cfg._attn_implementation='sdpa'
 index=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map'];layers=[]
 for i in range(2):
  layer=module.Qwen2DecoderLayer(cfg,i).bfloat16().float().eval();prefix='language_model.model.layers.'+str(i)+'.';weights={}
  for shard in sorted(set(index[k] for k in index if k.startswith(prefix))):
   with safe_open('/model/'+shard,framework='pt',device='cpu') as f:
    for name in index:
     if name.startswith(prefix) and index[name]==shard:weights[name[len(prefix):]]=f.get_tensor(name).float()
  for name,item in selected.items():
   if not name.startswith(prefix):continue
   path=ROOT/item['represented_file'];assert sha(path)==item['represented_file_sha256'];weights[name[len(prefix):]+'.weight']=torch.from_numpy(np.load(path))
  layer.load_state_dict(weights,strict=True);layers.append(layer)
 prior=load(str(prior_root/'stack-converted.bc')).functions[0];compiled=load(str(ROOT/'stack-converted.bc')).functions[0];baseline_root=Path('/opt/locate-oellm-research-v1/original-decoder-stack-2-seq12-v9-sdk448');baseline=load(str(baseline_root/'stack-converted.bc')).functions[0];r['baseline_bc_sha256']=sha(baseline_root/'stack-converted.bc')
 for image in [1144,2444]:
  for mode,call in [('slow',1),('hybrid',1),('hybrid',2)]:
   base=Path('/work/all-decoder-layer-captures-v1')/(f'gptq-bf16-{image}-{mode}');directory=base/f'block0-call-{call}';hidden=torch.from_numpy(np.load(directory/'hidden_states.npy')).float();positions=torch.from_numpy(np.load(directory/'position_ids.npy')).long();q=hidden.shape[1];assert 1<=q<=12
   native_mask=torch.from_numpy(np.load(directory/'attention_mask.npy')).float() if (directory/'attention_mask.npy').exists() else None
   ks=[];vs=[]
   for i in range(2):
    d=base/f'block{i}-call-{call}';ks.append(torch.from_numpy(np.load(d/'past-0.npy')).float());vs.append(torch.from_numpy(np.load(d/'past-1.npy')).float())
   old=ks[0].shape[2];left=500-old;assert left>=0;ph=torch.zeros(1,12,2048);ph[:,:q]=hidden;pp=torch.zeros(1,12,dtype=torch.long);pp[:,:q]=positions
   mask=torch.full((12,512),-32767.);mask[:q,left:left+old+q]=native_mask[0,0].clamp(min=-32767.) if native_mask is not None else 0.
   kpad=[torch.cat([torch.zeros(1,2,left,128),x],2) for x in ks];vpad=[torch.cat([torch.zeros(1,2,left,128),x],2) for x in vs]
   h=hidden.clone();hp=ph.clone();native=[];padded=[]
   with torch.inference_mode():
    for i,layer in enumerate(layers):
     c=Cache(i,ks[i].clone(),vs[i].clone());cp=Cache(i,kpad[i].clone(),vpad[i].clone());h=layer(h,attention_mask=native_mask,position_ids=positions,past_key_value=c,use_cache=True)[0];hp=layer(hp,attention_mask=mask.reshape(1,1,12,512),position_ids=pp,past_key_value=cp,use_cache=True)[0];native.append((c.k[0,:,-q:,:].numpy(),c.v[0,:,-q:,:].numpy()));padded.append((cp.k[0,:,500:500+q,:].numpy(),cp.v[0,:,500:500+q,:].numpy()))
   target=[h[0].numpy()]+[x[0] for x in native]+[x[1] for x in native];padded_target=[hp[0,:q].numpy()]+[x[0] for x in padded]+[x[1] for x in padded]
   rotary=layers[0].self_attn.rotary_emb;cos=rotary.cos_cached[pp[0]].numpy().copy();sin=rotary.sin_cached[pp[0]].numpy().copy()
   inputs=[ph[0].numpy(),cos,sin,mask.numpy()]+[torch.cat([torch.zeros(2,12,128),x[0]],1).numpy() for x in kpad+vpad];assert len(inputs)==8
   actual=[np.asarray(x).copy() for x in compiled(*inputs)];prior_actual=[np.asarray(x).copy() for x in prior(*inputs)];previous=[np.asarray(x).copy() for x in baseline(*inputs)];assert len(actual)==len(previous)==5
   folder=OUT/f'case-{len(r["cases"]):02d}';folder.mkdir();item=dict(image_id=image,mode=mode,call=call,query_rows=q,inputs=[],outputs=[],metrics=[])
   for n,array in enumerate(inputs):
    path=folder/f'input-{n:02d}.npy';np.save(path,array);item['inputs'].append(dict(name=compiled.inputs[n].name,file=str(path.relative_to(OUT)),sha256=sha(path),shape=list(array.shape),dtype=str(array.dtype)))
   for n,(array,old_array,reference,padded_reference) in enumerate(zip(actual,previous,target,padded_target)):
    path=folder/f'compiler-{n:02d}.npy';np.save(path,array);item['outputs'].append(dict(name=compiled.outputs[n].name,file=str(path.relative_to(OUT)),sha256=sha(path),shape=list(array.shape),dtype=str(array.dtype)))
    valid=array[:q] if n==0 else array[:,:q,:];old_valid=old_array[:q] if n==0 else old_array[:,:q,:]
    item['metrics'].append(dict(index=n,selected_compiler_vs_selected_original_source=metric(valid,reference),baseline_compiler_vs_selected_original_source=metric(old_valid,reference),selected_v1_compiler_vs_selected_original_source=metric(prior_actual[n][:q] if n==0 else prior_actual[n][:,:q,:],reference),native_padding_effect=metric(padded_reference,reference)))
   r['cases'].append(item);save()
 r['status']='completed';r['maximum_hidden_relative_l2']=max(x['metrics'][0]['selected_compiler_vs_selected_original_source']['relative_l2'] for x in r['cases']);r['baseline_maximum_hidden_relative_l2']=max(x['metrics'][0]['baseline_compiler_vs_selected_original_source']['relative_l2'] for x in r['cases']);r['board_probe_eligible']=r['maximum_hidden_relative_l2']<.01 and r['maximum_hidden_relative_l2']<r['baseline_maximum_hidden_relative_l2'];r['finished']=time.time();save()
except BaseException:r.update(status='failed',error=traceback.format_exc(),finished=time.time());save();raise
print(json.dumps({k:r.get(k) for k in ['status','maximum_hidden_relative_l2','baseline_maximum_hidden_relative_l2','board_probe_eligible','error']}))
