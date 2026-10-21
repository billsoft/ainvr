"""Score a board run (board_run_alarm_v1 output) against the frozen BF16 reference: yes/no agreement at thresholds,
|dp|, logit-gap error, label accuracy, latency. usage: score_board_v1.py SPLIT OUT.jsonl [OUT.jsonl...]"""
import sys, json
from pathlib import Path
import numpy as np

W = Path(__file__).resolve().parent.parent
split = sys.argv[1]
ref = {json.loads(l)['id']: json.loads(l) for l in (W / f'ref/bf16-{split}-v2.jsonl').read_text(encoding='utf-8').splitlines()}
lab = {json.loads(l)['id']: json.loads(l)['label'] for l in (W / f'data/items-{split}-v2.jsonl').read_text(encoding='utf-8').splitlines()}
for path in sys.argv[2:]:
    rows = [json.loads(l) for l in open(path, encoding='utf-8')]
    p = np.array([r['p_yes'] for r in rows]); pr = np.array([ref[r['id']]['p_yes'] for r in rows])
    d = np.array([r['logit_yes'] - r['logit_no'] for r in rows]); dr = np.array([ref[r['id']]['logit_yes'] - ref[r['id']]['logit_no'] for r in rows])
    L = [(lab[r['id']], r['p_yes'], ref[r['id']]['p_yes']) for r in rows if lab[r['id']] is not None]
    ms = np.array([r['ms']['total'] for r in rows])
    flips = [r['id'] for r, a, b in zip(rows, p, pr) if (a >= .5) != (b >= .5)]
    print(Path(path).name, json.dumps(dict(
        n=len(rows), agree={str(t): round(float(np.mean((p >= t) == (pr >= t))), 4) for t in (0.3, 0.5, 0.7)},
        flips_at_0_5=flips, dp_mean=round(float(np.abs(p - pr).mean()), 4), dp_p95=round(float(np.quantile(np.abs(p - pr), .95)), 4),
        dp_max=round(float(np.abs(p - pr).max()), 4), gap_err_median=round(float(np.median(np.abs(d - dr))), 3),
        gap_err_p95=round(float(np.quantile(np.abs(d - dr), .95)), 3),
        label_acc=round(float(np.mean([(x >= .5) == l for l, x, _ in L])), 4), label_acc_bf16=round(float(np.mean([(y >= .5) == l for l, _, y in L])), 4),
        ms_median=round(float(np.median(ms)), 1), ms_p95=round(float(np.quantile(ms, .95)), 1)), ensure_ascii=False))
