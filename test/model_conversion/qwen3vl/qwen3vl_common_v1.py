"""Qwen3-VL-4B alarm-review shared helpers: fixed 448x896 input, prompt, yes/no probability."""
import sys
sys.path.insert(0, '/opt/qsdk/locate-reference-deps')
from pathlib import Path
import hashlib, json
import numpy as np
import torch
from PIL import Image

MODEL = Path('/models/Qwen3-VL-4B-Instruct')
H, W = 448, 896
PIXELS = H * W
YES, NO = '是', '否'

PROMPT = ('你是安防监控的告警复审员。监控系统对这张图片产生了一条告警。\n'
          '告警类型：{kind}\n告警描述：{desc}\n'
          '请仔细查看图片，判断这条告警是否属实（画面中确实存在所描述的情况）。'
          '只回答“是”或“否”。')


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


def load_image(path):
    """Letterbox-free fixed resize to 896x448 (sources are already 2:1)."""
    im = Image.open(path).convert('RGB')
    if im.size != (W, H):
        im = im.resize((W, H), Image.BICUBIC)
    return im


def load_model(device='cuda', dtype=torch.bfloat16):
    from transformers import Qwen3VLForConditionalGeneration, AutoProcessor
    proc = AutoProcessor.from_pretrained(str(MODEL))
    ip = proc.image_processor
    ip.size = {'shortest_edge': PIXELS, 'longest_edge': PIXELS}
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        str(MODEL), dtype=dtype, attn_implementation='sdpa').to(device).eval()
    return model, proc


def answer_token_ids(proc):
    tok = proc.tokenizer
    ids = [tok.encode(x, add_special_tokens=False) for x in (YES, NO)]
    assert all(len(i) == 1 for i in ids), ids
    return ids[0][0], ids[1][0]


def build_inputs(proc, image, kind, desc, answer=None):
    msgs = [{'role': 'user', 'content': [
        {'type': 'image'},
        {'type': 'text', 'text': PROMPT.format(kind=kind, desc=desc)}]}]
    text = proc.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    if answer is not None:
        text = text + answer
    enc = proc(text=[text], images=[image], return_tensors='pt')
    assert enc['image_grid_thw'].tolist() == [[1, H // 16, W // 16]], enc['image_grid_thw']
    return enc


@torch.inference_mode()
def yes_no(model, proc, enc, device='cuda'):
    """First-token logits -> (p_yes over {yes,no}, top1 id, logit_yes, logit_no)."""
    y, n = answer_token_ids(proc)
    out = model(**{k: v.to(device) for k, v in enc.items()})
    logits = out.logits[0, -1].float()
    two = torch.stack([logits[y], logits[n]])
    p = torch.softmax(two, 0)[0].item()
    return dict(p_yes=p, top1=int(logits.argmax()), logit_yes=float(logits[y]), logit_no=float(logits[n]))
