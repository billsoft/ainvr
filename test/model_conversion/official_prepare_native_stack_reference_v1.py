import os,sys,types,importlib,json,argparse,time,traceback,hashlib,gc
from pathlib import Path
sys.path.insert(0,'/opt/locate-reference-deps')
import torch,numpy as np
from safetensors import safe_open
ap=argparse.ArgumentParser();ap.add_argument('--layers',type=int,required=True);ap.add_argument('--version',default='v6');ap.add_argument('--simulate',action='store_true');a=ap.parse_args();assert a.layers in [2,36];torch.set_num_threads(2)
pkg=types.ModuleType('locate_original_source');pkg.__path__=['/model'];sys.modules[pkg.__name__]=pkg
mod=importlib.import_module('locate_original_source.modeling_qwen2');conf=importlib.import_module('locate_original_source.configuration_qwen2');raw=json.loads(Path('/model/config.json').read_text())['text_config'];config=conf.Qwen2Config(**raw);config._attn_implementation='sdpa';idx=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map']
r=Path('/opt/locate-oellm-research-v1')/('original-decoder-stack-'+str(a.layers)+'-'+a.version);target=r/'native-reference-v1';target.mkdir(exist_ok=False)
out={'status':'running','scope':'original unmodified decoder source BF16 CPU SDPA on old tuning activation, decoder-stack component only; not full multimodal generation or CUDA oracle','layers':a.layers,'board_calls':0,'started':time.time(),'original_source_sha256':hashlib.sha256(Path('/model/modeling_qwen2.py').read_bytes()).hexdigest()}
def save():(target/'status.json').write_text(json.dumps(out,indent=2))
save()
class Cache:
 def __init__(self,i,k,v):self.i=i;self.k=k;self.v=v
 def get_seq_length(self,i):assert i==self.i;return self.k.shape[2]
 def update(self,k,v,i,kwargs):assert i==self.i;self.k=torch.cat([self.k,k],2);self.v=torch.cat([self.v,v],2);return self.k,self.v
try:
 base=Path('/work/all-decoder-layer-captures-v1/gptq-bf16-1144-slow');p=base/'block0-call-1';hidden=torch.from_numpy(np.load(p/'hidden_states.npy')).bfloat16();positions=torch.from_numpy(np.load(p/'position_ids.npy')).long();angle=positions.flatten().float()[:,None]*(1/(1e6**(torch.arange(0,128,2).float()/128)))[None,:];angle=torch.cat([angle,angle],-1);ks=[];vs=[]
 for i in range(a.layers):
  q=base/('block'+str(i)+'-call-1');k=np.load(q/'past-0.npy')[0];v=np.load(q/'past-1.npy')[0];pad=511-k.shape[1];ks.append(np.concatenate([np.zeros((2,pad+1,128),np.float32),k],1));vs.append(np.concatenate([np.zeros((2,pad+1,128),np.float32),v],1))
 mask=np.concatenate([np.full((1,pad),-32767.,np.float32),np.zeros((1,k.shape[1]+1),np.float32)],1);inputs=[hidden.float().numpy(),angle.cos().numpy(),angle.sin().numpy(),mask]+ks+vs
 keys=[];values=[]
 with torch.inference_mode():
  for i in range(a.layers):
   layer=mod.Qwen2DecoderLayer(config,i).bfloat16().eval();prefix='language_model.model.layers.'+str(i)+'.';state={}
   for shard in sorted(set(idx[k] for k in idx if k.startswith(prefix))):
    with safe_open('/model/'+shard,framework='pt',device='cpu') as f:
     for k in idx:
      if k.startswith(prefix) and idx[k]==shard:state[k[len(prefix):]]=f.get_tensor(k)
   layer.load_state_dict(state,strict=True);del state
   cache=Cache(i,torch.from_numpy(ks[i][:,1:,:]).unsqueeze(0).bfloat16(),torch.from_numpy(vs[i][:,1:,:]).unsqueeze(0).bfloat16())
   hidden=layer(hidden,attention_mask=torch.from_numpy(mask).reshape(1,1,1,512).bfloat16(),position_ids=positions,past_key_value=cache,use_cache=True)[0]
   keys.append(cache.k[0,:,-1:,:].float().numpy());values.append(cache.v[0,:,-1:,:].float().numpy());del layer,cache;gc.collect()
  if a.layers==36:
   norm=mod.Qwen2RMSNorm(2048,eps=raw['rms_norm_eps']).bfloat16();n='language_model.model.norm.weight'
   with safe_open('/model/'+idx[n],framework='pt',device='cpu') as f:norm.weight.data.copy_(f.get_tensor(n))
   hidden=norm(hidden)
 refs=[hidden.float().numpy()]+keys+values
 for i,x in enumerate(inputs):np.save(target/('input-'+str(i)+'.npy'),x)
 for i,x in enumerate(refs):np.save(target/('native-output-'+str(i)+'.npy'),x)
 out.update(status='reference_prepared',inputs=len(inputs),outputs=len(refs))
 if a.simulate:
  from hbdk4.compiler import load
  actual=load(str(r/'stack-converted.bc')).functions[0](*inputs);out['vs_native_bf16_component']=[]
  for i,(x,y) in enumerate(zip(actual,refs)):
   x=np.asarray(x);np.save(target/('compiler-output-'+str(i)+'.npy'),x);diff=x.reshape(-1)-y.reshape(-1);out['vs_native_bf16_component'].append({'index':i,'maxabs':float(abs(diff).max()),'rel_l2':float(np.linalg.norm(diff)/(np.linalg.norm(y)+1e-20)),'finite':bool(np.isfinite(x).all())})
  out['status']='completed'
except BaseException:out.update(status='failed',error=traceback.format_exc())
out['finished']=time.time();save();print(json.dumps(out,indent=2))
