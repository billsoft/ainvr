"""Score yes/no agreement of a quantized run vs frozen BF16: decision agreement at thresholds, |dp|, logit-gap error,
plus label accuracy for both. usage: score_yesno_v1.py EVAL_JSONL [EVAL_JSONL...]"""
import sys, json
import numpy as np

TH = [0.3, 0.5, 0.7]
for path in sys.argv[1:]:
    rows = [json.loads(l) for l in open(path, encoding='utf-8')]
    p = np.array([r['p'] for r in rows]); pr = np.array([r['p_ref'] for r in rows])
    d = np.array([r['d'] for r in rows]); dr = np.array([r['d_ref'] for r in rows])
    dp = np.abs(p - pr)
    lab = [(r['label'], r['p'], r['p_ref']) for r in rows if r['label'] is not None]
    out = dict(n=len(rows), agree={str(t): float(np.mean((p >= t) == (pr >= t))) for t in TH},
               flips_at_0_5=int(np.sum((p >= .5) != (pr >= .5))), dp_mean=float(dp.mean()), dp_p95=float(np.quantile(dp, .95)),
               dp_max=float(dp.max()), gap_err_median=float(np.median(np.abs(d - dr))),
               label_acc=float(np.mean([(x >= .5) == l for l, x, _ in lab])), label_acc_bf16=float(np.mean([(y >= .5) == l for l, _, y in lab])))
    print(path, json.dumps(out))
