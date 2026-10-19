"""v308:does official FakeQuantLinear(w_bits=8) preserve weights already on the absmax/127 per-row grid?

Builds a tiny official module whose weights are codes*scale (codes in [-127,127], each row hits +-127),
exports/converts it with the same SDK path as the decoder builder and compares the compiler-reference
output with x@W^T computed in float64. Zero board calls.
"""
from pathlib import Path
import os,sys,json
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
BASE=Path('/opt/locate-oellm-research-v1');sys.path.insert(0,str(BASE/'sdk448-isolated/python'));sys.path.insert(0,str(BASE/'leap-source-overlay'))
import numpy as np,torch
from hbdk4.compiler import leap
from leap_llm.nn.utils import Model
from leap_llm.nn.modules.linear import FakeQuantLinear
torch.manual_seed(0);rows,cols=64,256
codes=torch.randint(-127,128,(rows,cols)).float();codes[:,0]=127;codes[1::2,0]=-127;scale=torch.rand(rows,1)*0.02+0.001;W=codes*scale
class M(Model):
 def __init__(s,fix):
  super().__init__();s.l=FakeQuantLinear(cols,rows,bias=False,quant_bits=16,w_bits=8);s.l.weight.data.copy_(W)
  if fix:s.l.absmax_weight=(127*scale[:,0]).clone()
  s.set_children_parent()
 def forward(s,x):return s.l(x)
 def build(s,x):return s.l(x)
out={}
for fix in [False,True]:
 m=M(fix);m.eval();m.compile_mode(False);x=torch.randn(8,cols)*0.5
 with torch.inference_mode():
  for _ in range(4):m(torch.randn(8,cols)*0.5)
 m.compile_mode(True);bc=m.export_module([leap.TensorType([8,cols],leap.float32)],name=f'grid_probe_{int(fix)}',save_path=f'/tmp/grid_probe_{int(fix)}.bc',high_precision_qpp=True)
 f=m.convert_mlir(bc,save_path=f'/tmp/grid_probe_{int(fix)}_conv.bc',enable_vpu=True,march='nash-m').functions[0]
 y=np.asarray(f(x.numpy())[0]).astype(np.float64);ref=x.double().numpy()@W.double().numpy().T
 # also a variant with the weight re-quantized on a 255-level [-128,127] grid to see which one the compiler matches
 s255=(2*W.abs().amax(1,keepdim=True)/255).double().numpy();W255=np.clip(np.round(W.double().numpy()/s255),-128,127)*s255;ref255=x.double().numpy()@W255.T
 xn=x.double().numpy();amax=float(m.l.x_fake_quant.absmax) if getattr(m.l.x_fake_quant,'absmax',None) is not None else float(np.abs(xn).max())
 def qx(bits):
  s=amax/(2**(bits-1)-1);return np.clip(np.round(xn/s),-(2**(bits-1)-1),2**(bits-1)-1)*s
 r16=qx(16)@W.double().numpy().T;r8=qx(8)@W.double().numpy().T
 out[f'absmax_fixed={fix}']=dict(rel_vs_exact_grid=float(np.linalg.norm(y-ref)/np.linalg.norm(ref)),rel_vs_255_grid=float(np.linalg.norm(y-ref255)/np.linalg.norm(ref255)),rel_vs_x16=float(np.linalg.norm(y-r16)/np.linalg.norm(r16)),rel_vs_x8=float(np.linalg.norm(y-r8)/np.linalg.norm(r8)),x_absmax_used=amax,x_fq_bits=getattr(m.l.x_fake_quant,'bits',None),out_fq_bits=getattr(m.l.out_fake_quant,'bits',None))
print(json.dumps(out,indent=1))
