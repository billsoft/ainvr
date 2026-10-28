"""AINVR SigLIP text tower: calibration/eval prompt corpus, tokenization and ONNX export.

Offline preparation only. The tower is re-implemented in plain PyTorch from the
safetensors weights and checked against the Hugging Face reference; token ids are the
model input (embedding lookup stays inside the graph).
"""
import argparse, hashlib, itertools, json, random, time
from pathlib import Path
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from safetensors.torch import load_file

SEQ = 64


class AdaptiveLN(nn.Module):
    """LayerNorm rewritten for fixed-point BPU execution.

    LayerNorm is invariant to a positive per-token scale, so each token is first divided by its own
    max |x|. Tokens with a massive-activation channel (|x| ~ 4e2 against a typical 0.2) and ordinary
    tokens then have variances of the same order, which a single int16 scale can represent; the
    default decomposed LayerNorm quantizes mean(x^2) with one range set by the outlier token.
    Mathematically identical to LayerNorm up to eps (eps is applied in the scaled domain).
    """

    def __init__(self, d, eps=1e-6):
        super().__init__()
        self.weight, self.bias = nn.Parameter(torch.ones(d)), nn.Parameter(torch.zeros(d))
        self.eps = eps

    def forward(self, x):
        s = torch.clamp(x.abs().amax(-1, keepdim=True), min=1e-3)
        z = x * (1.0 / s)
        d = z - z.mean(-1, keepdim=True)
        v = (d * d).mean(-1, keepdim=True)
        return d * torch.rsqrt(v + self.eps) * self.weight + self.bias


def gelu_tanh_safe(x):
    """GELU(tanh approximation) with a bounded cubic term.

    For |x| > 8 tanh(0.798*(x + 0.0447 x^3)) is already +-1 to fp32 precision, so clamping the argument
    of the tanh branch changes nothing, while the cubic intermediate shrinks from ~1e5 to ~25 and a
    fixed-point lookup keeps its resolution (outlier channels reach |x| ~ 50 in fc1).
    """
    u = torch.clamp(x, -8.0, 8.0)
    return 0.5 * x * (1.0 + torch.tanh(0.7978845608028654 * (u + 0.044715 * u * u * u)))


SOFTMAX_CLAMP = None   # set to e.g. 16.0 to bound the exp argument for fixed-point execution


def attn_softmax(scores):
    """softmax over the last dim; optionally with (x - max) clamped to [-SOFTMAX_CLAMP, 0].

    exp(-16) < 1.2e-7 of the max term, so clamping is lossless at fp32 while shrinking the range the
    quantized Sub/Exp lookup has to cover (scores of massive-activation tokens reach ~60).
    """
    if SOFTMAX_CLAMP is None:
        return torch.softmax(scores, dim=-1)
    d = torch.clamp(scores - scores.amax(-1, keepdim=True), min=-SOFTMAX_CLAMP, max=0.0)
    e = torch.exp(d)
    return e / e.sum(-1, keepdim=True)


def make_ln(d, adaptive):
    return AdaptiveLN(d) if adaptive else nn.LayerNorm(d, eps=1e-6)


class Layer(nn.Module):
    def __init__(self, d, heads, ff, adaptive=False, safe_gelu=False):
        super().__init__()
        self.safe_gelu = safe_gelu
        self.h, self.dh = heads, d // heads
        self.ln1, self.ln2 = make_ln(d, adaptive), make_ln(d, adaptive)
        self.q, self.k, self.v, self.o = (nn.Linear(d, d) for _ in range(4))
        self.fc1, self.fc2 = nn.Linear(d, ff), nn.Linear(ff, d)

    def forward(self, x):
        b, n, d = x.shape
        y = self.ln1(x)
        q = self.q(y).view(b, n, self.h, self.dh).transpose(1, 2)
        k = self.k(y).view(b, n, self.h, self.dh).transpose(1, 2)
        v = self.v(y).view(b, n, self.h, self.dh).transpose(1, 2)
        a = attn_softmax((q @ k.transpose(-1, -2)) * (self.dh ** -0.5))
        x = x + self.o((a @ v).transpose(1, 2).reshape(b, n, d))
        h = self.fc1(self.ln2(x))
        return x + self.fc2(gelu_tanh_safe(h) if self.safe_gelu else F.gelu(h, approximate='tanh'))


class ShardedEmbedding(nn.Module):
    """Exact token embedding split into row shards.

    The BPU Gather (hbir.index) only accepts a select dimension of at most 32768 rows, while the
    SigLIP vocabulary has 250000. Each shard is gathered with a clamped local index and multiplied
    by an exact 0/1 membership mask, so the sum equals the full-table lookup bit for bit.
    """

    def __init__(self, vocab, d, shard):
        super().__init__()
        assert shard <= 32768
        self.shard, self.n = shard, -(-vocab // shard)
        self.weights = nn.ParameterList(nn.Parameter(torch.zeros(min(shard, vocab - k * shard), d))
                                        for k in range(self.n))

    def load(self, full):
        with torch.no_grad():
            for k, w in enumerate(self.weights):
                w.copy_(full[k * self.shard:k * self.shard + w.shape[0]])

    def forward(self, ids):
        out = 0
        for k, w in enumerate(self.weights):
            local = ids - k * self.shard
            idx = torch.clamp(local, 0, w.shape[0] - 1)
            mask = (local == idx).to(w.dtype).unsqueeze(-1)
            out = out + F.embedding(idx, w) * mask
        return out


class TextTower(nn.Module):
    """Bidirectional SigLIP text encoder; no attention mask (trained with max_length padding)."""

    def __init__(self, cfg, sd, prefix='text_model.', shard=0, adaptive_ln=False, safe_gelu=False):
        super().__init__()
        d, ff, nl, heads, vocab = (cfg['hidden_size'], cfg['intermediate_size'], cfg['num_hidden_layers'],
                                   cfg['num_attention_heads'], cfg['vocab_size'])
        pos_n = sd[prefix + 'embeddings.position_embedding.weight'].shape[0]
        assert pos_n == SEQ, pos_n
        self.tok = ShardedEmbedding(vocab, d, shard) if shard else nn.Embedding(vocab, d)
        self.pos = nn.Embedding(pos_n, d)
        self.layers = nn.ModuleList(Layer(d, heads, ff, adaptive_ln, safe_gelu) for _ in range(nl))
        self.fln, self.head = make_ln(d, adaptive_ln), nn.Linear(d, d)
        tok_key = prefix + 'embeddings.token_embedding.weight'
        m = {prefix + 'embeddings.position_embedding.weight': self.pos.weight,
             prefix + 'final_layer_norm.weight': self.fln.weight, prefix + 'final_layer_norm.bias': self.fln.bias,
             prefix + 'head.weight': self.head.weight, prefix + 'head.bias': self.head.bias}
        for i, L in enumerate(self.layers):
            p = f'{prefix}encoder.layers.{i}.'
            for name, mod in (('layer_norm1', L.ln1), ('layer_norm2', L.ln2), ('self_attn.q_proj', L.q),
                              ('self_attn.k_proj', L.k), ('self_attn.v_proj', L.v), ('self_attn.out_proj', L.o),
                              ('mlp.fc1', L.fc1), ('mlp.fc2', L.fc2)):
                m[p + name + '.weight'], m[p + name + '.bias'] = mod.weight, mod.bias
        with torch.no_grad():
            for k, t in m.items():
                assert k in sd, k
                assert t.shape == sd[k].shape, (k, t.shape, sd[k].shape)
                t.copy_(sd[k])
            assert sd[tok_key].shape == (vocab, d), sd[tok_key].shape
            if shard:
                self.tok.load(sd[tok_key])
            else:
                self.tok.weight.copy_(sd[tok_key])
        self.register_buffer('ids', torch.arange(SEQ), persistent=False)

    def forward(self, input_ids):
        x = self.tok(input_ids) + self.pos(self.ids)[None]
        for L in self.layers:
            x = L(x)
        return self.head(self.fln(x)[:, -1])


# ---- surveillance prompt corpus; calibration and evaluation use disjoint attribute combinations ----
ZH_COLOR = ['红色', '黑色', '白色', '蓝色', '灰色', '黄色', '绿色', '橙色', '粉色', '棕色']
ZH_CLOTH = ['外套', '上衣', '连帽衫', '雨衣', '羽绒服', '短袖', '制服', '背心']
ZH_CARRY = ['背着黑色背包', '推着婴儿车', '拿着雨伞', '提着购物袋', '拖着行李箱', '戴着头盔', '戴着口罩', '抱着箱子', '骑着电动车', '牵着狗']
ZH_PLACE = ['后门', '大门口', '走廊', '停车场', '楼梯口', '电梯口', '路口', '仓库门前', '登船口', '站台']
ZH_VEH = ['白色轿车', '黑色SUV', '红色货车', '蓝色面包车', '黄色出租车', '银色轿车', '电动三轮车', '摩托车', '公交车', '快递车']
ZH_ACT = ['停在', '驶过', '倒车进入', '缓慢经过', '长时间停留在']
ZH_EV = ['有人翻越围栏', '有人在门口徘徊', '两个人在争执', '有人摔倒在地', '有人把包放在地上离开', '一群人聚集', '有人奔跑',
         '地面有积水', '有人拖着箱子进入', '门被打开', '有人在搬运货物', '夜间有人靠近车辆']
EN_COLOR = ['red', 'black', 'white', 'blue', 'gray', 'yellow', 'green', 'orange']
EN_CLOTH = ['jacket', 'hoodie', 'raincoat', 'uniform', 'vest', 'coat']
EN_CARRY = ['carrying a black backpack', 'pushing a stroller', 'holding an umbrella', 'wearing a helmet', 'riding a scooter',
            'walking a dog', 'pulling a suitcase', 'carrying a box']
EN_PLACE = ['the back door', 'the main gate', 'the corridor', 'the parking lot', 'the stairs', 'the elevator', 'the crossroad']
EN_VEH = ['a white sedan', 'a black SUV', 'a red truck', 'a blue van', 'a yellow taxi', 'a motorcycle', 'a bus']


def build_corpus(seed=7):
    rng = random.Random(seed)
    zh_person = [f'{c}{o}的人{a}在{p}' for c, o, a, p in itertools.product(ZH_COLOR, ZH_CLOTH, ZH_CARRY, ZH_PLACE)]
    zh_person_b = [f'穿{c}{o}的人{a}经过{p}' for c, o, a, p in itertools.product(ZH_COLOR, ZH_CLOTH, ZH_CARRY, ZH_PLACE)]
    zh_veh = [f'{v}{a}{p}' for v, a, p in itertools.product(ZH_VEH, ZH_ACT, ZH_PLACE)]
    zh_ev = [f'{p}{e}' for p, e in itertools.product(ZH_PLACE, ZH_EV)] + ZH_EV
    en_person = [f'a person in a {c} {o} {a} near {p}' for c, o, a, p in itertools.product(EN_COLOR, EN_CLOTH, EN_CARRY, EN_PLACE)]
    en_veh = [f'{v} parked near {p}' for v, p in itertools.product(EN_VEH, EN_PLACE)]
    pools = {'zh_person': zh_person, 'zh_person_b': zh_person_b, 'zh_veh': zh_veh, 'zh_ev': zh_ev,
             'en_person': en_person, 'en_veh': en_veh}
    take = {'zh_person': (150, 40), 'zh_person_b': (110, 30), 'zh_veh': (80, 20), 'zh_ev': (90, 20),
            'en_person': (60, 12), 'en_veh': (22, 6)}
    calib, ev = [], []
    for name, pool in pools.items():
        pool = pool[:]
        rng.shuffle(pool)
        nc, ne = take[name]
        calib += pool[:nc]
        ev += pool[nc:nc + ne]            # disjoint from calibration by construction
    assert not set(calib) & set(ev)
    return calib, ev


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--model-dir', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--adaptive-ln', action='store_true', help='per-token prescaled LayerNorm for int16 (massive activations)')
    ap.add_argument('--safe-gelu', action='store_true', help='clamped-argument GELU(tanh) for fixed-point range')
    ap.add_argument('--tokenizer', choices=['siglip', 'gemma'], default='siglip')
    ap.add_argument('--shard', type=int, default=0, help='embedding row shard size (<=32768) for the BPU Gather limit')
    a = ap.parse_args()
    a.output.mkdir(parents=True, exist_ok=False)
    torch.set_num_threads(8)
    cfg = dict(hidden_size=768, intermediate_size=3072, num_hidden_layers=12, num_attention_heads=12, vocab_size=32000)
    cfg.update(json.loads((a.model_dir / 'config.json').read_text())['text_config'])   # SigLIP2 configs omit sizes
    calib, ev = build_corpus()
    from transformers import SiglipTokenizer, SiglipModel, AutoTokenizer
    gemma = a.tokenizer == 'gemma'
    tok = AutoTokenizer.from_pretrained(str(a.model_dir)) if gemma else SiglipTokenizer.from_pretrained(str(a.model_dir))
    prep = (lambda xs: [x.lower() for x in xs]) if gemma else (lambda xs: xs)   # SigLIP2 expects lowercased text
    enc = lambda xs: np.asarray(tok(prep(xs), padding='max_length', max_length=SEQ, truncation=True)['input_ids'], dtype=np.int64)
    ct, et = enc(calib), enc(ev)
    assert ct.shape == (len(calib), SEQ) and ct.max() < cfg['vocab_size']
    (a.output / 'calib').mkdir()
    for i, row in enumerate(ct):
        np.save(a.output / 'calib' / f'{i:04d}.npy', row.reshape(1, SEQ))
    np.save(a.output / 'eval_tokens.npy', et)
    (a.output / 'prompts.json').write_text(json.dumps({'calib': calib, 'eval': ev}, ensure_ascii=False, indent=1), encoding='utf-8')
    sd = load_file(str(a.model_dir / 'model.safetensors'))
    mine = TextTower(cfg, sd, shard=a.shard, adaptive_ln=a.adaptive_ln, safe_gelu=a.safe_gelu).eval()
    ref = SiglipModel.from_pretrained(str(a.model_dir), torch_dtype=torch.float32).eval()
    errs, cos = [], []
    with torch.no_grad():
        for row in et[:64]:
            t = torch.from_numpy(row.reshape(1, SEQ))
            x, y = mine(t), ref.get_text_features(input_ids=t)
            errs.append(float((x - y).abs().max()))
            cos.append(float(F.cosine_similarity(x, y).item()))
    r = {'calib': len(calib), 'eval': len(ev), 'max_abs_err_vs_hf': max(errs), 'min_cos_vs_hf': min(cos),
         'pad_id': int(ct[0, -1]), 'eos_row0_tail': ct[0, -6:].tolist()}
    assert r['min_cos_vs_hf'] > (0.9999 if (a.adaptive_ln or a.safe_gelu) else 0.99999), r
    onnx_path = a.output / 'siglip-text-64.onnx'
    torch.onnx.export(mine, (torch.from_numpy(et[:1]),), str(onnx_path), input_names=['input_ids'],
                      output_names=['text_embedding'], opset_version=17, do_constant_folding=True, dynamo=False)
    import onnx, onnxruntime as ort
    g = onnx.load(str(onnx_path))
    r['onnx_ops'] = sorted({n.op_type for n in g.graph.node})
    sess = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
    oe = []
    with torch.no_grad():
        for row in et[:16]:
            t = row.reshape(1, SEQ)
            oe.append(float(np.abs(sess.run(None, {'input_ids': t})[0] - mine(torch.from_numpy(t)).numpy()).max()))
    r['onnx_max_abs_err'] = max(oe)
    r['onnx_sha256'] = hashlib.sha256(onnx_path.read_bytes()).hexdigest()
    (a.output / 'status.json').write_text(json.dumps(r, indent=1))
    print(json.dumps(r, indent=1))


if __name__ == '__main__':
    main()
