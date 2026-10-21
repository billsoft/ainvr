"""Extract camera frames from copied recordings: hour 11 -> calib, hour 12 -> final (time-disjoint), resized 896x448."""
import cv2, json, re
from pathlib import Path

REC = Path('/qwork/rec')
DST = Path('/qwork/data/camera')
PER = 5
meta = []
for mp4 in sorted(REC.glob('*.mp4')):
    cam, day, hms = re.match(r'(.+?)_(\d{8})_(\d{6})', mp4.name).groups()
    split = 'calib' if hms.startswith('11') else 'final'
    cap = cv2.VideoCapture(str(mp4))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    (DST / split).mkdir(parents=True, exist_ok=True)
    for i in range(PER):
        idx = int((i + 0.5) * n / PER)
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, fr = cap.read()
        if not ok:
            continue
        assert fr.shape[1] == 2 * fr.shape[0], fr.shape
        name = f'{cam[:8]}_{hms}_{idx:05d}.jpg'
        cv2.imwrite(str(DST / split / name), cv2.resize(fr, (896, 448), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 95])
        meta.append(dict(split=split, file=name, camera=cam, source=mp4.name, frame=idx))
    cap.release()
(DST / 'frames.json').write_text(json.dumps(meta, indent=1))
print({s: sum(m['split'] == s for m in meta) for s in ('calib', 'final')})
