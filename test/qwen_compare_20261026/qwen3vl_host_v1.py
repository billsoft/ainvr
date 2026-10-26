"""Host-side (numpy-only, runs on the board) Qwen3-VL glue for a fixed 448x896 image: pixel patchify, MRoPE position ids,
interleaved-MRoPE cos/sin, chunk/KV/mask layout for the text-group HBMs. Verified against HF on PC (verify_host_v1.py)."""
import numpy as np

H, W, PS, MS, TPS = 448, 896, 16, 2, 2
GH, GW = H // PS, W // PS
IMAGE_TOKEN, VISION_START = 151655, 151652
THETA, HD, SECTION = 5000000.0, 128, (24, 20, 20)
HID, NKV = 2560, 8
import os
MASK_MIN = float(os.environ.get('QMASK', '-96'))   # -512 widened the int16 score range 4x (see debug_text_attn_taps_v1)


def patchify(rgb_u8):
    """rgb uint8 [448,896,3] -> [1568,1536] float32, identical layout to Qwen2VLImageProcessor (mean=std=0.5)."""
    assert rgb_u8.shape == (H, W, 3) and rgb_u8.dtype == np.uint8
    x = rgb_u8.astype(np.float32) * (1 / 255.0)
    x = (x - 0.5) / 0.5
    x = np.transpose(x, (2, 0, 1))[None]                      # [1,C,H,W]
    x = np.repeat(x, TPS, axis=0)                             # temporal duplicate -> [2,C,H,W]
    x = x.reshape(1, TPS, 3, GH // MS, MS, PS, GW // MS, MS, PS)
    x = x.transpose(0, 3, 6, 4, 7, 2, 1, 5, 8)
    return np.ascontiguousarray(x.reshape(GH * GW, 3 * TPS * PS * PS), np.float32)


def rope_index(ids):
    """[3,L] MRoPE positions for one image (grid t=1,h=GH/2,w=GW/2) inside a text prompt."""
    ids = list(ids); L = len(ids); start = ids.index(IMAGE_TOKEN)
    gh, gw = GH // MS, GW // MS; n = gh * gw
    assert ids[start:start + n] == [IMAGE_TOKEN] * n and IMAGE_TOKEN not in ids[start + n:]
    pos = np.zeros((3, L), np.int64)
    pos[:, :start] = np.arange(start)
    hh, ww = np.meshgrid(np.arange(gh), np.arange(gw), indexing='ij')
    pos[0, start:start + n] = start; pos[1, start:start + n] = start + hh.reshape(-1); pos[2, start:start + n] = start + ww.reshape(-1)
    nxt = pos[:, start:start + n].max() + 1
    pos[:, start + n:] = nxt + np.arange(L - start - n)
    return pos


def mrope_cos_sin(pos):
    """Interleaved MRoPE (THWTHW..., T tail) -> cos/sin [L,128] float32, as Qwen3VLTextRotaryEmbedding."""
    inv = 1.0 / (THETA ** (np.arange(0, HD, 2, dtype=np.float32) / HD))   # [64]
    f = pos.astype(np.float32)[:, :, None] * inv[None, None, :]          # [3,L,64]
    t = f[0].copy()
    for dim, off in ((1, 1), (2, 2)):
        idx = slice(off, SECTION[dim] * 3, 3); t[:, idx] = f[dim][:, idx]
    emb = np.concatenate([t, t], -1)
    return np.cos(emb).astype(np.float32), np.sin(emb).astype(np.float32)


def chunk_call(hidden, cos, sin, ds_full, past, start, q, P, cap, n_ds):
    """Inputs for one group call (same layout as qwen3vl_bpu_text_v1.chunk_inputs)."""
    C = cap; assert 0 < q <= P and start + P <= C
    x = np.zeros((P, HID), np.float32); x[:q] = hidden[start:start + q]
    c = np.ones((P, HD), np.float32); s = np.zeros((P, HD), np.float32); c[:q] = cos[start:start + q]; s[:q] = sin[start:start + q]
    m = np.full((P, C), MASK_MIN, np.float32); m[:q, C - P - start:C - P] = 0.0
    m[:q, C - P:C - P + q] = np.where(np.tril(np.ones((q, q), bool)), 0.0, MASK_MIN)
    if q < P:
        m[q:, C - P] = 0.0
    ds = []
    for j in range(n_ds):
        d = np.zeros((P, HID), np.float32); d[:q] = ds_full[j][start:start + q]; ds.append(d)
    cache = []
    for k, v in past:
        pk = np.zeros((NKV, C, HD), np.float32); pv = np.zeros_like(pk)
        if start:
            pk[:, C - start:] = k; pv[:, C - start:] = v
        cache.extend([pk, pv])
    return [x, c, s, m, *ds, *cache]


def prefill_plan(L, P):
    """Chunks (start, rows, profile): tokens [0, L-1) in prefill profile P, the last (decision) token as an s1 call —
    the same plan the group builders calibrate with."""
    out, s = [], 0
    while L - 1 - s > 0:
        q = min(P, L - 1 - s); out.append((s, q, P)); s += q
    out.append((L - 1, 1, 1))
    return out
