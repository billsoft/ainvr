"""Qwen3-VL ViT (24 blocks, 1024 hidden, 16 heads, full attention) on official leap_llm modules for fixed 448x896
(grid 28x56 -> 1568 patches -> 392 merged tokens). Position embedding and 2D rotary are graph constants.
Groups: blocks [a,b) with optional patch-embed head, deepstack mergers after blocks 5/11/17, final merger at the end."""
import os, sys, math, json
from pathlib import Path
from types import SimpleNamespace
for k in ['DEV_B30_TRITON_VPU', 'DEV_B30_ENABLE_VPU_EXTRA_OP', 'DEV_B30_ENABLE_VPU_TRIAL_OP']:
    os.environ[k] = '1'
SDK = Path('/opt/qsdk')
sys.path.insert(0, str(SDK / 'sdk448-isolated/python')); sys.path.insert(0, str(SDK / 'leap-source-overlay'))
import numpy as np
import torch
from safetensors import safe_open
from hbdk4.compiler import leap
from leap_llm.nn.utils import Model, Module
from leap_llm.nn.modules import FakeQuantLinear, FakeQuantAdd, LayerNormSplit, ConstFakeQuant
from leap_llm.models.qwen2_5_omni.blocks.attention import Qwen2_5OmniVisionAttention

MODEL = Path('/models/Qwen3-VL-4B-Instruct')
GH, GW = 28, 56
N = GH * GW            # 1568 patches
M = N // 4             # 392 merged tokens
D, HEADS, FF, OUT = 1024, 16, 4096, 2560
PATCH_IN = 3 * 2 * 16 * 16
DEEPSTACK = [5, 11, 17]


def vstate(prefix):
    idx = json.loads((MODEL / 'model.safetensors.index.json').read_text())['weight_map']
    st = {}
    for shard in sorted({v for k, v in idx.items() if k.startswith(prefix)}):
        with safe_open(str(MODEL / shard), framework='pt', device='cpu') as f:
            for k, v in idx.items():
                if k.startswith(prefix) and v == shard:
                    st[k[len(prefix):]] = f.get_tensor(k).float()
    return st


def constants():
    """pos_embeds [N,D] and rotary cos/sin [N,1,64] exactly as HF Qwen3VLVisionModel computes them for grid (1,28,56)."""
    sys.path.insert(0, '/opt/qsdk/locate-reference-deps')
    from transformers.models.qwen3_vl.modeling_qwen3_vl import Qwen3VLVisionModel
    from transformers import AutoConfig
    cfg = AutoConfig.from_pretrained(str(MODEL)).vision_config
    with torch.device('meta'):
        vm = Qwen3VLVisionModel._from_config(cfg)
    vm.pos_embed = torch.nn.Embedding.from_pretrained(vstate('model.visual.pos_embed.')['weight'])
    vm.rotary_pos_emb = type(vm.rotary_pos_emb)(cfg.hidden_size // cfg.num_heads // 2)
    grid = torch.tensor([[1, GH, GW]])
    with torch.no_grad():
        pos = vm.fast_pos_embed_interpolate(grid).float()
        rot = vm.rot_pos_emb(grid).float()
    emb = torch.cat([rot, rot], -1)
    return pos, emb.cos()[:, None, :], emb.sin()[:, None, :]


GELU_MODE = os.environ.get('QGELU', 'split')
GELU_KNEE = 8.0


class FixedFakeQuant(ConstFakeQuant):
    """16-bit fake-quant with a fixed range: saturates to [-a, a] (acts as a BPU-side clip, keeps the tensor quantized)."""

    def __init__(self, absmax, bits=16):
        super().__init__(bits); self.absmax = torch.tensor(float(absmax))

    def forward(self, x):
        return x.clamp(-float(self.absmax), float(self.absmax))


class GELU(Module):
    """mode 'lut': single leap.gelu (its LUT breaks for |x| in the hundreds, seen at block 23: 87x error).
    mode 'split': gelu(sat8(x)) + relu(x - 8), all in the 16-bit quantized domain so every op stays on the BPU
    (a float leap.clip/gelu lowered to CPU natives). Exact identity for gelu outside [-8, 8] (|gelu(-8)| < 1e-14)."""

    def __init__(self, approximate, mode=None):
        super().__init__(); self.approximate = approximate; self.mode = mode or GELU_MODE
        self.out_quant = ConstFakeQuant(16)
        if self.mode == 'split':
            self.sat = FixedFakeQuant(GELU_KNEE); self.core_q = ConstFakeQuant(16)
            self.shift = FakeQuantAdd(quantized=True); self.relu_q = ConstFakeQuant(16); self.join = FakeQuantAdd(quantized=True)

    def build(self, x):
        if self.mode == 'lut':
            return self.out_quant(leap.gelu(x, approximate=self.approximate))
        core = self.core_q(leap.gelu(self.sat(x), approximate=self.approximate))
        tail = self.relu_q(leap.relu(self.shift(x, -GELU_KNEE)))
        return self.out_quant(self.join(core, tail))

    def forward(self, x):
        if self.mode == 'lut':
            return self.out_quant(torch.nn.functional.gelu(x, approximate=self.approximate))
        core = self.core_q(torch.nn.functional.gelu(self.sat(x), approximate=self.approximate))
        tail = self.relu_q(torch.relu(self.shift(x, -GELU_KNEE)))
        return self.out_quant(self.join(core, tail))


class Block(Module):
    def __init__(self):
        super().__init__()
        self.norm1 = LayerNormSplit(D, eps=1e-6); self.norm2 = LayerNormSplit(D, eps=1e-6)
        self.attn = Qwen2_5OmniVisionAttention(D, num_heads=HEADS)
        self.fc1 = FakeQuantLinear(D, FF); self.act = GELU('tanh'); self.fc2 = FakeQuantLinear(FF, D)
        self.add1 = FakeQuantAdd(quantized=False); self.add2 = FakeQuantAdd(quantized=False)

    def load(self, st):
        q, k, v = st['attn.qkv.weight'].split(D, 0); qb, kb, vb = st['attn.qkv.bias'].split(D, 0)
        sd = {'norm1.weight': st['norm1.weight'], 'norm1.bias': st['norm1.bias'], 'norm2.weight': st['norm2.weight'], 'norm2.bias': st['norm2.bias'],
              'attn.q.weight': q, 'attn.q.bias': qb, 'attn.k.weight': k, 'attn.k.bias': kb, 'attn.v.weight': v, 'attn.v.bias': vb,
              'attn.proj.weight': st['attn.proj.weight'], 'attn.proj.bias': st['attn.proj.bias'],
              'fc1.weight': st['mlp.linear_fc1.weight'], 'fc1.bias': st['mlp.linear_fc1.bias'],
              'fc2.weight': st['mlp.linear_fc2.weight'], 'fc2.bias': st['mlp.linear_fc2.bias']}
        self.load_state_dict(sd, strict=True)

    def _res(self, a, b, add, building):
        if building:
            return leap.cast_type(add(leap.cast_type(a, output_type=leap.float16), leap.cast_type(b, output_type=leap.float16)), output_type=leap.float32)
        return add(a, b)

    def build(self, h, cos, sin):
        h = self._res(h, self.attn(self.norm1(h), window_attention=False, rotary_pos_emb_cos=cos, rotary_pos_emb_sin=sin), self.add1, True)
        return self._res(h, self.fc2(self.act(self.fc1(self.norm2(h)))), self.add2, True)

    def forward(self, h, cos, sin):
        h = self._res(h, self.attn(self.norm1(h), window_attention=False, rotary_pos_emb_cos=cos, rotary_pos_emb_sin=sin), self.add1, False)
        return self._res(h, self.fc2(self.act(self.fc1(self.norm2(h)))), self.add2, False)


class Merger(Module):
    def __init__(self, postshuffle):
        super().__init__(); self.post = postshuffle
        self.norm = LayerNormSplit(4 * D if postshuffle else D, eps=1e-6)
        self.fc1 = FakeQuantLinear(4 * D, 4 * D); self.act = GELU('none'); self.fc2 = FakeQuantLinear(4 * D, OUT)

    def load(self, st):
        self.load_state_dict({'norm.weight': st['norm.weight'], 'norm.bias': st['norm.bias'], 'fc1.weight': st['linear_fc1.weight'],
                              'fc1.bias': st['linear_fc1.bias'], 'fc2.weight': st['linear_fc2.weight'], 'fc2.bias': st['linear_fc2.bias']}, strict=True)

    def build(self, h):
        h = self.norm(leap.reshape(h, [M, 4 * D])) if self.post else leap.reshape(self.norm(h), [M, 4 * D])
        return self.fc2(self.act(self.fc1(h)))

    def forward(self, h):
        h = self.norm(h.reshape(M, 4 * D)) if self.post else self.norm(h).reshape(M, 4 * D)
        return self.fc2(self.act(self.fc1(h)))


class VisionGroup(Model):
    """Inputs: patches [N,1536] if first==0 else hidden [N,D]. Outputs: hidden [N,D] (or merged [M,OUT] for the last group)
    plus deepstack features [M,OUT] for each deepstack index inside the group."""

    def __init__(self, first, last, rope_inputs=False):
        super().__init__()
        self.first, self.last, self.rope_inputs = first, last, rope_inputs
        pos, cos, sin = constants(); self.register_buffer('pos', pos); self.register_buffer('cos', cos); self.register_buffer('sin', sin)
        if first == 0:
            st = vstate('model.visual.patch_embed.proj.')
            self.patch = FakeQuantLinear(PATCH_IN, D); self.patch.load_state_dict({'weight': st['weight'].reshape(D, -1), 'bias': st['bias']})
            self.add_pos = FakeQuantAdd(quantized=False)
        self.blocks = torch.nn.ModuleList()
        for i in range(first, last):
            b = Block(); b.load(vstate(f'model.visual.blocks.{i}.')); self.blocks.append(b)
        self.ds_idx = [i for i in DEEPSTACK if first <= i < last]
        self.ds = torch.nn.ModuleList()
        for i in self.ds_idx:
            m = Merger(True); m.load(vstate(f'model.visual.deepstack_merger_list.{DEEPSTACK.index(i)}.')); self.ds.append(m)
        self.final = None
        if last == 24:
            self.final = Merger(False); self.final.load(vstate('model.visual.merger.'))
        self.set_children_parent()

    def _run(self, x, building, cos=None, sin=None):
        if not self.rope_inputs:
            cos, sin = self.cos, self.sin
        elif building:
            cos, sin = leap.reshape(cos, [N, 1, 64]), leap.reshape(sin, [N, 1, 64])
        else:
            cos, sin = cos.reshape(N, 1, 64), sin.reshape(N, 1, 64)
        if self.first == 0:
            x = self.patch(x)
            x = leap.cast_type(self.add_pos(leap.cast_type(x, output_type=leap.float16), self.pos.half()), output_type=leap.float32) if building else self.add_pos(x, self.pos)
        feats = []
        for i, b in zip(range(self.first, self.last), self.blocks):
            x = b(x, cos, sin)
            if i in self.ds_idx:
                feats.append(self.ds[self.ds_idx.index(i)](x))
        if self.final is not None:
            x = self.final(x)
        return x, *feats

    def forward(self, x, cos=None, sin=None):
        return self._run(x, False, cos, sin)

    def build(self, x, cos=None, sin=None):
        return self._run(x, True, cos, sin)

    def input_types(self):
        t = [leap.TensorType([N, PATCH_IN if self.first == 0 else D], leap.float32)]
        return t + ([leap.TensorType([N, 64], leap.float32)] * 2 if self.rope_inputs else [])

    def rope_arrays(self):
        return [self.cos[:, 0].cpu().numpy(), self.sin[:, 0].cpu().numpy()] if self.rope_inputs else []
