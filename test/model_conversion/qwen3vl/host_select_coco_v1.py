"""Host-side: deterministic COCO subset (train->calib, val->dev/final) copied into /qwork/data/coco with labels."""
import hashlib, json, shutil, sys
from pathlib import Path

SRC = Path(r'D:/code/yolovt/data/coco1920x3840')
DST = Path(r'D:/codex-task-staging/qwen3vl/work/data/coco')
SEED = 'qwen3vl-alarm-review-v1-20261020'
PLAN = {'calib': ('train2014', 160), 'dev': ('val2014', 80), 'final': ('val2014', 240)}
names = (SRC / 'coco.names').read_text().split('\n')


def key(n):
    return hashlib.sha256(f'{SEED}|{n}'.encode()).hexdigest()


out = {}
used = set()
for split, (sub, count) in PLAN.items():
    labels = SRC / 'labels' / sub
    cands = sorted((p.stem for p in labels.glob('*.txt')), key=key)
    picked = []
    for stem in cands:
        if stem in used:
            continue
        img = SRC / 'images' / sub / (stem + '.jpg')
        if not img.exists():
            continue
        rows = [l.split() for l in (labels / (stem + '.txt')).read_text().split('\n') if l.strip()]
        cls = [int(float(r[0])) for r in rows]
        picked.append(dict(stem=stem, sub=sub, classes=cls))
        used.add(stem)
        if len(picked) == count:
            break
    (DST / split).mkdir(parents=True, exist_ok=True)
    for it in picked:
        shutil.copy2(SRC / 'images' / it['sub'] / (it['stem'] + '.jpg'), DST / split / (it['stem'] + '.jpg'))
    out[split] = picked
    print(split, len(picked))
(DST / 'selection.json').write_text(json.dumps(dict(seed=SEED, names=names, splits=out), ensure_ascii=False, indent=1))
