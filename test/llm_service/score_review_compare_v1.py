"""告警复审三方对比打分：按标注（真报/误报，模糊项不计）计算各模型的准确率、误报拦截率、真报保留率与耗时。
用法：python3 score_review_compare_v1.py ITEMS.jsonl NAME=RESULT.jsonl [NAME=RESULT.jsonl ...]
结果文件每行需含 id，以及 p_yes 或 logit_yes/logit_no；可选 ms.total 与 argmax_text。"""
import sys, json, math, statistics

items = {json.loads(l)['id']: json.loads(l) for l in open(sys.argv[1], encoding='utf-8') if l.strip()}
labeled = {k: v['label'] for k, v in items.items() if v['label'] in (True, False)}


def p_yes(r):
    if 'p_yes' in r:
        return r['p_yes']
    y, n = r['logit_yes'], r['logit_no']; m = max(y, n)
    return math.exp(y - m) / (math.exp(y - m) + math.exp(n - m))


def auc(pos, neg):
    s = sum((p > q) + 0.5 * (p == q) for p in pos for q in neg)
    return s / (len(pos) * len(neg)) if pos and neg else float('nan')


report = {}
for arg in sys.argv[2:]:
    name, path = arg.split('=', 1)
    rs = {}
    for l in open(path, encoding='utf-8'):
        if l.strip():
            r = json.loads(l)
            if 'id' in r:
                rs[r['id']] = r
    ids = [i for i in labeled if i in rs]
    pos = [p_yes(rs[i]) for i in ids if labeled[i]]; neg = [p_yes(rs[i]) for i in ids if not labeled[i]]
    out = dict(items_scored=len(ids), real=len(pos), false_alarm=len(neg), auc=round(auc(pos, neg), 4))
    for th in (0.3, 0.5, 0.7):
        keep = sum(p >= th for p in pos) / len(pos); block = sum(p < th for p in neg) / len(neg)
        acc = (sum(p >= th for p in pos) + sum(p < th for p in neg)) / len(ids)
        out[f'th{th}'] = dict(accuracy=round(acc, 4), false_alarm_blocked=round(block, 4), real_kept=round(keep, 4))
    # 同等条件对比：真报保留率不低于 target 时，能拦掉多少误报（阈值从高往低找满足条件的最大阈值）
    for target in (0.90, 0.95, 0.98):
        best = None
        for th in sorted(set(pos + neg), reverse=True):
            keep = sum(p >= th for p in pos) / len(pos)
            if keep >= target:
                best = dict(threshold=th, real_kept=round(keep, 4), false_alarm_blocked=round(sum(p < th for p in neg) / len(neg), 4))
                break
        out[f'keep_real_{int(target * 100)}'] = best
    ms = [rs[i]['ms']['total'] for i in rs if isinstance(rs[i].get('ms'), dict) and 'total' in rs[i]['ms']]
    if ms:
        out['latency_ms'] = dict(median=round(statistics.median(ms), 1), p95=round(sorted(ms)[int(0.95 * (len(ms) - 1))], 1))
    am = [rs[i].get('argmax_text') for i in rs if 'argmax_text' in rs[i]]
    if am:
        out['first_token_is_yes_or_no'] = round(sum(a in ('是', '否') for a in am) / len(am), 4)
    report[name] = out
print(json.dumps(report, ensure_ascii=False, indent=1))
