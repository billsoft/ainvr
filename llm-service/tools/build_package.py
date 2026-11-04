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


V4_VALIDATION = dict(reference='v3-o2-final-559', agreement=0.9767, labeled_accuracy=0.882, auc=0.978,
                     scope='fixed template, first decision token only')


def build(source, destination, spec):
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
    for kind, names in [('vision', spec['vision_groups']), ('text', spec['text_groups']), ('head', ['head'])]:
        programs[kind] = []
        for name in names:
            src = source / (name + spec['build_suffix'])
            profiles = {}
            for ports in sorted(src.glob('s*/ports.json')):
                profiles[ports.parent.name] = copy(ports, f'{name}/{ports.parent.name}/ports.json', 'ports')
            programs[kind].append(dict(file=copy(src / 'model.hbm', f'{name}/model.hbm', 'hbm'), profiles=profiles))
    emb = np.load(source / 'run-v1/embed_tokens_bf16bits.npy', mmap_mode='r')
    if emb.dtype != np.uint16 or emb.ndim != 2 or emb.shape[1] != spec['hidden']:
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
    tokens = json.loads((source / ('head' + spec['build_suffix']) / 'tokens.json').read_text())
    template = dict(id='alarm-review-zh-v1', prompt=PROMPT,
                    prefix='<|im_start|>user\n<|vision_start|>',
                    image_token='<|image_pad|>', image_tokens=392,
                    suffix='<|vision_end|>{prompt}<|im_end|>\n<|im_start|>assistant\n')
    (destination / 'task-template.json').write_text(json.dumps(template, ensure_ascii=False, indent=2))
    record(destination / 'task-template.json', 'template')
    manifest = dict(schema='ainvr.llm_package.v1', id=spec['id'],
                    adapter='qwen3vl_grouped', target='nash-m',
                    capabilities=['task:alarm-review-zh-v1', 'decision_tokens'],
                    context_tokens=1024, prefill=256, programs=programs,
                    embedding=dict(path='embedding.bf16', shape=list(emb.shape)),
                    tables=tables, decision_vocabulary=tokens, files=files,
                    image=dict(width=896, height=448, tokens=392, formats=['jpeg']),
                    resources=dict(ion_bytes_measured=spec['ion_bytes']),
                    validation=spec['validation'])
    if spec['text_group_layers']:
        # v2 manifest: the engine reads its shape from here. Without this section the engine assumes the 4B v1 shape.
        manifest['model'] = dict(hidden=spec['hidden'], head_dim=spec['head_dim'], kv_heads=spec['kv_heads'],
                                 text_group_layers=spec['text_group_layers'], deepstack=3, image_token_id=151655,
                                 mrope_section=[24, 20, 20], mask_min=-96.0)
    if spec['label']:
        manifest['label'] = spec['label']
    (destination / 'llm-package.ainvr.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps(dict(package=str(destination), manifest_sha256=digest(destination / 'llm-package.ainvr.json'),
                         files=len(files), bytes=sum(f['bytes'] for f in files))))


def csv(value):
    return [x for x in value.split(',') if x]


if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Build an llm package. Defaults reproduce the Qwen3-VL-4B v1 package.')
    p.add_argument('--source', required=True)
    p.add_argument('--destination', required=True)
    p.add_argument('--id', default='qwen3vl-4b-review-v3', help='package id = directory name under the models root')
    p.add_argument('--build-suffix', default='-o2-v3', help='suffix of the compiled package directories under --source')
    p.add_argument('--vision-groups', default='vis-0-6,vis-6-12,vis-12-18,vis-18-24')
    p.add_argument('--text-groups', default='txt-0-8,txt-9-17,txt-18-26,txt-27-35')
    p.add_argument('--text-group-layers', default='', help='e.g. 7,7,7,7; writes the manifest "model" section (needed unless 9,9,9,9 at 2560 wide)')
    p.add_argument('--hidden', type=int, default=2560)
    p.add_argument('--head-dim', type=int, default=128)
    p.add_argument('--kv-heads', type=int, default=8)
    p.add_argument('--ion-bytes', type=int, default=5500000000, help='measured ION bytes of the loaded package (never an estimate)')
    p.add_argument('--label', default='', help='short Chinese display name shown in the console')
    p.add_argument('--validation-json', default='', help='JSON file with the validation block; default is the 4B record')
    a = p.parse_args()
    layers = [int(x) for x in csv(a.text_group_layers)]
    if not layers and (a.hidden != 2560 or a.head_dim != 128 or a.kv_heads != 8):
        raise SystemExit('a non-4B shape needs --text-group-layers so the manifest carries its model section')
    if layers and len(layers) != len(csv(a.text_groups)):
        raise SystemExit('--text-group-layers must have one entry per text group')
    validation = json.loads(Path(a.validation_json).read_text(encoding='utf-8')) if a.validation_json else V4_VALIDATION
    if a.id != 'qwen3vl-4b-review-v3' and not a.validation_json:
        raise SystemExit('give --validation-json for a new package; the 4B record must not be copied onto another model')
    build(a.source, a.destination, dict(id=a.id, build_suffix=a.build_suffix, vision_groups=csv(a.vision_groups),
          text_groups=csv(a.text_groups), text_group_layers=layers, hidden=a.hidden, head_dim=a.head_dim,
          kv_heads=a.kv_heads, ion_bytes=a.ion_bytes, label=a.label, validation=validation))
