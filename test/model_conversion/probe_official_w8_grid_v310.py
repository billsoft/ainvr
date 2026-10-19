"""v310:recover the compiler-reference effective weights of an official FakeQuantLinear(w_bits=8) with one-hot inputs.

x=c*e_j gives output column = W_eff[:,j]*c (+16-bit output rounding). Compare W_eff with candidate grids:
the per-row absmax/127 grid of the input weights, and the raw float weights. Zero board calls.
"""
from pathlib import Path
import os,sys,json
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
BASE=Path('/opt/locate-oellm-research-v1');sys.path.insert(0,str(BASE/'sdk448-isolated/python'));sys.path.insert(0,str(BASE/'leap-source-overlay'))
import numpy as np,torch
from hbdk4.compiler import leap
from leap_llm.nn.utils import Model
from leap_llm.nn.modules.linear import FakeQuantLinear
torch.manual_seed(0);rows,cols=16,64;C=1.0
codes=torch.randint(-120,121,(rows,cols)).float();codes[:,0]=127;scale=torch.rand(rows,1)*0.02+0.001;W=codes*scale
class M(Model):
 def __init__(s):
  super().__init__();s.l=FakeQuantLinear(cols,rows,bias=False,quant_bits=16,w_bits=8);s.l.weight.data.copy_(W);s.l.absmax_weight=(127*scale[:,0]).clone();s.set_children_parent()
 def forward(s,x):return s.l(x)
 def build(s,x):return s.l(x)
m=M();m.eval();m.compile_mode(False)
with torch.inference_mode():
 for _ in range(4):m(torch.randn(cols,cols)*0.5)
 m(torch.eye(cols)*C)
m.compile_mode(True);bc=m.export_module([leap.TensorType([cols,cols],leap.float32)],name='grid10',save_path='/tmp/grid10.bc',high_precision_qpp=True)
f=m.convert_mlir(bc,save_path='/tmp/grid10_c.bc',enable_vpu=True,march='nash-m').functions[0]
Y=np.asarray(f((np.eye(cols)*C).astype(np.float32))[0]).astype(np.float64)   # [cols(one-hot j), rows]
Weff=(Y/C).T  # [rows,cols]
s=scale.double().numpy();k=Weff/s
res=dict(max_abs_code_deviation_from_integer=float(np.abs(k-np.round(k)).max()),codes_equal=bool(np.array_equal(np.round(k),codes.numpy())),rel_Weff_vs_W=float(np.linalg.norm(Weff-W.double().numpy())/np.linalg.norm(W.double().numpy())),
 sample_row0_codes=[round(float(v),3) for v in k[0,:8]],sample_true=[float(v) for v in codes[0,:8]])
print(json.dumps(res,indent=1))
