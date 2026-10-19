"""Vision attention-precision recipe probe (v296):same official Q8 weights,only qk/sv activation bits vary.

Research candidate only;writes under /opt/locate-vision-recipe-probe-v296 and never touches deployed HBMs.
"""
from pathlib import Path
import os,sys,json,time,hashlib,traceback,subprocess,math,argparse
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
BASE=Path('/opt/locate-oellm-research-v1');sys.path.insert(0,str(BASE/'sdk448-isolated/python'));sys.path.insert(0,str(BASE/'leap-source-overlay'))
import numpy as np
import torch
import torch.nn.functional as F
from safetensors import safe_open
from hbdk4.compiler import leap
from leap_llm.nn.utils import Model
from leap_llm.nn.modules.linear import FakeQuantLinear
from leap_llm.nn.modules.layer_norm import LayerNormSplit
from leap_llm.nn.modules.matmul import FakeQuantMatmul
from leap_llm.nn.modules.activation import FakeQuantSoftmax
from leap_llm.nn.modules.const_fake_quant import ConstFakeQuant
from leap_llm.nn.modules.ops import FakeQuantAdd,FakeQuantMul

ap=argparse.ArgumentParser();ap.add_argument('--stage',type=int,required=True,choices=range(0,27));ap.add_argument('--qk',required=True,choices=['8x8','8x16','16x16']);ap.add_argument('--sv',required=True,choices=['16x8','16x16']);ap.add_argument('--wbits',type=int,default=8,choices=[8,16]);A=ap.parse_args();STAGE=A.stage;QK=tuple(int(x) for x in A.qk.split('x'));SV=tuple(int(x) for x in A.sv.split('x'))

def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def metric(a,b):
 a=np.asarray(a,np.float64);b=np.asarray(b,np.float64);assert a.shape==b.shape and np.isfinite(a).all() and np.isfinite(b).all()
 return dict(rel_l2=float(np.linalg.norm(a-b)/max(np.linalg.norm(b),1e-12)),max_abs=float(np.abs(a-b).max()))

class W16Linear(FakeQuantLinear):
 """Diagnostic only:16-bit per-channel weight fake-quant to measure the weight-quantization share."""
 def build(self,x):
  xq=self.x_fake_quant(x);wmax=self.absmax_weight.tolist();wq=leap.const_fake_quant(self.weight.data.to(torch.float32),[-v for v in wmax],wmax,16,True,axis=0)
  return self.out_fake_quant(leap.linear(xq,wq,bias=self.bias.data.to(torch.float32) if self.bias is not None else None))

class MoonBlock(Model):
 def __init__(self):
  super().__init__();idx=json.loads(Path('/model/model.safetensors.index.json').read_text())['weight_map'];prefix=f'vision_model.encoder.blocks.{STAGE}.';weights={}
  for shard in sorted({v for k,v in idx.items() if k.startswith(prefix)}):
   with safe_open('/model/'+shard,framework='pt',device='cpu') as f:
    for k,v in idx.items():
     if k.startswith(prefix) and v==shard:weights[k[len(prefix):]]=f.get_tensor(k).float()
  self.norm0=LayerNormSplit(1152,eps=1e-5);self.norm1=LayerNormSplit(1152,eps=1e-5)
  for n in ['norm0','norm1']:
   getattr(self,n).weight.data.copy_(weights[n+'.weight']);getattr(self,n).bias.data.copy_(weights[n+'.bias'])
  for dest,orig in [('wqkv','wqkv'),('wo','wo'),('fc0','mlp.fc0'),('fc1','mlp.fc1')]:
   w=weights[orig+'.weight'];m=(FakeQuantLinear if A.wbits==8 else W16Linear)(w.shape[1],w.shape[0],bias=True,quant_bits=16,w_bits=8);m.weight.data.copy_(w);m.bias.data.copy_(weights[orig+'.bias']);setattr(self,dest,m)
  self.weight_hashes={k:hashlib.sha256(x.numpy().tobytes()).hexdigest() for k,x in weights.items()}
  self.qk=FakeQuantMatmul(QK[0],QK[1],16);self.sv=FakeQuantMatmul(SV[0],SV[1],16);self.softmax=FakeQuantSoftmax(16);self.add0=FakeQuantAdd(16);self.add1=FakeQuantAdd(16);self.scale=FakeQuantMul(quantized=True);self.gelu_out=ConstFakeQuant(16)
  pos=torch.arange(512).float();freq=1/(10000**(torch.arange(0,72,4).float()/72));a=torch.stack([torch.outer(pos%32,freq),torch.outer(pos//32,freq)],-1).reshape(512,36);self.cos=a.cos()[:,None,:];self.sin=a.sin()[:,None,:];self.set_children_parent()
 def evaluate(self,x,observe):
  x=x.reshape(1,512,1152)
  def norm(m,v):return m(v) if observe else F.layer_norm(v,[1152],m.weight,m.bias,1e-5)
  def linear(m,v):return m(v) if observe else F.linear(v,m.weight,m.bias)
  q,k,v=linear(self.wqkv,norm(self.norm0,x)).reshape(512,3,16,72).unbind(1)
  def rope(t):
   z=t.reshape(512,16,36,2);a,b=z[...,0],z[...,1];return torch.stack([a*self.cos-b*self.sin,b*self.cos+a*self.sin],-1).flatten(-2)
  q,k=[rope(t).permute(1,0,2)[None] for t in [q,k]];v=v.permute(1,0,2)[None]
  score=self.qk(q,k.transpose(-2,-1)) if observe else q@k.transpose(-2,-1)
  score=self.scale(score,1/math.sqrt(72)) if observe else score/math.sqrt(72)
  prob=self.softmax(score) if observe else torch.softmax(score,-1);att=self.sv(prob,v) if observe else prob@v
  att=att.permute(0,2,1,3).reshape(1,512,1152);y=linear(self.wo,att);res=self.add0(x,y) if observe else x+y
  h=F.gelu(linear(self.fc0,norm(self.norm1,res)),approximate='tanh');h=self.gelu_out(h) if observe else h
  y=linear(self.fc1,h);out=self.add1(res,y) if observe else res+y;return out.reshape(512,1152)
 def forward(self,x):return self.evaluate(x,True)
 def build(self,x):
  x=leap.reshape(x,[1,512,1152]);qkv=leap.reshape(self.wqkv(self.norm0(x)),[512,3,16,72]);q,k,v=[leap.reshape(leap.slice(qkv,[0,i,0,0],[512,i+1,16,72],[1,1,1,1]),[512,16,72]) for i in range(3)]
  def rope(t):
   z=leap.reshape(t,[512,16,36,2]);a=leap.reshape(leap.slice(z,[0,0,0,0],[512,16,36,1],[1,1,1,1]),[512,16,36]);b=leap.reshape(leap.slice(z,[0,0,0,1],[512,16,36,2],[1,1,1,1]),[512,16,36])
   real=leap.add(leap.mul(a,self.cos),leap.mul(leap.mul(b,self.sin),-1.));imag=leap.add(leap.mul(b,self.cos),leap.mul(a,self.sin));return leap.reshape(leap.concat([leap.reshape(real,[512,16,36,1]),leap.reshape(imag,[512,16,36,1])],-1),[512,16,72])
  q,k=[leap.reshape(leap.transpose(rope(t),[1,0,2]),[1,16,512,72]) for t in [q,k]];v=leap.reshape(leap.transpose(v,[1,0,2]),[1,16,512,72]);score=self.scale(self.qk(q,leap.transpose(k,[0,1,3,2])),1/math.sqrt(72));prob=self.softmax(score);att=self.sv(prob,v);att=leap.reshape(leap.transpose(att,[0,2,1,3]),[1,512,1152]);res=self.add0(x,self.wo(att));h=self.fc0(self.norm1(res))
  # Preserve native GELU(tanh);official FakeQuantGELU's default erf is different.
  h=self.gelu_out(leap.gelu(h,approximate='tanh'))
  return leap.reshape(self.add1(res,self.fc1(h)),[512,1152])

assert os.getpgrp()==os.getpid();torch.set_num_threads(2);out=Path(f'/opt/locate-vision-recipe-probe-v296/block{STAGE}-qk{A.qk}-sv{A.sv}'+('' if A.wbits==8 else f'-w{A.wbits}'));assert not out.exists();out.mkdir(parents=True)
r=dict(status='calibrating',started=time.time(),pid=os.getpid(),source_sha256=sha(__file__),scope=__doc__,stage=STAGE,vision_blocks=1,full_vision_blocks=27,weights_bits=8,activation_recipe=f'Official Q8Linear;QK{A.qk};SV{A.sv};16bit outputs',native_geometry='512patches16x32,16heads72dims,interleaved2DRoPE,LayerNormeps1e-5,GELUtanh',high_precision_qpp=True,norm_implementation='official LayerNormSplit',activation_implementation='official leap.gelu approximate=tanh',official_quantized_linear_unmodified=True,calibration=[],regression=[],whole_model_verified=False,release_approved=False,maximum_compile_seconds=None)
def persist():
 p=out/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+chr(10));p.replace(out/'status.json')
persist()
try:
 src=BASE/'leap-source-overlay/leap_llm';pins={'nn/modules/linear.py':'7c68836051e9b065b3e43bf291a13db0261d094d7faa42b7ceccbf3cd6395054','nn/modules/matmul.py':'24b93ff5c76be0cb75725745765b44ebf563753c369ea056a98061b68d55d7a0','nn/modules/layer_norm.py':'069770d7eb998fe838cf532264f07e3839c84b06af3e8fd2965612b4637cbb30'}
 for n,h in pins.items():assert sha(src/n)==h
 r['official_sources']=pins;m=MoonBlock();m.eval();m.compile_mode(False);r['original_parameter_hashes']=m.weight_hashes
 data=Path('/work/vision-native-bf16-stage-data-v1');source=data/f'block-{STAGE:02d}';target=data/(f'block-{STAGE+1:02d}' if STAGE<26 else 'tail');calibration=sorted((source/'calibration').glob('*.npy'));assert len(calibration)==64
 used=set();hooks=[x.register_forward_hook(lambda mod,args,out,n=n:used.add(n)) for n,x in m.named_modules() if isinstance(x,ConstFakeQuant) and x.quantized]
 with torch.inference_mode():
  for p in calibration:
   m(torch.from_numpy(np.load(p,allow_pickle=False)));r['calibration'].append(dict(name=p.name,sha256=sha(p)))
 for h in hooks:h.remove()
 ranges={n:dict(absmax=float(x.absmax),bits=x.bits) for n,x in m.named_modules() if isinstance(x,ConstFakeQuant) and n in used};assert ranges and all(np.isfinite(x['absmax']) and x['absmax']>0 for x in ranges.values());r['ranges']=ranges
 selected=[(split,p) for split in ['pilot','validation'] for p in sorted((source/split).glob('*.npy'))];assert len(selected)==18;assert set(p.name for p in calibration).isdisjoint(p.name for _,p in selected)
 with torch.inference_mode():
  for split,p in selected:
   x=np.load(p,allow_pickle=False);gold=np.load(target/split/p.name,allow_pickle=False);actual=m.evaluate(torch.from_numpy(x),False).numpy();entry=dict(image=p.stem,split=split,input_sha256=sha(p),native_sha256=sha(target/split/p.name),float_reference_vs_native=metric(actual,gold));r['regression'].append(entry)
 assert max(x['float_reference_vs_native']['rel_l2'] for x in r['regression'])<.02,'Reject structural/F32 reference mismatch before quantization'
 r['status']='exporting_official_module';persist();m.compile_mode(True);bc=m.export_module([leap.TensorType([512,1152],leap.float32)],name=f'locate_official_moonvit_block{STAGE}_w8',save_path=str(out/'export.bc'),high_precision_qpp=True)
 r['status']='converting_official_module';persist();lowered=m.convert_mlir(bc,save_path=str(out/'converted.bc'),enable_vpu=True,march='nash-m');f=lowered.functions[0];r['converted_bc_sha256']=sha(out/'converted.bc');r['status']='compiler_reference';persist();fixtures=out/'fixtures';fixtures.mkdir()
 for i,(split,p) in enumerate(selected):
  x=np.load(p,allow_pickle=False);gold=np.load(target/split/p.name,allow_pickle=False);actual=np.asarray(f(x)[0]).copy();assert np.isfinite(actual).all();r['regression'][i]['compiler_vs_native']=metric(actual,gold)
  if i<4:
   q=fixtures/f'case-{i:02d}';q.mkdir();np.save(q/'input-00.npy',x);np.save(q/'compiler-00.npy',actual);np.save(q/'native-hidden.npy',gold)
  persist()
 ports=dict(inputs=[dict(name=x.name,shape=list(x.type.shape)) for x in f.inputs],outputs=[dict(name=x.name,shape=list(x.type.shape)) for x in f.outputs]);(out/'ports.json').write_text(json.dumps(ports,indent=2)+chr(10));r['status']='compiling_hbo';persist();start=time.monotonic();hbo=m.compile_hbo(lowered,save_path=str(out/'model.hbo'),march='nash-m',opt=0,jobs=1);m.link_models([hbo],str(out/'model.hbm'))
 tool=BASE/'sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas';d=json.loads(subprocess.check_output([str(tool),'--json',str(out/'model.hbm')],text=True));devices=[n['device'] for g in d['graphs'] for n in g['nodes']];assert devices and all(x=='DEVICE_CATEGORY_BPU' for x in devices),'Reject neural CPU fallback';(out/'disas.json').write_text(json.dumps(d,indent=2)+chr(10));r.update(status='compiled_bpu_only',compile_seconds=time.monotonic()-start,bpu_only=True,devices=devices,hbm_sha256=sha(out/'model.hbm'),hbm_bytes=(out/'model.hbm').stat().st_size,compiler_memory=d['graphs'][0]['modelMemoryRequirement'],actual_board_verified=False)
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:r['finished']=time.time();persist()
print(json.dumps({k:r.get(k) for k in ['status','hbm_bytes','hbm_sha256','regression','error']}))
