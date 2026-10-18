"""Actual prepared first-layer files to official compiler modules;no neural calls or HBM compilation."""
from pathlib import Path
import copy,gc,hashlib,json,sys,time,resource
B=Path('/opt/locate-oellm-research-v1');sys.path[:0]=[str(B/'sdk448-isolated/python'),str(B/'leap-source-overlay'),'/work/official-llm-v1']
import numpy as np
import torch
from safetensors import safe_open
from leap_llm.nn.modules.linear import FakeQuantLinear
from leap_llm.nn.modules.const_fake_quant import ConstFakeQuant
from locateanything_row_gptq_checkpoint_v1 import read_weight,apply_official_linear,digest
root=Path('/opt/locate-row-gptq-full36-checkpoint-v2');report=json.loads(Path('/opt/locate-row-gptq-full36-v2/status.json').read_text());entries=[x for x in report['modules'] if x['name'].startswith('language_model.model.layers.0.')];assert len(entries)==7 and report['source_sha256']=='27e21707255278e26254b7336a50e663963006329e2a78d404b398678e9ef4f9'
index=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map'];torch.set_num_threads(2);passed=[]
for e in entries:
 key=e['name']+'.weight';bias=e['name']+'.bias'
 with safe_open('/model/'+index[key],framework='pt',device='cpu') as f:original=f.get_tensor(key);state={'weight':original.float()}
 if bias in index:
  with safe_open('/model/'+index[bias],framework='pt',device='cpu') as f:state['bias']=f.get_tensor(bias).float()
 module=FakeQuantLinear(e['shape'][1],e['shape'][0],bias=bias in index);module.load_state_dict(state,strict=True)
 before={name:(x.bits,x.quantized) for name,x in module.named_modules() if isinstance(x,ConstFakeQuant)};saved_bias=module.bias.detach().clone() if module.bias is not None else None
 codes,scales=apply_official_linear(module,root,e)
 assert module.w_bits==4 and module.has_scale and np.array_equal(module.scales.numpy(),scales)
 assert torch.equal(module.weight.detach(),torch.from_numpy(codes).float()*torch.from_numpy(scales))
 assert before=={name:(x.bits,x.quantized) for name,x in module.named_modules() if isinstance(x,ConstFakeQuant)}
 assert (saved_bias is None and module.bias is None) or torch.equal(module.bias.detach(),saved_bias)
 passed.append(dict(name=e['name'],artifact_sha256=e['sha256'],exact_fp32_prepared_weight=True,original_parameter_identity_checked=True,bias_unchanged=True,activation_observer_configuration_unchanged=True));del module,state,original,codes,scales;gc.collect()
negative=[]
for label,change,kwargs in [
 ('wrong_bits',lambda e:e.__setitem__('logical_weight_bits',8),{}),
 ('changed_artifact',lambda e:e.__setitem__('sha256','0'*64),{}),
 ('wrong_shape',lambda e:None,{'expected_shape':(1,2)}),
 ('wrong_original_weight',lambda e:None,{'original_bf16_bytes':b'wrong-original-parameter'})]:
 e=copy.deepcopy(entries[0]);change(e)
 try:read_weight(root,e,**kwargs)
 except ValueError:negative.append(label);continue
 raise AssertionError('Invalid prepared weight admitted: '+label)
out=dict(status='passed',created=time.time(),source_sha256=digest(Path(__file__)),loader_sha256=digest(Path('/work/official-llm-v1/locateanything_row_gptq_checkpoint_v1.py')),preparation_source_sha256=report['source_sha256'],actual_projections=passed,negative_controls=negative,neural_calls=0,hbm_compiles=0,whole_model_verified=False,cpu_maximum_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024,scope=__doc__)
p=Path('/work/official-llm-v1/row-gptq-checkpoint-official-bridge-v1.json');assert not p.exists();p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:out[k] for k in ['status','negative_controls','neural_calls','cpu_maximum_rss_bytes']}))
