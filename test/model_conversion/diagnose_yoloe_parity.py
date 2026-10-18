"""Diagnose YOLOE parity mismatches without changing acceptance thresholds."""
import argparse, ast, json
from pathlib import Path
from collections import Counter
import numpy as np
from scipy.optimize import linear_sum_assignment
p=argparse.ArgumentParser()
p.add_argument('--reference',type=Path,required=True)
p.add_argument('--actual',type=Path,required=True)
p.add_argument('--compare-script',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
assert not a.output.exists()
r=json.loads((a.reference/'manifest.json').read_text())
g=json.loads((a.actual/'manifest.json').read_text())
slots=r.get('prompt_slots',8)
assert slots==g.get('prompt_slots',8)
assert r['prepared_manifest_sha256']==g['prepared_manifest_sha256']
# Reuse the exact production-parity decoder, without running its CLI.
tree=ast.parse(a.compare_script.read_text())
ns={'np':np,'slots':slots}
nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('iou','decode')]
assert len(nodes)==2
exec(compile(ast.Module(body=nodes,type_ignores=[]),str(a.compare_script),'exec'),ns)
decode,iou=ns['decode'],ns['iou']
items={s['id']:s for s in g['samples']}
extra=[];missing=[];counts=Counter(); classes=Counter()
for m in r['samples']:
    key=m['id']; n=items[key]
    assert m['class_ids']==n['class_ids']
    xr=np.load(a.reference/(key+'.npz'))['output']
    yr=np.load(a.actual/(key+'.npz'))['output']
    x,y=decode(xr,m),decode(yr,n)
    ix=set(); iy=set()
    if len(x) and len(y):
        ov=iou(x,y); same=x[:,None,5]==y[None,:,5]
        ii,jj=linear_sum_assignment(1-ov+1000*(~same))
        for i,j in zip(ii,jj):
            if same[i,j] and ov[i,j]>=.5:ix.add(int(i));iy.add(int(j))
    raw=xr[0].T.astype(np.float64)
    boxes=np.column_stack((raw[:,:2]-raw[:,2:4]/2,raw[:,:2]+raw[:,2:4]/2))
    for j in set(range(len(y)))-iy:
        cid=int(y[j,5]); slot=m['class_ids'].index(cid); label=m['class_names'][slot]
        overlap=iou(y[j:j+1],boxes)[0]
        eligible=overlap>=.5
        score=float(raw[eligible,4+slot].max()) if eligible.any() else None
        reason='no_overlap' if score is None else ('threshold_crossing' if score<.25 else 'nms_or_geometry')
        counts[reason]+=1;classes[label]+=1
        extra.append({'image':key,'class':label,'actual_score':float(y[j,4]),'reference_best_overlapping_raw_score':score,'reason':reason})
    for i in set(range(len(x)))-ix:
        slot=m['class_ids'].index(int(x[i,5]))
        missing.append({'image':key,'class':m['class_names'][slot],'reference_score':float(x[i,4])})
out={'diagnostic_only':True,'actual_hbm_sha256':g['model_sha256'],'samples':len(items),
     'extra_count':len(extra),'missing_count':len(missing),'extra_reasons':dict(counts),
     'extra_by_class':dict(classes.most_common()),'extra':extra,'missing':missing,
     'note':'Raw-overlap diagnosis is not ground truth and cannot approve a model or adjust gates.'}
a.output.write_text(json.dumps(out,indent=2))
print(json.dumps({k:v for k,v in out.items() if k not in ('extra','missing')},indent=2))
