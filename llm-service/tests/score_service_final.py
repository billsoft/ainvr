"""Score frozen final-set HTTP outputs without selecting/tuning thresholds."""
import json, statistics, hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
DATA=Path('/mnt/ainvr-ssd/llm-eval/v1')
OUT=ROOT/'test/results/llm-service-development'
def rows(name):return {x['id']:x for x in map(json.loads,(DATA/name).read_text().splitlines())}
def main():
    source=json.loads((OUT/'residency-final-559.json').read_text())
    assert source.get('passed') and all(v==0 for v in source['restore'].values())
    actual={x['request_id']:x for x in source['requests']};items=rows('items-final-v2.jsonl');reference=rows('bf16-final-v2.jsonl')
    assert len(actual)==len(source['requests'])==559 and actual.keys()==items.keys()==reference.keys()
    assert all(hashlib.sha256((DATA/v['image']).read_bytes()).hexdigest()==reference[k]['image_sha256'] for k,v in items.items()), 'reference image changed'
    pos=[actual[k]['real_score'] for k,v in items.items() if v['label'] is True]
    neg=[actual[k]['real_score'] for k,v in items.items() if v['label'] is False]
    agree=sum((actual[k]['real_score']>=.5)==(reference[k]['p_yes']>=.5) for k in items)/len(items)
    times=sorted(v['timing_ms']['total'] for v in actual.values())
    report={'items':len(items),'labeled':len(pos)+len(neg),'threshold':.5,'bf16_agreement':agree,
      'label_accuracy':(sum(x>=.5 for x in pos)+sum(x<.5 for x in neg))/(len(pos)+len(neg)),
      'true_alarm_kept':sum(x>=.5 for x in pos)/len(pos),'false_alarm_blocked':sum(x<.5 for x in neg)/len(neg),
      'auc':sum((p>n)+.5*(p==n) for p in pos for n in neg)/(len(pos)*len(neg)),
      'latency_ms':{'median':statistics.median(times),'p95':times[int(.95*(len(times)-1))]},
      'quality_gate':agree>=.973,'package_sha256':next(iter(actual.values()))['model']['package_sha256'],
      'note':'Frozen threshold only. Does not establish a production alarm threshold or video coexistence.'}
    (OUT/'final-559-quality.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
    if not report['quality_gate']:raise SystemExit(1)
if __name__=='__main__':main()
