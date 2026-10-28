"""AINVR SigLIP vision tower (HF SiglipModel weights): export -> PTQ (field images) -> placement audit -> HBM.

Offline compile candidate. Input float32 NCHW (1,3,S,S) normalized with mean=std=0.5 (SigLIP/SigLIP2 processor);
output pooled embedding (1,D) (L2-normalize on host). Calibration/eval images are archive frames and crops.
"""
import argparse, hashlib, json, logging, time
from pathlib import Path
import numpy as np
import torch
import onnx

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--model-dir', type=Path, required=True)
p.add_argument('--calibration', type=Path, required=True)
p.add_argument('--eval', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--size', type=int, default=256)
p.add_argument('--precision', choices=['int8', 'int16'], default='int16')
p.add_argument('--opt', type=int, choices=[0, 2], default=2)
p.add_argument('--jobs', type=int, default=4)
p.add_argument('--name', default='siglip_vision')
p.add_argument('--stop-after-bc', action='store_true')
p.add_argument('--adaptive-ln', action='store_true')
p.add_argument('--safe-gelu', action='store_true')
p.add_argument('--softmax-clamp', type=float, default=None)
a = p.parse_args()
a.output.mkdir(exist_ok=False)
logging.basicConfig(level=logging.INFO)
S = a.size
digest = lambda q: hashlib.sha256(q.read_bytes()).hexdigest()
r = {'state': 'exporting', 'started_unix': time.time(), 'target': 'nash-m', 'precision': a.precision, 'opt': a.opt,
     'weights_sha256': digest(a.model_dir / 'model.safetensors'), 'production_approved': False, 'accuracy_verified': False}


def save():
    (a.output / 'status.json').write_text(json.dumps(r, indent=2))


def load_images(d, limit=None):
    import cv2
    out = []
    for f in sorted(d.glob('*.jpg'))[:limit]:
        im = cv2.imread(str(f))
        if im is None:
            continue
        im = cv2.cvtColor(cv2.resize(im, (S, S), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        out.append(np.ascontiguousarray(((im.astype('f4') / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)[None]))
    return out


class Wrap(torch.nn.Module):
    def __init__(self, vm):
        super().__init__()
        self.vm = vm

    def forward(self, x):
        return self.vm(pixel_values=x).pooler_output


class VisionTower(torch.nn.Module):
    """SigLIP/SigLIP2 fixed-resolution vision encoder with MAP head, rewritten for fixed-point BPU (see
    siglip_text_prepare.AdaptiveLN / gelu_tanh_safe). Loaded directly from the HF safetensors."""

    def __init__(self, sd, adaptive_ln, safe_gelu, prefix='vision_model.'):
        super().__init__()
        import torch.nn as nn
        import siglip_text_prepare as P
        w = sd[prefix + 'embeddings.patch_embedding.weight']
        d, ps = w.shape[0], w.shape[-1]
        heads = {768: 12, 1152: 16, 1024: 16}[d]
        ff = sd[prefix + 'encoder.layers.0.mlp.fc1.weight'].shape[0]
        n_layers = 1 + max(int(k.split('.')[3]) for k in sd if k.startswith(prefix + 'encoder.layers.'))
        npos = sd[prefix + 'embeddings.position_embedding.weight'].shape[0]
        self.patch = nn.Conv2d(3, d, ps, ps)
        self.pos = nn.Parameter(torch.zeros(1, npos, d))
        self.layers = nn.ModuleList(P.Layer(d, heads, ff, adaptive_ln, safe_gelu) for _ in range(n_layers))
        self.post = P.make_ln(d, adaptive_ln)
        self.probe = nn.Parameter(torch.zeros(1, 1, d))
        self.in_q, self.in_k, self.in_v = nn.Linear(d, d), nn.Linear(d, d), nn.Linear(d, d)
        self.out = nn.Linear(d, d)
        self.hln = P.make_ln(d, adaptive_ln)
        self.fc1, self.fc2 = nn.Linear(d, ff), nn.Linear(ff, d)
        self.h, self.dh, self.safe_gelu = heads, d // heads, safe_gelu
        self.P = P
        cp = {'patch.weight': w, 'patch.bias': sd[prefix + 'embeddings.patch_embedding.bias'],
              'pos': sd[prefix + 'embeddings.position_embedding.weight'][None], 'probe': sd[prefix + 'head.probe'],
              'post.weight': sd[prefix + 'post_layernorm.weight'], 'post.bias': sd[prefix + 'post_layernorm.bias'],
              'hln.weight': sd[prefix + 'head.layernorm.weight'], 'hln.bias': sd[prefix + 'head.layernorm.bias'],
              'out.weight': sd[prefix + 'head.attention.out_proj.weight'], 'out.bias': sd[prefix + 'head.attention.out_proj.bias'],
              'fc1.weight': sd[prefix + 'head.mlp.fc1.weight'], 'fc1.bias': sd[prefix + 'head.mlp.fc1.bias'],
              'fc2.weight': sd[prefix + 'head.mlp.fc2.weight'], 'fc2.bias': sd[prefix + 'head.mlp.fc2.bias']}
        ipw, ipb = sd[prefix + 'head.attention.in_proj_weight'], sd[prefix + 'head.attention.in_proj_bias']
        for i, nm in enumerate(('in_q', 'in_k', 'in_v')):
            cp[nm + '.weight'], cp[nm + '.bias'] = ipw[i * d:(i + 1) * d], ipb[i * d:(i + 1) * d]
        for i, L in enumerate(self.layers):
            pp = f'{prefix}encoder.layers.{i}.'
            for name, mod in (('layer_norm1', L.ln1), ('layer_norm2', L.ln2), ('self_attn.q_proj', L.q),
                              ('self_attn.k_proj', L.k), ('self_attn.v_proj', L.v), ('self_attn.out_proj', L.o),
                              ('mlp.fc1', L.fc1), ('mlp.fc2', L.fc2)):
                cp[f'layers.{i}.' + {'layer_norm1': 'ln1', 'layer_norm2': 'ln2', 'self_attn.q_proj': 'q',
                                     'self_attn.k_proj': 'k', 'self_attn.v_proj': 'v', 'self_attn.out_proj': 'o',
                                     'mlp.fc1': 'fc1', 'mlp.fc2': 'fc2'}[name] + '.weight'] = sd[pp + name + '.weight']
                cp[f'layers.{i}.' + {'layer_norm1': 'ln1', 'layer_norm2': 'ln2', 'self_attn.q_proj': 'q',
                                     'self_attn.k_proj': 'k', 'self_attn.v_proj': 'v', 'self_attn.out_proj': 'o',
                                     'mlp.fc1': 'fc1', 'mlp.fc2': 'fc2'}[name] + '.bias'] = sd[pp + name + '.bias']
        own = dict(self.named_parameters())
        assert set(own) == set(cp), (set(own) ^ set(cp))
        with torch.no_grad():
            for k, v in cp.items():
                assert own[k].shape == v.shape, (k, own[k].shape, v.shape)
                own[k].copy_(v)

    def forward(self, x):
        t = self.patch(x).flatten(2).transpose(1, 2) + self.pos
        for L in self.layers:
            t = L(t)
        t = self.post(t)
        b, n, d = t.shape
        q = self.in_q(self.probe).view(1, 1, self.h, self.dh).transpose(1, 2)
        k = self.in_k(t).view(b, n, self.h, self.dh).transpose(1, 2)
        v = self.in_v(t).view(b, n, self.h, self.dh).transpose(1, 2)
        a = self.P.attn_softmax((q @ k.transpose(-1, -2)) * (self.dh ** -0.5))
        h = self.out((a @ v).transpose(1, 2).reshape(b, 1, d))
        r = h
        h = self.fc1(self.hln(h))
        h = self.fc2(self.P.gelu_tanh_safe(h) if self.safe_gelu else torch.nn.functional.gelu(h, approximate='tanh'))
        return (r + h)[:, 0]


save()
try:
    from transformers import SiglipModel
    full = SiglipModel.from_pretrained(str(a.model_dir), torch_dtype=torch.float32).eval()
    ref_model = Wrap(full.vision_model).eval()
    if a.adaptive_ln or a.safe_gelu:
        from safetensors.torch import load_file
        import siglip_text_prepare as _P
        _P.SOFTMAX_CLAMP = a.softmax_clamp
        m = VisionTower(load_file(str(a.model_dir / 'model.safetensors')), a.adaptive_ln, a.safe_gelu).eval()
    else:
        m = ref_model
    calib, held = load_images(a.calibration), load_images(a.eval)
    assert len(calib) >= 200 and len(held) >= 100, (len(calib), len(held))
    onnx_path = a.output / f'{a.name}.onnx'
    torch.onnx.export(m, (torch.from_numpy(calib[0]),), str(onnx_path), input_names=['pixel_values'],
                      output_names=['image_embedding'], opset_version=17, do_constant_folding=True, dynamo=False)
    import onnxruntime as ort
    sess = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
    err = 0.0
    with torch.no_grad():
        refs = np.concatenate([ref_model(torch.from_numpy(x)).numpy() for x in held])
        ref = np.concatenate([m(torch.from_numpy(x)).numpy() for x in held])
        cs = (refs * ref).sum(1) / np.linalg.norm(refs, axis=1) / np.linalg.norm(ref, axis=1)
        assert cs.min() > 0.9999, cs.min()
        r['rewrite_cos_vs_hf_min'] = float(cs.min())
        for i, x in enumerate(held[:8]):
            err = max(err, float(np.abs(sess.run(None, {'pixel_values': x})[0] - ref[i:i + 1]).max()))
    assert err < 1e-3, err
    np.save(a.output / 'eval_float_features.npy', ref)
    np.save(a.output / 'eval_inputs.npy', np.concatenate(held))
    g = onnx.load(str(onnx_path))
    r.update(state='quantizing', onnx_max_abs_err=err, onnx_ops=sorted({n.op_type for n in g.graph.node}),
             calibration_samples=len(calib), eval_samples=len(held), onnx_sha256=digest(onnx_path)); save()

    from hmct.ir import OnnxModel
    from hmct.builder.model_builder import ModelBuilder
    from hbdk4.compiler.onnx import export
    from hbdk4.compiler import convert, compile, save as save_bc
    qc = {'model_config': {'all_node_type': a.precision, 'activation': {'calibration_type': 'max'}}}
    b = ModelBuilder(OnnxModel(g), 'nash-m', save_model=True, verbose=False, name_prefix=str(a.output / 'vis'),
                     cali_dict={'calibration_data': {'pixel_values': calib}}, user_quant_config=qc)
    ptq = b.build()
    assert ptq is not None
    r['state'] = 'converting'; save()
    mod = export(proto=ptq, name=a.name)
    mod = convert(mod, march='nash-m', advice=True, advice_path=str(a.output) + '/')
    ops = json.loads((a.output / f'{a.name}_advice.json').read_text())
    cpu = [x for x in ops if x['backend'] == 'external_cpu']
    r.update(external_cpu_ops=cpu, op_count=len(ops)); save()
    assert ops and not cpu, 'neural CPU fallback: ' + json.dumps(cpu)[:600]
    save_bc(mod, str(a.output / 'quantized.bc'))
    r.update(state='bc_saved', bc_sha256=digest(a.output / 'quantized.bc')); save()
    if not a.stop_after_bc:
        r['state'] = 'compiling'; save()
        compile(mod, str(a.output / f'{a.name}.hbm'), march='nash-m', opt=a.opt, jobs=a.jobs, debug=False, progress_bar=True)
        r.update(state='compiled_needs_validation', hbm_sha256=digest(a.output / f'{a.name}.hbm'))
except BaseException as e:
    r.update(state='failed', error=repr(e))
    raise
finally:
    r['finished_unix'] = time.time(); save()
print(json.dumps(r, indent=2), flush=True)
