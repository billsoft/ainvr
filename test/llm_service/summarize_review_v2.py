"""Summarize frozen-threshold evidence; never authorizes automatic review."""
import json,statistics,time
from pathlib import Path
R=Path('/home/sunrise/ainvr/test/results')
def main():
 raw=json.loads((R/'review-v2-acceptance/report.json').read_text());unique={}
 for row in raw['requests']:unique.setdefault(row['id'],row)
 report={'phase':raw['phase'],'elapsed_s':raw.get('elapsed_s',time.time()-raw['started_at']),'unique_targets':len(unique),'model_calls':len(raw['requests']),'request_errors':raw['errors'],'thresholds':{'approve_above':.95,'reject_below':.05},'splits':{}}
 for split in ['dev','final']:
  rows=[r for r in unique.values() if r['split']==split];pos=[r for r in rows if r['label']];neg=[r for r in rows if not r['label']]
  correct=sum((r['real_score']>=.5)==r['label'] for r in rows)
  approve=[r for r in rows if r['real_score']>=.95];reject=[r for r in rows if r['real_score']<=.05];wrong=[r for r in approve if not r['label']]+[r for r in reject if r['label']]
  report['splits'][split]={'targets':len(rows),'positive':len(pos),'negative':len(neg),'accuracy_at_0_5':correct/len(rows) if rows else None,'automatic_coverage':(len(approve)+len(reject))/len(rows) if rows else None,'automatic_errors':len(wrong),'false_confirmations':sum(not r['label'] for r in approve),'false_rejections':sum(r['label'] for r in reject),'wrong_cases':[{'id':r['id'],'label':r['label'],'kind':r['kind'],'score':r['real_score'],'source_image':r['source_image']} for r in wrong]}
 times=sorted(r['duration_ms'] for r in raw['requests'])
 if times:
  report['latency_ms']={'median':statistics.median(times),'p95':times[int(.95*(len(times)-1))],'mean':statistics.mean(times)}
  report['estimated_alarm_service_time_seconds']={str(n)+'_keyframes':statistics.mean(times)/1000*n+3 for n in [1,2,3,4]}
  report['alarm_service_time_note']='Estimate includes the current 3-second Worker poll delay; excludes evidence I/O and retries.'
 samples=raw['samples'];warm=[s for s in samples if s['elapsed_s']>=180]
 report['stability']={'one_hour_completed':raw['phase']=='complete' and raw.get('elapsed_s',0)>=3600,'rss_min_mib':min(s['rss_bytes'] for s in warm)/1024**2 if warm else None,'rss_max_mib':max(s['rss_bytes'] for s in warm)/1024**2 if warm else None,'fd_min':min(s['fds'] for s in warm) if warm else None,'fd_max':max(s['fds'] for s in warm) if warm else None,'service_pids_unchanged':raw.get('after_pids',raw['before_pids'])==raw['before_pids']}
 d=R/'review-dual-capacity-current.json';dual=json.loads(d.read_text()) if d.exists() else None
 p=R/'review-dual-capacity-pipeline.json';pipeline=json.loads(p.read_text()) if p.exists() else None
 report['second_detector_variants']={'synchronous':dual,'two_slot_pipeline':pipeline}
 report['second_detector']=pipeline or dual
 if report['second_detector']:report['dual_capacity_gate']=bool(report['second_detector']['finished'] and report['second_detector']['fps']>=9.5)
 report['production_channels']={}
 for cid in raw['running_channels']:
  a=[(s,next(c for c in s['channels'] if c['id']==cid)) for s in samples if any(c['id']==cid for c in s['channels'])]
  if len(a)>1:
   t0,c0=a[0];t1,c1=a[-1];span=t1['elapsed_s']-t0['elapsed_s'];inf=c1['inference']-c0['inference'];sei=c1['sei']-c0['sei']
   report['production_channels'][cid]={'elapsed_s':span,'inference_delta':inf,'sei_delta':sei,'effective_fps':inf/span,'max_consecutive_errors':max(c['errors'] for _,c in a)}
 report['automatic_review_qualified']=False
 provenance=R/'review-v2-acceptance/split-provenance.json'
 if provenance.exists():report['split_provenance']=json.loads(provenance.read_text())
 report['qualification_reasons']=['No field-labeled poster/reflection/mannequin/fire test set','Wrong-class negatives measure target focus, not field false-alarm prevalence','Insufficient independent field samples to certify automatic decisions']
 if any(v['automatic_errors'] for v in report['splits'].values()):report['qualification_reasons'].insert(0,'Frozen thresholds produced high-confidence wrong decisions')
 if raw['phase']!='complete':report['qualification_reasons'].append('One-hour test is still incomplete')
 (R/'review-v2-acceptance/summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
