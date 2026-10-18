import torch,numpy as np,json,math,time,argparse,traceback
from pathlib import Path
from safetensors import safe_open
from hbdk4.compiler import load
ap=argparse.ArgumentParser();ap.add_argument('--layers',type=int,default=2);a=ap.parse_args();torch.set_num_threads(2)
r=Path('/opt/locate-oellm-research-v1')/('original-decoder-stack-'+str(a.layers)+'-v2');idx=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map'];out={'scope':'PC converted graph versus independent original-weight FP32 decoder math on old tuning activation only','layers':a.layers,'board_calls':0,'started':time.time()}
try:
 base=Path('/work/all-decoder-layer-captures-v1/gptq-bf16-1144-slow');p=base/'block0-call-1'
 h=torch.from_numpy(np.load(p/'hidden_states.npy'));pos=torch.from_numpy(np.load(p/'position_ids.npy')).flatten().float();ang=pos[:,None]*(1/(1e6**(torch.arange(0,128,2).float()/128)))[None,:];ang=torch.cat([ang,ang],-1);cos=ang.cos();sin=ang.sin();ks=[];vs=[]
 for i in range(a.layers):
  q=base/('block'+str(i)+'-call-1');k=torch.from_numpy(np.load(q/'past-0.npy'))[0];v=torch.from_numpy(np.load(q/'past-1.npy'))[0];pad=512-1-k.shape[1];ks.append(torch.cat([torch.zeros(2,pad+1,128),k],1));vs.append(torch.cat([torch.zeros(2,pad+1,128),v],1))
 mask=torch.cat([torch.full((1,pad),-32767.),torch.zeros(1,k.shape[1]+1)],1)
 inputs=[h.numpy(),cos.numpy(),sin.numpy(),mask.numpy()]+[x.numpy() for x in ks+vs]
 def rotate(x):return torch.cat([-x[...,64:],x[...,:64]],-1)
 keys=[];values=[]
 with torch.inference_mode():
  for i in range(a.layers):
   prefix='language_model.model.layers.'+str(i)+'.';state={}
   for shard in sorted(set(idx[n] for n in idx if n.startswith(prefix))):
    with safe_open('/model/'+shard,framework='pt',device='cpu') as f:
     for n in idx:
      if n.startswith(prefix) and idx[n]==shard:state[n[len(prefix):]]=f.get_tensor(n).float()
   def norm(x,w):return x*torch.rsqrt((x*x).mean(-1,keepdim=True)+1e-6)*state[w]
   def linear(x,n):return torch.nn.functional.linear(x,state[n+'.weight'],state.get(n+'.bias'))
   x=norm(h,'input_layernorm.weight');q=linear(x,'self_attn.q_proj').reshape(1,16,128).transpose(0,1);k=linear(x,'self_attn.k_proj').reshape(1,2,128).transpose(0,1);v=linear(x,'self_attn.v_proj').reshape(1,2,128).transpose(0,1);q=q*cos+rotate(q)*sin;k=k*cos+rotate(k)*sin
   fullk=torch.cat([ks[i][:,1:,:],k],1).repeat_interleave(8,0);fullv=torch.cat([vs[i][:,1:,:],v],1).repeat_interleave(8,0)
   prob=torch.softmax((q@fullk.transpose(1,2))/math.sqrt(128)+mask,-1);attn=(prob@fullv).transpose(0,1).reshape(1,1,2048);h=h+linear(attn,'self_attn.o_proj');x=norm(h,'post_attention_layernorm.weight');h=h+linear(torch.nn.functional.silu(linear(x,'mlp.gate_proj'))*linear(x,'mlp.up_proj'),'mlp.down_proj');keys.append(k);values.append(v)
   del state
 refs=[h.numpy()]+[x.numpy() for x in keys+values]
 actual=load(str(r/'stack-converted.bc')).functions[0](*inputs)
 out['outputs']=[]
 for i,(actual,ref) in enumerate(zip(actual,refs)):
  actual=np.asarray(actual).astype(np.float32);diff=actual.reshape(-1)-ref.reshape(-1);out['outputs'].append({'index':i,'maxabs':float(abs(diff).max()),'rel_l2':float(np.linalg.norm(diff)/(np.linalg.norm(ref)+1e-20)),'finite':bool(np.isfinite(actual).all())})
 out['status']='completed'
except BaseException:out.update(status='failed',error=traceback.format_exc())
out['finished']=time.time();(r/'pc-reference-v1.json').write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
