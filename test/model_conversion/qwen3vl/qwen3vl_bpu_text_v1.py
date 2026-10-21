"""Qwen3-VL text decoder on official leap_llm modules: Omni W8/A16 attention + q_norm/k_norm (head-dim RMSNorm before RoPE),
no qkv bias, GQA 32/8, host-side interleaved-MRoPE cos/sin, DeepStack adds after layers 0..2 (group0 only)."""
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
from leap_llm.nn.modules import FakeQuantLinear, FakeQuantAdd, Qwen2RMSNorm, ConstFakeQuant
from leap_llm.models.qwen2_5_omni.blocks.attention import Qwen2_5OmniAttention
from leap_llm.models.qwen2_5_omni.blocks.transformer_block import Qwen2_5OmniDecoderLayer

MODEL = Path('/models/Qwen3-VL-4B-Instruct')
HID, HD, NH, NKV = 2560, 128, 32, 8
MASK_MIN = float(os.environ.get('QMASK', '-96'))   # -512 widened the int16 score range 4x (see debug_text_attn_taps_v1)


def text_config():
    c = json.loads((MODEL / 'config.json').read_text())['text_config']
    assert (c['hidden_size'], c['head_dim'], c['num_attention_heads'], c['num_key_value_heads'], c['num_hidden_layers']) == (HID, HD, NH, NKV, 36)
    assert not c['attention_bias']
    c['rope_scaling'] = c.get('rope_scaling')
    return SimpleNamespace(**c)


def layer_state(index):
    idx = json.loads((MODEL / 'model.safetensors.index.json').read_text())['weight_map']
    prefix = f'model.language_model.layers.{index}.'
    state = {}
    for shard in sorted({v for k, v in idx.items() if k.startswith(prefix)}):
        with safe_open(str(MODEL / shard), framework='pt', device='cpu') as f:
            for k, v in idx.items():
                if k.startswith(prefix) and v == shard:
                    state[k[len(prefix):]] = f.get_tensor(k)
    return state


SOFTMAX_MODE = os.environ.get('QSOFTMAX', 'precise')


class SatFakeQuant(ConstFakeQuant):
    """16-bit fake-quant with fixed range [-a, a]: saturating, keeps the tensor in the quantized (BPU) domain."""

    def __init__(self, absmax):
        super().__init__(16); self.absmax = torch.tensor(float(absmax))

    def forward(self, x):
        return x.clamp(-float(self.absmax), float(self.absmax))


SOFTMAX_FLOOR = 20.0
NORM_MODE = os.environ.get('QSMXNORM', 'rec')


class PreciseSoftmax(Module):
    """softmax decomposed in the 16-bit quantized domain so every op stays on the BPU:
    d = sat20(x - max) ; e = exp(d) ; out = e * reciprocal(sum e).  exp's LUT only sees [-20, 0] (e^-20 = 2e-9).
    The official leap.softmax lowering showed ~2.3% probability error (layer-8 last-token taps); a float version
    (fp32 exp/sub) lowered to CPU natives and is rejected."""

    def __init__(self):
        super().__init__()
        self.sub_q = ConstFakeQuant(16); self.sat = SatFakeQuant(SOFTMAX_FLOOR); self.exp_q = ConstFakeQuant(16)
        self.sum_q = ConstFakeQuant(16); self.rec_q = ConstFakeQuant(16); self.out_quant = ConstFakeQuant(16)

    def build(self, x):
        d = self.sat(self.sub_q(leap.sub(x, leap.reduce_max(x, [-1]))))
        e = self.exp_q(leap.exp(d))
        sm = self.sum_q(leap.reduce_sum(e, [-1]))
        if NORM_MODE == 'div':
            return self.out_quant(leap.div(e, sm))
        return self.out_quant(leap.mul(e, self.rec_q(leap.reciprocal(sm))))

    def forward(self, x):
        d = self.sat(self.sub_q(x - x.amax(-1, keepdim=True)))
        e = self.exp_q(torch.exp(d))
        r = self.rec_q(1.0 / self.sum_q(e.sum(-1, keepdim=True)))
        return self.out_quant(e * r)


class Qwen3Attention(Qwen2_5OmniAttention):
    def __init__(self, config, layer_idx):
        super().__init__(config, layer_idx)
        if SOFTMAX_MODE == 'precise':
            self.softmax = PreciseSoftmax()
        self.q_proj = FakeQuantLinear(HID, NH * HD, bias=False, quant_bits=8)
        self.k_proj = FakeQuantLinear(HID, NKV * HD, bias=False, quant_bits=8)
        self.v_proj = FakeQuantLinear(HID, NKV * HD, bias=False, quant_bits=8)
        self.q_norm = Qwen2RMSNorm(HD, eps=config.rms_norm_eps, preserve_precision=True, fp16_tiny=False)
        self.k_norm = Qwen2RMSNorm(HD, eps=config.rms_norm_eps, preserve_precision=True, fp16_tiny=False)

    def build(self, hidden_states, attention_mask, position_embeddings=None, cache_k=None, cache_v=None):
        bsz, q_len, _ = hidden_states.type.shape
        q = leap.reshape(self.q_proj(hidden_states), [bsz, q_len, NH, HD])
        k = leap.reshape(self.k_proj(hidden_states), [bsz, q_len, NKV, HD])
        v = leap.reshape(self.v_proj(hidden_states), [bsz, q_len, NKV, HD])
        q = leap.transpose(self.q_norm(q), [0, 2, 1, 3])
        k = leap.transpose(self.k_norm(k), [0, 2, 1, 3])
        v = leap.transpose(v, [0, 2, 1, 3])
        cos, sin = position_embeddings
        q, k = self.apply_rotary_pos_emb(q, k, cos, sin)
        _, _, c_len, _ = cache_k.type.shape
        cache_k = leap.concat([leap.slice(cache_k, [0, 0, q_len, 0], [bsz, NKV, c_len, HD], [1, 1, 1, 1]), k], -2)
        cache_v = leap.concat([leap.slice(cache_v, [0, 0, q_len, 0], [bsz, NKV, c_len, HD], [1, 1, 1, 1]), v], -2)
        k = self.key_out_fq(k)
        key_out = k
        kt = leap.transpose(cache_k, [0, 1, 3, 2])
        q = leap.reshape(q, [bsz, NKV, (NH // NKV) * q_len, HD])
        w = leap.reshape(self.qk(q, kt), [bsz, -1, q_len, c_len])
        w = self.mul_attn_weight(w, 1.0 / math.sqrt(HD))
        w = self.add_mask(w, attention_mask)
        w = self.softmax(w)
        w = leap.reshape(w, [NKV, (NH // NKV) * q_len, -1])
        o = leap.reshape(self.sv(w, cache_v), [bsz, -1, q_len, HD])
        o = leap.reshape(leap.transpose(o, [0, 2, 1, 3]), [bsz, q_len, -1])
        return self.o_proj(o), key_out, v

    def forward(self, hidden_states, attention_mask=None, position_embeddings=None, cache_k=None, cache_v=None):
        bsz, q_len, _ = hidden_states.size()
        q = self.q_norm(self.q_proj(hidden_states).view(bsz, q_len, NH, HD)).transpose(1, 2)
        k = self.k_norm(self.k_proj(hidden_states).view(bsz, q_len, NKV, HD)).transpose(1, 2)
        v = self.v_proj(hidden_states).view(bsz, q_len, NKV, HD).transpose(1, 2)
        cos, sin = position_embeddings
        q, k = self.apply_rotary_pos_emb(q, k, cos, sin)
        cache_k = torch.cat([cache_k[..., q_len:, :], k], -2)
        cache_v = torch.cat([cache_v[..., q_len:, :], v], -2)
        k = self.key_out_fq(k)
        key_out = k
        q = q.reshape([bsz, NKV, (NH // NKV) * q_len, HD])
        c_len = attention_mask.shape[-1]
        w = self.qk(q, cache_k.transpose(2, 3)).reshape([bsz, -1, q_len, c_len])
        w = self.mul_attn_weight(w, 1.0 / math.sqrt(HD))
        w = self.add_mask(w, attention_mask)
        w = self.softmax(w)
        w = torch.reshape(w, [NKV, (NH // NKV) * q_len, -1])
        o = torch.reshape(self.sv(w, cache_v), [bsz, -1, q_len, HD]).transpose(1, 2).contiguous().reshape(bsz, q_len, -1)
        return self.o_proj(o), key_out, v


SILU_MODE = os.environ.get('QSILU', 'split')
SILU_KNEE = float(os.environ.get('QSILUKNEE', '8'))   # |silu(x) - clamp model| <= 2.7e-3 beyond +-8


class SplitSwish(Module):
    """silu(x) = silu(sat20(x)) + relu(x - 20): the SiLU LUT only sees [-20, 20] (range is otherwise set by the
    massive-activation token and starves ordinary rows: ~3% act error on the decision row). |silu(+-20) - (20, 0)| < 5e-8."""

    def __init__(self):
        super().__init__()
        self.sat = SatFakeQuant(SILU_KNEE); self.core_q = ConstFakeQuant(16); self.shift = FakeQuantAdd(quantized=True)
        self.relu_q = ConstFakeQuant(16); self.join = FakeQuantAdd(quantized=True); self.out_quant = ConstFakeQuant(16)

    def build(self, x):
        if SILU_MODE == 'sig':      # x * sigmoid(sat(x)): sigmoid LUT is bounded [0,1]
            return self.out_quant(leap.mul(x, self.core_q(leap.sigmoid(self.sat(x)))))
        core = self.core_q(leap.swish(self.sat(x)))
        tail = self.relu_q(leap.relu(self.shift(x, -SILU_KNEE)))
        return self.out_quant(self.join(core, tail))

    def forward(self, x):
        if SILU_MODE == 'sig':
            return self.out_quant(x * self.core_q(torch.sigmoid(self.sat(x))))
        core = self.core_q(torch.nn.functional.silu(self.sat(x)))
        tail = self.relu_q(torch.relu(self.shift(x, -SILU_KNEE)))
        return self.out_quant(self.join(core, tail))


class Qwen3DecoderLayer(Qwen2_5OmniDecoderLayer):
    def __init__(self, config, layer_idx):
        super().__init__(config, layer_idx)
        self.self_attn = Qwen3Attention(config, layer_idx)
        if SILU_MODE in ('split', 'sig'):
            self.mlp.act_fn = SplitSwish()


def make_layer(config, index, state):
    m = Qwen3DecoderLayer(config, index)
    m.load_state_dict({n: v.float() for n, v in state.items()}, strict=True)
    for norm in [m.input_layernorm, m.post_attention_layernorm]:
        norm.fp16_tiny = False; norm.preserve_precision = True
    a = m.self_attn
    for proj in [a.q_proj, a.k_proj, a.v_proj]:
        proj.quant_bits = 16; proj.out_fake_quant.bits = 16
    a.qk.x_bits = 16; a.qk.y_bits = 16; a.qk.x_fake_quant.bits = 16; a.qk.y_fake_quant.bits = 16
    a.sv.y_bits = 16; a.sv.y_fake_quant.bits = 16; a.key_out_fq.bits = 16
    return m


def gptq_override(layer, index, root):
    """Replace 7 linears with GPTQ int8 codes*scale and pin absmax=127*scale (keeps codes through official builder)."""
    mods = dict(layer.named_modules())
    for n in ['self_attn.q_proj', 'self_attn.k_proj', 'self_attn.v_proj', 'self_attn.o_proj', 'mlp.gate_proj', 'mlp.up_proj', 'mlp.down_proj']:
        z = np.load(Path(root) / f'layer{index}.{n}.npz')
        codes = torch.from_numpy(z['codes'].astype(np.float32)); s = torch.from_numpy(z['scales'].astype(np.float32)).reshape(-1, 1)
        mod = mods[n]; assert tuple(codes.shape) == tuple(mod.weight.shape)
        mod.weight.data.copy_(codes * s); mod.absmax_weight = (127 * s[:, 0]).clone()


class Group(Model):
    """Layers [first, first+count); deepstack inputs present iff group contains layer 0 (adds after layers 0,1,2)."""

    def __init__(self, first, count, cap, gptq=None):
        super().__init__()
        self.first, self.count, self.cap = first, count, cap
        self.ds = [i for i in range(first, first + count) if i < 3]
        cfg = text_config(); self.layers = torch.nn.ModuleList()
        for index in range(first, first + count):
            m = make_layer(cfg, index, layer_state(index))
            if gptq:
                gptq_override(m, index, gptq)
            self.layers.append(m)
        self.ds_add = torch.nn.ModuleList([FakeQuantAdd(quantized=False) for _ in self.ds])
        self.set_children_parent()

    def n_inputs(self):
        return 4 + len(self.ds) + 2 * self.count

    def forward(self, hidden, cos, sin, mask, *rest):
        ds, cache = rest[:len(self.ds)], rest[len(self.ds):]
        h = hidden[None]; out = []
        for i, layer in enumerate(self.layers):
            h, k, v = layer(h, attention_mask=mask[None, None], position_embeddings=(cos[None, None], sin[None, None]),
                            cache_k=cache[2 * i][None], cache_v=cache[2 * i + 1][None])
            out.extend([k[0], v[0]])
            if self.first + i in self.ds:
                j = self.ds.index(self.first + i)
                h = self.ds_add[j](h, ds[j][None])
        return h[0], *out

    def build(self, hidden, cos, sin, mask, *rest):
        ds, cache = rest[:len(self.ds)], rest[len(self.ds):]
        q = hidden.type.shape[0]; C = self.cap
        h = leap.reshape(hidden, [1, q, HID]); c = leap.reshape(cos, [1, 1, q, HD]); s = leap.reshape(sin, [1, 1, q, HD])
        m = leap.reshape(mask, [1, 1, q, C]); out = []
        for i, layer in enumerate(self.layers):
            h, k, v = layer(h, attention_mask=m, position_embeddings=(c, s),
                            cache_k=leap.reshape(cache[2 * i], [1, NKV, C, HD]), cache_v=leap.reshape(cache[2 * i + 1], [1, NKV, C, HD]))
            out.extend([leap.reshape(k, [NKV, q, HD]), leap.reshape(v, [NKV, q, HD])])
            if self.first + i in self.ds:
                j = self.ds.index(self.first + i)
                a = leap.cast_type(h, output_type=leap.float16)
                b = leap.cast_type(leap.reshape(ds[j], [1, q, HID]), output_type=leap.float16)
                h = leap.cast_type(self.ds_add[j](a, b), output_type=leap.float32)
        return leap.reshape(h, [q, HID]), *out

    def input_types(self, q):
        C = self.cap
        return ([leap.TensorType([q, HID], leap.float32), leap.TensorType([q, HD], leap.float32), leap.TensorType([q, HD], leap.float32),
                 leap.TensorType([q, C], leap.float32)] + [leap.TensorType([q, HID], leap.float32) for _ in self.ds]
                + [leap.TensorType([NKV, C, HD], leap.float32) for _ in range(2 * self.count)])


def chunk_inputs(group, hidden, cos, sin, ds_full, past, start, q, P):
    """Rows [start,start+q) of a sequence as a profile-P call. past: list per layer of (k,v) [NKV,start,HD] (host cache).
    Cache input right-aligned (past occupies the last `start` slots); mask follows the official query-row shift."""
    C = group.cap; assert 0 < q <= P and start + P <= C
    x = np.zeros((P, HID), np.float32); x[:q] = hidden[start:start + q]
    c = np.ones((P, HD), np.float32); s = np.zeros((P, HD), np.float32); c[:q] = cos[start:start + q]; s[:q] = sin[start:start + q]
    m = np.full((P, C), MASK_MIN, np.float32)
    m[:q, C - P - start:C - P] = 0.0
    tri = np.where(np.tril(np.ones((q, q), bool)), 0.0, MASK_MIN)
    m[:q, C - P:C - P + q] = tri
    if q < P:
        m[q:, C - P] = 0.0
    ds = []
    for _ in group.ds:
        ds.append(np.zeros((P, HID), np.float32))
    for j, li in enumerate(group.ds):
        ds[j][:q] = ds_full[li][start:start + q]
    cache = []
    for k, v in past:
        assert k.shape[1] == start
        pk = np.zeros((NKV, C, HD), np.float32); pv = np.zeros_like(pk)
        if start:
            pk[:, C - start:] = k; pv[:, C - start:] = v
        cache.extend([pk, pv])
    return [x, c, s, m, *ds, *cache]


def load_capture(d, first, count):
    """Captured BF16 sequence: group-input hidden, cos/sin, per-layer deepstack full-length adds, reference outputs."""
    d = Path(d)
    hidden = np.load(d / f'in-{first:02d}.npy'); cos = np.load(d / 'cos.npy'); sin = np.load(d / 'sin.npy')
    vmask = np.load(d / 'vmask.npy'); dse = np.load(d / 'deepstack.npy')
    ds_full = {}
    for li in range(3):
        full = np.zeros_like(hidden); full[vmask] = dse[li]; ds_full[li] = full
    return hidden, cos, sin, ds_full
