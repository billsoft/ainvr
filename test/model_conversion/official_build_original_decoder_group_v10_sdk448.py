import os,sys,json,time,traceback,argparse,hashlib,subprocess,gc
from pathlib import Path
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
sys.path.insert(0,'/opt/locate-oellm-research-v1/leap-source-overlay')
sys.path.insert(0,'/opt/locate-oellm-research-v1/sdk448-isolated/python')
import numpy as np
import torch
from safetensors import safe_open
from hbdk4.compiler import leap,save,convert,compile,link
from leap_llm.models.deepseek.blocks import DecoderLayer
from leap_llm.nn.modules import FakeQuantMatmul,FakeQuantLinear,FakeQuantRMSNorm
from leap_llm.nn.modules.const_fake_quant import ConstFakeQuant
from leap_llm.nn.utils import Model
ap=argparse.ArgumentParser();ap.add_argument('--layers',type=int,required=True);ap.add_argument('--start-layer',type=int,default=0);ap.add_argument('--include-final-norm',action='store_true');ap.add_argument('--seq',type=int,default=12);args=ap.parse_args();assert args.seq in [1,12,256];assert args.layers in [2,9,36] and 0<=args.start_layer and args.start_layer+args.layers<=36
torch.set_num_threads(2)
r=Path('/opt/locate-oellm-research-v1')/('original-decoder-group-'+str(args.start_layer)+'-'+str(args.start_layer+args.layers-1)+'-s'+str(args.seq)+'-v10-sdk448');r.mkdir(exist_ok=False)
report={'status':'calibrating','pid':os.getpid(),'started':time.time(),'layer_count':args.layers,'start_layer':args.start_layer,'end_layer':args.start_layer+args.layers-1,'scope':'original weights padded decoder profile, broad tuning calibration; not complete multimodal acceptance','sequence_capacity':args.seq,'board_calls':0,'final_norm_location':'decoder' if args.include_final_norm else 'existing complete BPU vocabulary head','cache_len':512,'layers':[],'fresh_final_used':False}
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
 for local_index in range(args.layers):
  i=args.start_layer+local_index
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
   for mode in ['slow','hybrid']:
    for call in range(3):
     p=Path('/work/all-decoder-layer-captures-v1')/('gptq-bf16-'+str(image)+'-'+mode)/('block'+str(i)+'-call-'+str(call))
     def t(n):return torch.from_numpy(np.load(p/(n+'.npy')))
     hidden=t('hidden_states');positions=t('position_ids').flatten();seqlen=hidden.shape[1]
     angles=positions.float()[:,None]*(1/(c['rope_theta']**(torch.arange(0,128,2).float()/128)))[None,:];angles=torch.cat([angles,angles],-1)
     oldk=t('past-0')[0] if (p/'past-0.npy').exists() else torch.zeros(2,0,128)
     oldv=t('past-1')[0] if (p/'past-1.npy').exists() else torch.zeros(2,0,128)
     pad=512-seqlen-oldk.shape[1];assert pad>=0
     k=torch.cat([torch.zeros(2,pad+seqlen,128),oldk],1);v=torch.cat([torch.zeros(2,pad+seqlen,128),oldv],1)
     validmask=t('attention_mask')[0,0].clamp(min=-32767.,max=0.) if (p/'attention_mask.npy').exists() else torch.zeros(seqlen,oldk.shape[1]+seqlen)
     mask=torch.cat([torch.full((seqlen,pad),-32767.),validmask],1)
     with torch.inference_mode():m(hidden,angles.cos(),angles.sin(),k,v,mask)
  for h in hooks:h.remove()
  ranges={n:float(x.absmax) for n,x in m.named_modules() if n in used}
  assert all(np.isfinite(x) and x>0 for x in ranges.values()),ranges
  report['layers'].append({'index':i,'strict_weight_load':True,'ranges':ranges,'calibration':'old1144/2444 slow+hybrid first3captures, original BF16 parameter values with FP32 observer pass, valid original masks with negative sentinel limited to -32767'})
  m.to(torch.bfloat16);m.input_layernorm.float();m.post_attention_layernorm.float();m.compile_mode(True);model.layers.append(m);del hidden,k,v,oldk,oldv;gc.collect();store()
 if args.start_layer+args.layers==36 and args.include_final_norm:
  n='language_model.model.norm.weight'
  model.final_norm=FakeQuantRMSNorm(2048,preserve_precision=True)
  with safe_open('/model/'+index[n],framework='pt',device='cpu') as f:model.final_norm.weight.data.copy_(f.get_tensor(n).float())
  report['original_final_norm_included']=True
 model.set_children_parent();model.compile_mode(True)
 types=[leap.TensorType([args.seq,2048],leap.float32),leap.TensorType([args.seq,128],leap.float32),leap.TensorType([args.seq,128],leap.float32),leap.TensorType([args.seq,512],leap.float32)]+[leap.TensorType([2,512,128],leap.float32) for _ in range(args.layers*2)]
 report['status']='exporting';store();module=model.export_module(types,name='locate_group'+str(args.start_layer)+'_'+str(args.start_layer+args.layers-1)+'_s'+str(args.seq),save_path=str(r/'stack.bc'))
 report['python_parameters_released_after_emit']=True
 del model;gc.collect()
 report['status']='converting';store();converted=convert(module,'nash-m',enable_vpu=True);save(converted,str(r/'stack-converted.bc'));del module;gc.collect()
 report['status']='compiling';store();hbo=compile(converted,str(r/'stack.hbo'),march='nash-m',opt=0,jobs=1);link([hbo],str(r/'stack.hbm'))
 d=json.loads(subprocess.check_output(['/opt/locate-oellm-research-v1/sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas','--json',str(r/'stack.hbm')],text=True));(r/'disas.json').write_text(json.dumps(d));report.update(status='completed',hbm_sha256=hashlib.sha256((r/'stack.hbm').read_bytes()).hexdigest(),devices=[n['device'] for g in d['graphs'] for n in g['nodes']],finished=time.time());store()
except BaseException:report.update(status='failed',error=traceback.format_exc(),finished=time.time());store();raise
