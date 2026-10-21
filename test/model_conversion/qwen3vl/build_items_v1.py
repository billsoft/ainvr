"""Build alarm-review items: per image one label-positive alarm type (if any) + one label-negative type."""
import hashlib, json, random
from pathlib import Path

ROOT = Path('/qwork/data') if Path('/qwork').exists() else Path(r'D:/codex-task-staging/qwen3vl/work/data')
SEED = 'qwen3vl-alarm-items-v1'
ANIMALS = set(range(14, 24))
TYPES = {
    '人员闯入': (['检测到有人员进入监控区域', '警戒区域内发现可疑人员', '检测到人员越界进入'], lambda c: 0 in c),
    '车辆闯入': (['检测到机动车驶入监控区域', '禁停区域发现车辆', '检测到车辆闯入警戒区'], lambda c: bool({2, 5, 7} & set(c))),
    '非机动车': (['检测到自行车或电动车进入区域', '发现非机动车违规停放'], lambda c: bool({1, 3} & set(c))),
    '动物闯入': (['检测到动物进入监控区域', '发现猫狗等动物闯入'], lambda c: bool(ANIMALS & set(c))),
    '遗留物品': (['检测到疑似无人看管的包裹或箱包', '发现可疑遗留物品'], lambda c: bool({24, 26, 28} & set(c))),
    '人员聚集': (['检测到多人聚集（5人及以上）', '发现人群聚集'], lambda c: c.count(0) >= 5),
    '烟火': (['检测到画面中出现明火或烟雾', '疑似火情'], None),
    '使用手机': (['检测到人员在使用手机', '发现有人打电话或玩手机'], lambda c: 67 in c),
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
    (ROOT / f'items-{split}-v1.jsonl').write_text(''.join(json.dumps(x, ensure_ascii=False) + '\n' for x in items), encoding='utf-8')
    print(split, len(items), sum(x['label'] is True for x in items), sum(x['label'] is False for x in items))
