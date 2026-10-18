"""Actual mixed first-layer checkpoint to official modules;attention original weights retained,W4 MLP applied;zero neural calls."""
from pathlib import Path
import copy,gc,json,sys,time,resource
B=Path('/opt/locate-oellm-research-v1');sys.path[:0]=[str(B/'sdk448-isolated/python'),str(B/'leap-source-overlay'),'/work/official-llm-v1']
import numpy as np
import torch
from safetensors import safe_open
from leap_llm.nn.modules.linear import FakeQuantLinear
from leap_llm.nn.modules.const_fake_quant import ConstFakeQuant
from locateanything_row_gptq_mixed_checkpoint_v2 import prepare_official_projection,read_attention_weight,PREPARATION_SHA
from locateanything_row_gptq_checkpoint_v1 import read_weight,digest
root=Path('/opt/locate-row-gptq-mixed-full36-checkpoint-v3');r=json.loads(Path('/opt/locate-row-gptq-mixed-full36-v3/status.json').read_text());entries=[x for x in r['modules'] if x['name'].startswith('language_model.model.layers.0.')];assert len(entries)==7 and r['source_sha256']==PREPARATION_SHA
index=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map'];torch.set_num_threads(2);passed=[]
for e in entries:
 key=e['name']+'.weight';bias=e['name']+'.bias'
 with safe_open('/model/'+index[key],framework='pt',device='cpu') as f:original=f.get_tensor(key);state={'weight':original.float()}
 if bias in index:
  with safe_open('/model/'+index[bias],framework='pt',device='cpu') as f:state['bias']=f.get_tensor(bias).float()
 module=FakeQuantLinear(e['shape'][1],e['shape'][0],bias=bias in index);module.load_state_dict(state,strict=True)
 before={n:(x.bits,x.quantized) for n,x in module.named_modules() if isinstance(x,ConstFakeQuant)};saved_bias=module.bias.detach().clone() if module.bias is not None else None
 codes,scales=prepare_official_projection(module,root,e)
 if e['logical_weight_bits']==4:
  assert module.w_bits==4 and module.has_scale and np.array_equal(module.scales.numpy(),scales) and torch.equal(module.weight.detach(),torch.from_numpy(codes).float()*torch.from_numpy(scales))
 else:
  assert module.w_bits==8 and not hasattr(module,'scales') and torch.equal(module.weight.detach(),original.float())
 assert before=={n:(x.bits,x.quantized) for n,x in module.named_modules() if isinstance(x,ConstFakeQuant)}
 assert (saved_bias is None and module.bias is None) or torch.equal(module.bias.detach(),saved_bias)
 passed.append(dict(name=e['name'],bits=e['logical_weight_bits'],artifact_sha256=e['sha256'],original_w8_attention_not_requantized=e['logical_weight_bits']==8,original_identity_verified=True,bias_unchanged=True,activation_configuration_unchanged=True));del module,state,original,codes,scales;gc.collect()
a=next(x for x in entries if x['logical_weight_bits']==8);key=a['name']+'.weight'
with safe_open('/model/'+index[key],framework='pt',device='cpu') as f:raw=f.get_tensor(key).contiguous().view(torch.uint8).numpy().tobytes()
negative=[]
for label,change,shape,original_bytes in [('wrong_bits',lambda e:e.__setitem__('logical_weight_bits',4),a['shape'],raw),('changed_artifact',lambda e:e.__setitem__('sha256','0'*64),a['shape'],raw),('wrong_shape',lambda e:None,(1,2),raw),('wrong_original',lambda e:None,a['shape'],b'wrong'),('attention_spoofed_as_mlp',lambda e:e.__setitem__('name',e['name'].replace('self_attn.q_proj','mlp.gate_proj')),a['shape'],raw)]:
 e=copy.deepcopy(a);change(e)
 try:read_attention_weight(root,e,shape,original_bytes)
 except ValueError:negative.append(label);continue
 raise AssertionError(label)
out=dict(status='passed',created=time.time(),source_sha256=digest(__file__),mixed_loader_sha256=digest('/work/official-llm-v1/locateanything_row_gptq_mixed_checkpoint_v2.py'),w4_loader_sha256=digest('/work/official-llm-v1/locateanything_row_gptq_checkpoint_v1.py'),preparation_source_sha256=r['source_sha256'],actual_projections=passed,negative_controls=negative,neural_calls=0,hbm_compiles=0,full_preparation_completed_claim=False,whole_model_verified=False,cpu_maximum_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024,scope=__doc__)
p=Path('/work/official-llm-v1/row-gptq-mixed-official-bridge-v2.json');assert not p.exists();p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:out[k] for k in ['status','negative_controls','neural_calls','cpu_maximum_rss_bytes']}))
