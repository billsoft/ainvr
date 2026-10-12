"""AINVR offline two-input YOLOE-26x export experiment, not production inference.

Uses the installed official Ultralytics checkpoint and compares its unchanged
contrastive head with an algebraically equivalent MatMul implementation. Random
normalized prompt vectors test runtime input dependence, not semantic accuracy.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
import numpy as np
import torch
from torch import nn
import torch.nn.functional as F
from ultralytics import YOLOE
import ultralytics

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--weights', type=Path, required=True)
p.add_argument('--expected-sha256', required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--size', type=int, default=640)
p.add_argument('--max-prompts', type=int, default=8)
a = p.parse_args()
assert hashlib.sha256(a.weights.read_bytes()).hexdigest() == a.expected_sha256
assert 1 <= a.max_prompts <= 80 and a.size % 32 == 0
a.output.mkdir(exist_ok=False)
torch.set_num_threads(2)
report = {'state': 'starting', 'started_unix': time.time(),
          'source_sha256': a.expected_sha256, 'ultralytics_version': ultralytics.__version__,
          'torch_version': torch.__version__, 'production_deployed': False,
          'semantic_accuracy_verified': False, 'BPU_verified': False,
          'scope': 'Full YOLOE-26x two-input ONNX and offline FP32 parity only'}
def save():
    (a.output/'status.json').write_text(json.dumps(report, indent=2))
save()

class RuntimePrompts(nn.Module):
    def __init__(self, core, n):
        super().__init__(); self.core = core; self.n = n
    def forward(self, images, prompt_embeddings):
        # vpe here is already the final normalized class embedding, not a raw
        # visual prompt or raw text-encoder output requiring RepRTA.
        result = self.core.predict(images, vpe=prompt_embeddings)
        return result[0][:, :4+self.n, :]

class MatchedHead(nn.Module):
    def __init__(self, original):
        super().__init__(); self.norm=original.norm
        self.logit_scale=original.logit_scale; self.bias=original.bias
    def forward(self, features, prompts):
        features=self.norm(features); prompts=F.normalize(prompts, dim=-1, p=2)
        b, c, h, w=features.shape
        return torch.matmul(prompts, features.reshape(b,c,h*w)).reshape(b,prompts.shape[1],h,w)*self.logit_scale.exp()+self.bias

try:
    core=YOLOE(str(a.weights)).model.eval().float()
    head=core.model[-1]
    assert head.embed==512 and not head.is_fused and not hasattr(core,'pe')
    head.end2end=False; head.nc=a.max_prompts; core.fuse(verbose=False)
    head.export=True; head.format='onnx'; head.dynamic=False
    wrapper=RuntimePrompts(core,a.max_prompts).eval()
    gen=torch.Generator().manual_seed(26)
    image=torch.rand(1,3,a.size,a.size,generator=gen)
    pa=F.normalize(torch.randn(1,a.max_prompts,512,generator=gen),dim=-1)
    pb=F.normalize(torch.randn(1,a.max_prompts,512,generator=gen),dim=-1)
    with torch.no_grad():
        native_a=wrapper(image,pa).cpu().numpy(); native_b=wrapper(image,pb).cpu().numpy()
    head.cv4=nn.ModuleList(MatchedHead(x) for x in head.cv4)
    with torch.no_grad():
        changed_a=wrapper(image,pa).cpu().numpy(); changed_b=wrapper(image,pb).cpu().numpy()
    rewrite_error=max(float(np.max(np.abs(native_a-changed_a))),float(np.max(np.abs(native_b-changed_b))))
    assert np.allclose(native_a,changed_a,rtol=1e-4,atol=1e-3) and np.allclose(native_b,changed_b,rtol=1e-4,atol=1e-3)
    report.update(state='exporting',head_rewrite_max_abs_error=rewrite_error);save()
    model=a.output/'yoloe26x-runtime-8prompts.onnx'
    torch.onnx.export(wrapper,(image,pa),str(model),input_names=['images','prompt_embeddings'],output_names=['boxes_scores'],opset_version=17,do_constant_folding=True,dynamo=False)
    import onnx
    import onnxruntime as ort
    graph=onnx.load(str(model));onnx.checker.check_model(graph)
    shapes={x.name:[d.dim_value for d in x.type.tensor_type.shape.dim] for x in graph.graph.input}
    assert shapes=={'images':[1,3,a.size,a.size],'prompt_embeddings':[1,a.max_prompts,512]}
    opts=ort.SessionOptions();opts.intra_op_num_threads=2;opts.inter_op_num_threads=1
    session=ort.InferenceSession(str(model),opts,providers=['CPUExecutionProvider'])
    actual=[]
    for label,prompt,ref in [('a',pa,native_a),('b',pb,native_b)]:
        got=session.run(None,{'images':image.numpy(),'prompt_embeddings':prompt.numpy()})[0]
        assert got.shape==ref.shape and np.isfinite(got).all()
        assert np.allclose(got,ref,rtol=2e-4,atol=2e-3)
        np.savez_compressed(a.output/(label+'.npz'),output=got,prompts=prompt.numpy(),image=image.numpy())
        actual.append(got)
    delta=float(np.max(np.abs(actual[0][:,4:]-actual[1][:,4:])))
    assert delta>1e-8, 'Prompt values were frozen during export'
    report.update(state='onnx_runtime_input_verified',inputs=shapes,output_shape=list(actual[0].shape),onnx_sha256=hashlib.sha256(model.read_bytes()).hexdigest(),prompt_switch_score_max_delta=delta,offline_reference_max_errors=[float(np.max(np.abs(x-y))) for x,y in zip(actual,[native_a,native_b])],finished_unix=time.time())
except Exception as e:
    report.update(state='failed',error=repr(e),finished_unix=time.time());save();raise
save();print(json.dumps(report,indent=2),flush=True)
