"""v2: presence-style alarm descriptions (detector says X is in frame) for a balanced true/false mix."""
import hashlib, json, random
from pathlib import Path

ROOT = Path('/qwork/data') if Path('/qwork').exists() else Path(r'D:/codex-task-staging/qwen3vl/work/data')
SEED = 'qwen3vl-alarm-items-v2'
ANIMALS = set(range(14, 24))
TYPES = {
    '人员': (['检测模型在画面中识别到人员', '画面中出现人员', '检测到有人'], lambda c: 0 in c),
    '机动车': (['检测模型在画面中识别到机动车（汽车、卡车或公交车）', '画面中出现车辆'], lambda c: bool({2, 5, 7} & set(c))),
    '非机动车': (['检测模型识别到自行车或摩托车', '画面中出现两轮车'], lambda c: bool({1, 3} & set(c))),
    '动物': (['检测模型识别到动物', '画面中出现动物'], lambda c: bool(ANIMALS & set(c))),
    '箱包': (['检测模型识别到背包、手提包或行李箱', '画面中出现箱包'], lambda c: bool({24, 26, 28} & set(c))),
    '人员聚集': (['检测模型识别到5人及以上的人群', '画面中有很多人（5人及以上）'], lambda c: c.count(0) >= 5),
    '烟火': (['检测到画面中出现明火或烟雾', '疑似火情'], None),
    '手机': (['检测模型识别到手机', '画面中有人拿着手机'], lambda c: 67 in c),
}


def rng_for(name):
    return random.Random(hashlib.sha256(f'{SEED}|{name}'.encode()).hexdigest())


def items_for(image, classes, r):
    pos = [k for k, (_, f) in TYPES.items() if f is not None and classes is not None and f(classes)]
    neg = [k for k, (_, f) in TYPES.items() if f is not None and classes is not None and not f(classes)] + ['烟火']
    out = []
    picks = ([r.choice(pos)] if pos else []) + [r.choice(neg)]
    if classes is None:
        picks = r.sample(list(TYPES), 2)
    for k in picks:
        lab = None if classes is None or TYPES[k][1] is None else bool(TYPES[k][1](classes))
        out.append(dict(image=image, kind=k, desc=r.choice(TYPES[k][0]), label=lab))
    return out


sel = json.loads((ROOT / 'coco/selection.json').read_text())
frames = json.loads((ROOT / 'camera/frames.json').read_text())
splits = {}
for split, rows in sel['splits'].items():
    splits[split] = [x for it in rows for x in items_for(f'coco/{split}/{it["stem"]}.jpg', it['classes'], rng_for(it['stem']))]
for f in frames:
    splits.setdefault(f['split'], []).extend(items_for(f'camera/{f["split"]}/{f["file"]}', None, rng_for(f['file'])))
for split, items in splits.items():
    for i, it in enumerate(items):
        it['id'] = f'{split}-{i:04d}'
    (ROOT / f'items-{split}-v2.jsonl').write_text(''.join(json.dumps(x, ensure_ascii=False) + '\n' for x in items), encoding='utf-8')
    print(split, len(items), sum(x['label'] is True for x in items), sum(x['label'] is False for x in items))
