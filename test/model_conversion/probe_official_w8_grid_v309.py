"""v309b:discriminate whether the official W8 path re-grids weights onto the per-row absmax/127 grid.

Same calibration/eval input for both modules. Module A uses on-grid weights codes*scale; module B adds a
deterministic perturbation of +-0.3 step (absmax rows untouched). If the compiler re-grids with the same
per-row absmax/127 grid, A and B round to identical codes and their compiler outputs are bit-identical.
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
codes=torch.randint(-120,121,(rows,cols)).float();codes[:,0]=127;scale=torch.rand(rows,1)*0.02+0.001;WA=codes*scale
noise=(torch.rand(rows,cols)-.5)*0.6;noise[:,0]=0;WB=(codes+noise)*scale
xs=[torch.randn(8,cols)*0.5 for _ in range(4)];xe=xs[0]
class M(Model):
 def __init__(s,W):
  super().__init__();s.l=FakeQuantLinear(cols,rows,bias=False,quant_bits=16,w_bits=8);s.l.weight.data.copy_(W);s.l.absmax_weight=(127*scale[:,0]).clone();s.set_children_parent()
 def forward(s,x):return s.l(x)
 def build(s,x):return s.l(x)
ys={};amax={}
for tag,W in [('A',WA),('B',WB)]:
 m=M(W);m.eval();m.compile_mode(False)
 with torch.inference_mode():
  for x in xs:m(x)
 if tag=='A':ranges=[q.absmax.clone() if torch.is_tensor(q.absmax) else q.absmax for q in [m.l.x_fake_quant,m.l.out_fake_quant]]
 else:
  for q,v in zip([m.l.x_fake_quant,m.l.out_fake_quant],ranges):q.absmax=v.clone() if torch.is_tensor(v) else v
 amax[tag]=[float(getattr(q,'absmax',float('nan'))) for q in [m.l.x_fake_quant,m.l.out_fake_quant]]
 m.compile_mode(True);bc=m.export_module([leap.TensorType([8,cols],leap.float32)],name='grid9_'+tag,save_path=f'/tmp/grid9_{tag}.bc',high_precision_qpp=True)
 f=m.convert_mlir(bc,save_path=f'/tmp/grid9_{tag}_c.bc',enable_vpu=True,march='nash-m').functions[0];ys[tag]=np.asarray(f(xe.numpy())[0]).copy()
ref=xe.double().numpy()@WA.double().numpy().T
print(json.dumps(dict(bitwise_identical=bool(ys['A'].tobytes()==ys['B'].tobytes()),max_abs_diff=float(np.abs(ys['A']-ys['B']).max()),rel_A_vs_exact=float(np.linalg.norm(ys['A']-ref)/np.linalg.norm(ref)),calibrated_absmax=amax),indent=1))
