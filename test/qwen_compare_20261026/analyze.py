from pathlib import Path
import json,math,statistics,sys,hashlib
import numpy as np
ROOT=Path(sys.argv[1])
def rows(path):return [json.loads(x) for x in path.read_text().splitlines() if x.strip()]
def ci(k,n):
 z=1.95996398454;p=k/n;den=1+z*z/n;mid=(p+z*z/(2*n))/den;half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
 return [mid-half,mid+half]
def conf(records,labels):
 pairs=[(labels[r['id']]['label'],r['p_yes']>=.5) for r in records if labels[r['id']]['label'] is not None]
 tp=sum(a and b for a,b in pairs);tn=sum(not a and not b for a,b in pairs);fp=sum(not a and b for a,b in pairs);fn=sum(a and not b for a,b in pairs)
 return dict(n=len(pairs),correct=tp+tn,accuracy=(tp+tn)/len(pairs),ci95=ci(tp+tn,len(pairs)),tp=tp,tn=tn,fp=fp,fn=fn,precision=tp/(tp+fp) if tp+fp else None,recall=tp/(tp+fn) if tp+fn else None,specificity=tn/(tn+fp) if tn+fp else None,f1=2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None)
def resources(name,kind):
 values=rows(ROOT/f'{name}-{kind}-resources.jsonl')
 return {'rss_sampled_peak_bytes':max(v.get('memory',{}).get('VmRSS',0) for v in values),'rss_high_watermark_bytes':max(v.get('memory',{}).get('VmHWM',0) for v in values),'ion_fdinfo_lower_bound_peak_bytes':max(v.get('ion_lower_bound_bytes',0) for v in values),'same_sample_rss_plus_ion_peak_bytes':max(v.get('memory',{}).get('VmRSS',0)+v.get('ion_lower_bound_bytes',0) for v in values),'system_mem_available_min_bytes':min(v['mem_available_bytes'] for v in values),'temperature_max_C':max(max(v['temperatures_mC'].values(),default=0) for v in values)/1000,'sample_interval_seconds':.5}
def timings(records):
 return {k:{'median_ms':float(np.median([r['ms'][k] for r in records])),'mean_ms':float(np.mean([r['ms'][k] for r in records])),'p95_ms':float(np.quantile([r['ms'][k] for r in records],.95)),'min_ms':min(r['ms'][k] for r in records),'max_ms':max(r['ms'][k] for r in records)} for k in ['patchify','vision','text','head','total']}
result={};all_predictions={}
for name in ['vl','q35']:
 records=rows(ROOT/f'{name}-final-out.jsonl');assert len(records)==559
 assert all(math.isfinite(r['p_yes']) and 0<=r['p_yes']<=1 and all(math.isfinite(t) and t>=0 for t in r['ms'].values()) for r in records)
 labels={r['id']:r for r in rows(ROOT/f'{name}-labels.jsonl')};ref={r['id']:r for r in rows(ROOT/f'{name}-bf16.jsonl')}
 assert len({r['id'] for r in records})==len(records) and set(r['id'] for r in records)==set(ref)==set(labels)
 log=(ROOT/f'{name}-final.log').read_text();summary=[json.loads(l) for l in log.splitlines() if l.startswith('{"load_s"')][-1]
 item={'n':len(records),'load_seconds':summary['load_s'],'timings':timings(records),'resources':resources(name,'final'),'classification':conf(records,labels),'bf16_classification':conf([{'id':r['id'],'p_yes':ref[r['id']]['p_yes']} for r in records],labels),'bf16_agreement':{str(t):sum((r['p_yes']>=t)==(ref[r['id']]['p_yes']>=t) for r in records)/len(records) for t in [.3,.5,.7]},'bf16_flips_0_5':[r['id'] for r in records if (r['p_yes']>=.5)!=(ref[r['id']]['p_yes']>=.5)],'bpu_milliseconds':summary['bpu_ms'],'sequence_length':{'min':min(r['seq'] for r in records),'max':max(r['seq'] for r in records),'median':float(np.median([r['seq'] for r in records]))},'categories':{}}
 for kind in sorted(set(r['kind'] for r in labels.values())):
  subset=[r for r in records if labels[r['id']]['kind']==kind and labels[r['id']]['label'] is not None]
  if subset:item['categories'][kind]=conf(subset,labels)
 manifest=json.loads((ROOT/f'{name}-manifest.json').read_text())
 item['text_bpu_calls_median']=float(np.median([(math.ceil((r['seq']-1)/manifest['prefill'])+1)*len(manifest['text']) for r in records]))
 labelled=[r for r in records if labels[r['id']]['label'] is not None]
 gate=[r for r in labelled if r['p_yes']<=.05 or r['p_yes']>=.95]
 item['reference_gate_0_05_0_95']={'decided':len(gate),'coverage':len(gate)/len(labelled),'left_for_manual':len(labelled)-len(gate),'false_supported':sum(not labels[r['id']]['label'] and r['p_yes']>=.95 for r in gate),'false_rejected':sum(labels[r['id']]['label'] and r['p_yes']<=.05 for r in gate)}
 all_predictions[name]={r['id']:(r['p_yes']>=.5) for r in records}
 dialog=rows(ROOT/f'{name}-dialog-out.jsonl');assert len(dialog)==32
 evaluated=[]
 for r in dialog:
  answer=('是' if r['p_yes']>=.5 else '否') if r['answer_mode']=='yesno' else max(list(r['answer_mode']),key=lambda c:r['logits'][c])
  evaluated.append({**r,'predicted':answer,'correct':answer==r['expected']})
 item['dialog']={'n':len(dialog),'correct':sum(r['correct'] for r in evaluated),'accuracy':sum(r['correct'] for r in evaluated)/len(dialog),'cases':evaluated,'timings':timings(dialog),'resources':resources(name,'dialog'),'categories':{c:{'n':sum(r['category']==c for r in evaluated),'correct':sum(r['category']==c and r['correct'] for r in evaluated)} for c in sorted(set(r['category'] for r in evaluated))}}
 result[name]=item
labels={r['id']:r for r in rows(ROOT/'vl-labels.jsonl')}
only_vl=[i for i,l in labels.items() if l['label'] is not None and all_predictions['vl'][i]==l['label'] and all_predictions['q35'][i]!=l['label']]
only_q35=[i for i,l in labels.items() if l['label'] is not None and all_predictions['q35'][i]==l['label'] and all_predictions['vl'][i]!=l['label']]
b,c=len(only_vl),len(only_q35);n=b+c
result['paired']={'vl_only_correct':only_vl,'q35_only_correct':only_q35,'mcnemar_exact_two_sided_p':min(1.,2*sum(math.comb(n,k) for k in range(min(b,c)+1))/(2**n)) if n else 1.}
# Multiple questions may share one image. Bootstrap whole images, not individual
# questions, to describe sampling uncertainty without treating duplicates as independent.
image_groups={}
for i,l in labels.items():
 if l['label'] is not None:image_groups.setdefault(l['image'],[]).append(i)
groups=list(image_groups.values());counts=np.array([len(g) for g in groups])
rng=np.random.default_rng(20261026);indexes=rng.integers(0,len(groups),size=(10000,len(groups)))
denom=counts[indexes].sum(axis=1);boot={}
for name in ['vl','q35']:
 correct=np.array([sum(all_predictions[name][i]==labels[i]['label'] for i in group) for group in groups])
 boot[name]=correct[indexes].sum(axis=1)/denom
 result[name]['classification']['image_cluster_bootstrap_ci95']=[float(x) for x in np.quantile(boot[name],[.025,.975])]
result['paired']['image_cluster_bootstrap']={'images':len(groups),'replicates':10000,'seed':20261026,'accuracy_difference_vl_minus_q35_ci95':[float(x) for x in np.quantile(boot['vl']-boot['q35'],[.025,.975])]}
(ROOT/'comparison.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({name:{k:v for k,v in result[name].items() if k in ['n','load_seconds','classification','bf16_classification','bf16_agreement','resources']} for name in ['vl','q35']},ensure_ascii=False,indent=2))
