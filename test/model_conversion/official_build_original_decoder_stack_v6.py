import os,sys,json,time,traceback,argparse,hashlib,subprocess,gc
from pathlib import Path
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
sys.path.insert(0,'/opt/locate-oellm-research-v1/leap-source-overlay')
import numpy as np
import torch
from safetensors import safe_open
from hbdk4.compiler import leap,save,convert,compile,link
from leap_llm.models.deepseek.blocks import DecoderLayer
from leap_llm.nn.modules import FakeQuantMatmul,FakeQuantLinear,FakeQuantRMSNorm
from leap_llm.nn.modules.const_fake_quant import ConstFakeQuant
from leap_llm.nn.utils import Model
ap=argparse.ArgumentParser();ap.add_argument('--layers',type=int,required=True);args=ap.parse_args();assert args.layers in [2,36]
torch.set_num_threads(2)
r=Path('/opt/locate-oellm-research-v1')/('original-decoder-stack-'+str(args.layers)+'-v6');r.mkdir(exist_ok=False)
report={'status':'calibrating','pid':os.getpid(),'started':time.time(),'layer_count':args.layers,'scope':'original weights decoder stack AR profile only; not complete multimodal acceptance','board_calls':0,'cache_len':512,'layers':[],'fresh_final_used':False}
def store(): (r/'status.json').write_text(json.dumps(report,indent=2))
store()
c=json.loads(Path('/model/config.json').read_text())['text_config'];index=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map']

def integer_weight_build(self,x):
 x=self.x_fake_quant(x)
 assert self.w_bits==8
 weight=self.weight.data.float()
 scales=self.absmax_weight.double().clamp_min(1e-20)/128
 codes=(weight.double()/scales[:,None]).round().clamp(-127,127).to(torch.int8)
 qweight=leap.dequantize(codes,scales=scales.tolist(),zeros=[0]*weight.shape[0],axis=0)
 bias=self.bias.data.float() if self.bias is not None else None
 return self.out_fake_quant(leap.linear(x,qweight,bias=bias))
FakeQuantLinear.build=integer_weight_build
report['weight_export_recipe']='INT8 codes round-to-even, per-output-channel scale absmax/128, clip[-127,127]; new candidate, near but not bitwise equivalent to official FQ'

class Stack(Model):
 def __init__(self):
  super().__init__();self.layers=torch.nn.ModuleList();self.final_norm=None
 def build(self,hidden,cos,sin,mask,*caches):
  keys=[];values=[]
  for i,layer in enumerate(self.layers):
   hidden,key,value=layer(hidden,cos,sin,caches[i],caches[len(self.layers)+i],mask);keys.append(key);values.append(value)
   for parameter in layer.parameters():parameter.data=torch.empty(0,dtype=parameter.dtype)
   gc.collect()
  if self.final_norm is not None:hidden=self.final_norm(hidden)
  return hidden,*keys,*values
try:
 model=Stack()
 for i in range(args.layers):
  if int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])<7*1024**2:raise MemoryError('Preserve at least7GiB available during stack preparation')
  kw={k:c[k] for k in ['hidden_size','num_attention_heads','num_key_value_heads','max_position_embeddings','rope_theta','intermediate_size','rms_norm_eps']}
  m=DecoderLayer(layer_id=i,preserve_precision=True,w_bits=8,has_scale=False,fuse_norm=False,**kw)
  m.self_attn.qk=FakeQuantMatmul(16,16);m.self_attn.sv=FakeQuantMatmul(None,16);m.self_attn.v_proj=FakeQuantLinear(2048,256,bias=True,quant_bits=16,w_bits=8);m.set_children_parent()
  prefix='language_model.model.layers.'+str(i)+'.';state={}
  for shard in sorted(set(index[k] for k in index if k.startswith(prefix))):
   with safe_open('/model/'+shard,framework='pt',device='cpu') as f:
    for k in index:
     if k.startswith(prefix) and index[k]==shard:state[k[len(prefix):]]=f.get_tensor(k).float()
  m.load_state_dict(state,strict=True);del state
  m.compile_mode(False);used=set();hooks=[x.register_forward_hook(lambda mod,a,o,n=n:used.add(n)) for n,x in m.named_modules() if isinstance(x,ConstFakeQuant) and x.quantized]
  for image in [1144,2444]:
   p=Path('/work/all-decoder-layer-captures-v1')/('gptq-bf16-'+str(image)+'-slow')/('block'+str(i)+'-call-1')
   def t(n):return torch.from_numpy(np.load(p/(n+'.npy')))
   hidden=t('hidden_states');positions=t('position_ids').flatten();angles=positions.float()[:,None]*(1/(c['rope_theta']**(torch.arange(0,128,2).float()/128)))[None,:];angles=torch.cat([angles,angles],-1)
   oldk=t('past-0')[0];oldv=t('past-1')[0];pad=512-1-oldk.shape[1];assert pad>0
   k=torch.cat([torch.zeros(2,pad+1,128),oldk],1);v=torch.cat([torch.zeros(2,pad+1,128),oldv],1);mask=torch.cat([torch.full((1,pad),-32767.),torch.zeros(1,oldk.shape[1]+1)],1)
   with torch.inference_mode():m(hidden,angles.cos(),angles.sin(),k,v,mask)
  for h in hooks:h.remove()
  ranges={n:float(x.absmax) for n,x in m.named_modules() if n in used}
  assert all(np.isfinite(x) and x>0 for x in ranges.values()),ranges
  report['layers'].append({'index':i,'strict_weight_load':True,'ranges':ranges,'calibration':'old1144/2444 GPTQ trajectory AR activations; original BF16 parameter values, float32 observer pass'})
  m.to(torch.bfloat16);m.input_layernorm.float();m.post_attention_layernorm.float();m.compile_mode(True);model.layers.append(m);del hidden,k,v,oldk,oldv;gc.collect();store()
 if args.layers==36:
  n='language_model.model.norm.weight'
  model.final_norm=FakeQuantRMSNorm(2048,preserve_precision=True)
  with safe_open('/model/'+index[n],framework='pt',device='cpu') as f:model.final_norm.weight.data.copy_(f.get_tensor(n).float())
  report['original_final_norm_included']=True
 model.set_children_parent();model.compile_mode(True)
 types=[leap.TensorType([1,1,2048],leap.float32),leap.TensorType([1,128],leap.float32),leap.TensorType([1,128],leap.float32),leap.TensorType([1,512],leap.float32)]+[leap.TensorType([2,512,128],leap.float32) for _ in range(args.layers*2)]
 report['status']='exporting';store();module=model.export_module(types,name='locate_original_stack'+str(args.layers)+'_ar',save_path=str(r/'stack.bc'))
 report['python_parameters_released_after_emit']=True
 del model;gc.collect()
 report['status']='converting';store();converted=convert(module,'nash-m',enable_vpu=True);save(converted,str(r/'stack-converted.bc'));del module;gc.collect()
 report['status']='compiling';store();hbo=compile(converted,str(r/'stack.hbo'),march='nash-m',opt=0,jobs=2);link([hbo],str(r/'stack.hbm'))
 d=json.loads(subprocess.check_output(['/usr/local/lib/python3.10/dist-packages/hbdk4/compiler/_mlir_libs/hbrt4-disas','--json',str(r/'stack.hbm')],text=True));(r/'disas.json').write_text(json.dumps(d));report.update(status='completed',hbm_sha256=hashlib.sha256((r/'stack.hbm').read_bytes()).hexdigest(),devices=[n['device'] for g in d['graphs'] for n in g['nodes']],finished=time.time());store()
except BaseException:report.update(status='failed',error=traceback.format_exc(),finished=time.time());store();raise
