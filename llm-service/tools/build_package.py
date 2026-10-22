#!/usr/bin/env python3
"""Build a checksummed, self-contained review package on SSD (no BPU work)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import numpy as np

PROMPT = ('你是安防监控的告警复审员。监控系统对这张图片产生了一条告警。\n'
          '告警类型：{kind}\n告警描述：{desc}\n'
          '请仔细查看图片，判断这条告警是否属实（画面中确实存在所描述的情况）。'
          '只回答“是”或“否”。')


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(4 << 20), b''):
            h.update(block)
    return h.hexdigest()


def build(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination.exists():
        raise ValueError('destination already exists; never overwrite a published package')
    destination.mkdir(parents=True)
    files = []

    def record(path, role):
        files.append(dict(role=role, path=str(path.relative_to(destination)),
                          bytes=path.stat().st_size, sha256=digest(path)))

    def copy(src, name, role):
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target)
        record(target, role)
        return name

    programs = {}
    for kind, names in [('vision', ['vis-0-6', 'vis-6-12', 'vis-12-18', 'vis-18-24']),
                        ('text', ['txt-0-8', 'txt-9-17', 'txt-18-26', 'txt-27-35']),
                        ('head', ['head'])]:
        programs[kind] = []
        for name in names:
            src = source / (name + '-o2-v3')
            profiles = {}
            for ports in sorted(src.glob('s*/ports.json')):
                profiles[ports.parent.name] = copy(ports, f'{name}/{ports.parent.name}/ports.json', 'ports')
            programs[kind].append(dict(file=copy(src / 'model.hbm', f'{name}/model.hbm', 'hbm'), profiles=profiles))
    emb = np.load(source / 'run-v1/embed_tokens_bf16bits.npy', mmap_mode='r')
    if emb.dtype != np.uint16 or emb.ndim != 2 or emb.shape[1] != 2560:
        raise ValueError('unexpected embedding layout')
    emb.tofile(destination / 'embedding.bf16')
    record(destination / 'embedding.bf16', 'embedding')
    tables = {}
    def table(name, value):
        value = np.ascontiguousarray(value, dtype='<f4')
        path = destination / (name + '.f32')
        value.tofile(path)
        record(path, 'table')
        tables[name] = dict(path=path.name, shape=list(value.shape))
    rope = np.load(source / 'run-v1/vision_rope.npz')
    table('vision_cos', rope['cos'])
    table('vision_sin', rope['sin'])
    inv = 1.0 / (5000000.0 ** (np.arange(0, 128, 2, dtype=np.float32) / 128))
    freq = np.arange(1024, dtype=np.float32)[:, None] * inv[None, :]
    table('rope_cos', np.cos(freq))
    table('rope_sin', np.sin(freq))
    table('normalize', (np.arange(256, dtype=np.float32) * (1 / 255.0) - 0.5) / 0.5)
    copy(source / 'tokenizer-v1/tokenizer.json', 'tokenizer.json', 'tokenizer')
    copy(source / 'tokenizer-v1/chat_template.json', 'chat_template.json', 'reference_template')
    tokens = json.loads((source / 'head-o2-v3/tokens.json').read_text())
    template = dict(id='alarm-review-zh-v1', prompt=PROMPT,
                    prefix='<|im_start|>user\n<|vision_start|>',
                    image_token='<|image_pad|>', image_tokens=392,
                    suffix='<|vision_end|>{prompt}<|im_end|>\n<|im_start|>assistant\n')
    (destination / 'task-template.json').write_text(json.dumps(template, ensure_ascii=False, indent=2))
    record(destination / 'task-template.json', 'template')
    manifest = dict(schema='ainvr.llm_package.v1', id='qwen3vl-4b-review-v3',
                    adapter='qwen3vl_grouped', target='nash-m',
                    capabilities=['task:alarm-review-zh-v1', 'decision_tokens'],
                    context_tokens=1024, prefill=256, programs=programs,
                    embedding=dict(path='embedding.bf16', shape=list(emb.shape)),
                    tables=tables, decision_vocabulary=tokens, files=files,
                    image=dict(width=896, height=448, tokens=392, formats=['jpeg']),
                    resources=dict(ion_bytes_measured=5500000000),
                    validation=dict(reference='v3-o2-final-559', agreement=0.9767,
                                    labeled_accuracy=0.882, auc=0.978,
                                    scope='fixed template, first decision token only'))
    (destination / 'llm-package.ainvr.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps(dict(package=str(destination), manifest_sha256=digest(destination / 'llm-package.ainvr.json'),
                         files=len(files), bytes=sum(f['bytes'] for f in files))))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--source', required=True)
    p.add_argument('--destination', required=True)
    a = p.parse_args()
    build(a.source, a.destination)
