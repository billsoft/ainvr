"""Original decoder stack with exact affine group32 W4/W8 checkpoint values.

Uses verified batched matrix multiplication for M1 and grouped1x1 convolution
for longer profiles. Preserves full original attention/norm/MLP/residual/cache.
No multi-INT8 approximation, weight re-quantization, final-data calibration or
production fallback. Compiler and board acceptance remain separately required.
"""
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
from leap_llm.nn.modules import FakeQuantMatmul,FakeQuantLinear,FakeQuantRMSNorm,FakeQuantSoftmax
from leap_llm.nn.modules.const_fake_quant import ConstFakeQuant
from leap_llm.nn.utils import Model
ap=argparse.ArgumentParser();ap.add_argument('--layers',type=int,required=True);ap.add_argument('--start-layer',type=int,default=0);ap.add_argument('--include-final-norm',action='store_true');ap.add_argument('--seq',type=int,default=12);ap.add_argument('--checkpoint-manifest',type=Path,required=True);ap.add_argument('--checkpoint-sha256',required=True);ap.add_argument('--label',required=True);ap.add_argument('--convert-only',action='store_true');ap.add_argument('--jobs',type=int,choices=[1,2],default=2);args=ap.parse_args();assert args.label and all(x in 'abcdefghijklmnopqrstuvwxyz0123456789-' for x in args.label);assert args.seq in [1,12,256];assert args.layers in [1,2,9,36] and 0<=args.start_layer and args.start_layer+args.layers<=36
torch.set_num_threads(2)
r=Path('/opt/locate-oellm-research-v1')/('compact-affine-'+args.label+'-decoder-group-'+str(args.start_layer)+'-'+str(args.start_layer+args.layers-1)+'-s'+str(args.seq)+'-v2-sdk448');r.mkdir(exist_ok=False)
report={'status':'calibrating','pid':os.getpid(),'started':time.time(),'layer_count':args.layers,'start_layer':args.start_layer,'end_layer':args.start_layer+args.layers-1,'scope':'Original decoder with exact affine group32 W4/W8 checkpoint; no multi-INT8 approximate weights; graph qualification only,not full-model quality','sequence_capacity':args.seq,'board_calls':0,'final_norm_location':'decoder' if args.include_final_norm else 'existing complete BPU vocabulary head','cache_len':512,'layers':[],'fresh_final_used':False}
def store(): (r/'status.json').write_text(json.dumps(report,indent=2))
store()
c=json.loads(Path('/model/config.json').read_text())['text_config'];index=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map']

def digest(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for v in iter(lambda:f.read(4*1024**2),b''):h.update(v)
 return h.hexdigest()
checkpoint_path=args.checkpoint_manifest.resolve();assert checkpoint_path.parent.is_relative_to(Path('/opt')) and digest(checkpoint_path)==args.checkpoint_sha256
checkpoint=json.loads(checkpoint_path.read_text());assert len(checkpoint['modules'])==252
selected={v['name']:v for v in checkpoint['modules']};assert len(selected)==252
report['mask_addition_kept_float32']=True
report['attention_softmax_recipe']='subtract exact per-row max then symmetric INT16 centered range64 before original softmax;tail bound512exp(-64)<9e-26'
report['centered_mask_quant_absmax']=64.0
report['attention_qk_output_f32']=True
report.update(source_sha256=digest(Path(__file__)),selected_checkpoint_sha256=digest(checkpoint_path),selected_modules=[],
 weight_export_recipe='Exact affine group32 signed4/8 codes plus group scales and zero-sum correction; no approximate INT8 branches',
 route='batch' if args.seq==1 else 'groupconv',convert_only=args.convert_only,compile_jobs=args.jobs)

def compact_weight_build(self,x):
 x=self.x_fake_quant(x)
 bits,group,unsigned,scales,zeros=self._compact_affine
 M,K=list(x.type.shape);N=unsigned.shape[0];assert unsigned.shape==(N,K) and K%group==0
 G=K//group;center=1<<(bits-1);codes=(unsigned.astype(np.int16)-center).astype(np.int8)
 if args.seq==1:
  grouped=leap.transpose(leap.reshape(x,[M,G,group]),[1,0,2])
  code_data=codes.reshape(N,G,group).transpose(1,2,0).copy()
  weight=leap.dequantize(torch.from_numpy(code_data),scales=[1.],zeros=[0],axis=0)
  product=leap.matmul(grouped,weight)
  summed=leap.reshape(leap.reduce_sum(grouped,[2]),[G,M,1])
  gain=scales.T[:,None,:].copy();offset=((center-zeros.astype(np.int32))*scales).T[:,None,:].copy()
  total=leap.reshape(leap.reduce_sum(leap.add(leap.mul(product,torch.from_numpy(gain)),leap.mul(summed,torch.from_numpy(offset))),[0]),[M,N])
 else:
  total=None;chunk_size=min(16,32768//N);assert chunk_size>=1
  grouped_codes=codes.reshape(N,G,group).transpose(1,0,2)
  for first in range(0,G,chunk_size):
   last=min(first+chunk_size,G);count=last-first
   part=leap.slice(x,[0,first*group],[M,last*group],[1,1])
   inputs=leap.reshape(part,[1,M,1,count*group])
   filters=grouped_codes[first:last].reshape(count*N,1,1,group).copy()
   weight=leap.dequantize(torch.from_numpy(filters),scales=scales[:,first:last].T.reshape(-1).tolist(),zeros=[0]*(count*N),axis=0)
   product=leap.conv2d(inputs,weight,stride=[1,1],pad=[0,0,0,0],dilation=[1,1],groupNum=count)
   product=leap.reshape(product,[M,count,N])
   summed=leap.reshape(leap.reduce_sum(leap.reshape(part,[M,count,group]),[2]),[M,count,1])
   offsets=((center-zeros[:,first:last].astype(np.int32))*scales[:,first:last]).T.reshape(1,count,N).copy()
   collapsed=leap.reshape(leap.reduce_sum(leap.add(product,leap.mul(summed,torch.from_numpy(offsets))),[1]),[M,N])
   total=collapsed if total is None else leap.add(total,collapsed)
 if self.bias is not None:total=leap.add(total,self.bias.data.float())
 return self.out_fake_quant(total)
FakeQuantLinear.build=compact_weight_build

def centered_softmax_build(self,x):
 shape=list(x.type.shape);assert shape[-1]==512
 maximum=leap.reshape(leap.reduce_max(x,[-1]),shape[:-1]+[1])
 centered=leap.add(x,leap.mul(maximum,-1.))
 centered=leap.const_fake_quant(centered,[-64.],[64.],16,True)
 out=leap.softmax(centered,-1)
 return self.out_quant(out) if self.quantized else out
FakeQuantSoftmax.build=centered_softmax_build

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
  m.self_attn.qk=FakeQuantMatmul(16,16,None);m.self_attn.sv=FakeQuantMatmul(None,16);m.self_attn.v_proj=FakeQuantLinear(2048,256,bias=True,quant_bits=16,w_bits=8);m.self_attn.add_mask.quantized=False;m.set_children_parent()
  prefix='language_model.model.layers.'+str(i)+'.';state={}
  for shard in sorted(set(index[k] for k in index if k.startswith(prefix))):
   with safe_open('/model/'+shard,framework='pt',device='cpu') as f:
    for k in index:
     if k.startswith(prefix) and index[k]==shard:state[k[len(prefix):]]=f.get_tensor(k).float()
  m.load_state_dict(state,strict=True);del state
  replaced=0
  for name,linear in m.named_modules():
   if not isinstance(linear,FakeQuantLinear):continue
   key=prefix+name;item=selected[key];path=Path(item['packed_file']).resolve()
   assert path.parent==checkpoint_path.parent and digest(path)==item['sha256']
   with np.load(path,allow_pickle=False) as data:
    bits=int(data['weight_bits']) if 'weight_bits' in data else 4;group=int(data['group_size']);shape=data['shape'].tolist()
    assert bits in [4,8] and group==32 and tuple(shape)==tuple(linear.weight.shape)
    N,K=shape;assert K%group==0
    if bits==4:
     payload=data['packed'];assert payload.dtype==np.uint8 and payload.shape==(N,(K+1)//2)
     unsigned=np.stack([payload&15,payload>>4],axis=-1).reshape(N,-1)[:,:K].copy()
    else:
     payload=data['codes'];assert payload.dtype==np.uint8 and payload.shape==(N,K);unsigned=payload.copy()
    scales=data['scales'].astype(np.float32).copy();zeros=data['zeros'].copy()
    assert scales.shape==zeros.shape==(N,K//group) and zeros.dtype==np.uint8
    assert np.isfinite(scales).all() and (scales>0).all() and int(zeros.max())<2**bits
    assert item.get('logical_weight_bits',bits)==bits
   ids=np.arange(K)//group;restored=(unsigned.astype(np.float32)-zeros[:,ids])*scales[:,ids]
   assert np.isfinite(restored).all()
   linear.weight.data.copy_(torch.from_numpy(restored));linear._compact_affine=(bits,group,unsigned,scales,zeros);linear.w_bits=bits
   report['selected_modules'].append(dict(name=key,checkpoint_file_sha256=item['sha256'],bits=bits,group_size=group,
    represented_weight_recipe='raw float32 affine checkpoint values; BF16 oracle weight rounding differs',
    packed_payload_bytes=payload.nbytes,source_shape=shape,approximate_int8_branches=0));replaced+=1
  assert replaced==7
  del restored,payload;gc.collect()
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
 report['python_parameters_released_after_emit']=True;assert len(report['selected_modules'])==7*args.layers
 del model;gc.collect()
 report['status']='converting';store();converted=convert(module,'nash-m',enable_vpu=True);save(converted,str(r/'stack-converted.bc'));del module;gc.collect();assert 'external_cpu' not in str(converted.module),'Reject neural CPU fallback before compilation'
 report.update(status='converted_bpu_graph' if args.convert_only else 'compiling',converted_bc_sha256=digest(r/'stack-converted.bc'));store();
 if args.convert_only:raise SystemExit(0)
 hbo=compile(converted,str(r/'stack.hbo'),march='nash-m',opt=0,jobs=args.jobs);link([hbo],str(r/'stack.hbm'))
 d=json.loads(subprocess.check_output(['/opt/locate-oellm-research-v1/sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas','--json',str(r/'stack.hbm')],text=True));(r/'disas.json').write_text(json.dumps(d));devices=[n['device'] for g in d['graphs'] for n in g['nodes']];assert devices and all(v=='DEVICE_CATEGORY_BPU' for v in devices),'Reject neural CPU fallback';report.update(status='completed',hbm_sha256=digest(r/'stack.hbm'),hbm_bytes=(r/'stack.hbm').stat().st_size,devices=devices,bpu_only=True,finished=time.time());store()
except SystemExit:
 report.update(finished=time.time());store();raise
except BaseException:report.update(status='failed',error=traceback.format_exc(),finished=time.time());store();raise
