"""AINVR AP50 on the user's YOLO-box validation subset (not official COCO mAP)."""
import argparse
import json
from pathlib import Path
import numpy as np

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--predictions',type=Path,required=True)
p.add_argument('--dataset-manifest',type=Path,required=True)
p.add_argument('--labels',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args(); assert not a.output.exists()
manifest=json.loads(a.dataset_manifest.read_text(encoding='utf-8'))
items=[x for x in manifest['items'] if x['split']=='validation']; assert len(items)==128
reference=json.loads((a.predictions/'manifest.json').read_text())
input_hashes={x['id']:x['input_sha256'] for x in reference['samples']}
ground={}; predictions={c:[] for c in range(80)}; max_class_error=0
for item in items:
    name=Path(item['source']).stem
    assert input_hashes[name]==item['tensor_sha256']
    w,h=item['shape']; scale=min(640/w,640/h); nw,nh=round(w*scale),round(h*scale)
    left,top=(640-nw)//2,(640-nh)//2
    groups={c:[] for c in range(80)}
    for line in (a.labels/(name+'.txt')).read_text().splitlines():
        c,cx,cy,bw,bh=map(float,line.split()); c=int(c)
        groups[c].append([(cx-bw/2)*nw+left,(cy-bh/2)*nh+top,
                          (cx+bw/2)*nw+left,(cy+bh/2)*nh+top])
    ground[name]={c:np.asarray(boxes,dtype=np.float64).reshape(-1,4) for c,boxes in groups.items()}
    values=np.load(a.predictions/(name+'.npz'))['0']; assert values.shape==(1,300,6)
    for row in values[0]:
        if row[4]<.001: continue
        cls=int(round(float(row[5]))); error=abs(float(row[5])-cls)
        max_class_error=max(max_class_error,error)
        assert 0<=cls<80 and error<.05 and np.isfinite(row).all()
        predictions[cls].append((float(row[4]),name,row[:4].astype(np.float64)))
aps={}; counts={}
for c in range(80):
    count=sum(len(g[c]) for g in ground.values()); counts[c]=count
    if not count: continue
    used={name:set() for name in ground}; tp=[]; fp=[]
    for score,name,box in sorted(predictions[c],key=lambda x:x[0],reverse=True):
        targets=ground[name][c]; matched=False
        if len(targets):
            inter=np.maximum(0,np.minimum(targets[:,2:],box[2:])-np.maximum(targets[:,:2],box[:2])).prod(1)
            union=np.maximum(0,targets[:,2:]-targets[:,:2]).prod(1)+np.maximum(0,box[2:]-box[:2]).prod()-inter
            overlap=inter/np.maximum(union,1e-12)
            j=int(np.argmax(overlap))
            if overlap[j]>=.5 and j not in used[name]: used[name].add(j); matched=True
        tp.append(int(matched)); fp.append(int(not matched))
    if not tp: aps[c]=0.; continue
    cum_tp=np.cumsum(tp); recall=cum_tp/count; precision=cum_tp/np.maximum(cum_tp+np.cumsum(fp),1)
    aps[c]=float(np.mean([precision[recall>=r].max(initial=0) for r in np.linspace(0,1,101)]))
report={'metric':'101-point interpolated AP at IoU 0.50 on user YOLO labels; no crowd/area metadata; not official COCO mAP',
        'images':len(items),'classes_with_ground_truth':len(aps),'ap50':float(np.mean(list(aps.values()))),
        'class_ap50':aps,'ground_truth_counts':counts,'max_class_fractional_error':max_class_error,
        'predictions':str(a.predictions),'production_approved':False}
a.output.write_text(json.dumps(report,indent=2))
print(json.dumps({k:report[k] for k in ['images','classes_with_ground_truth','ap50','max_class_fractional_error']}))
