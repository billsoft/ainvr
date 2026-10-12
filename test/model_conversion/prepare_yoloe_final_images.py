"""AINVR deterministic unseen COCO images; offline CPU reference preparation.

Select before inference, exclude all old calibration/tuning identities and
source hashes, retain GT labels, preserve the original 640 RGB preprocessing.
"""
import argparse,hashlib,json,random
from pathlib import Path
import numpy as np
from PIL import Image
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--images',type=Path,required=True)
p.add_argument('--labels',type=Path,required=True)
p.add_argument('--previous',type=Path,required=True)
p.add_argument('--prepared',type=Path,required=True)
p.add_argument('--oracle',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();assert not a.output.exists()
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
old=json.loads(a.previous.read_text());excluded={x['source'] for x in old['items']};hashes={x['source_sha256'] for x in old['items']}
rng=random.Random(2026101303);files=sorted(a.images.glob('*.jpg'));rng.shuffle(files)
candidates=[]
for path in files:
    if path.name in excluded:continue
    label=a.labels/(path.stem+'.txt')
    if not label.exists():continue
    rows=[list(map(float,line.split())) for line in label.read_text().splitlines() if line.strip()]
    assert all(len(x)==5 and x[0]==int(x[0]) and 0<=x[0]<80 and all(0<=v<=1 for v in x[1:]) for x in rows)
    if rows:candidates.append((path,rows,set(int(x[0]) for x in rows)))
    if len(candidates)==4096:break
selected=[];remaining=candidates.copy();uncovered=set().union(*(x[2] for x in candidates))
while uncovered and len(selected)<128:
    item=max(remaining,key=lambda x:len(x[2]&uncovered));selected.append(item);remaining.remove(item);uncovered-=item[2]
selected+=remaining[:128-len(selected)]
assert len(selected)==128
a.output.mkdir();images=a.output/'validation';images.mkdir();prompts=a.output/'detector-prompts-validation';prompts.mkdir()
base=json.loads((a.prepared/'manifest.json').read_text());oracle=np.load(a.oracle);vectors=oracle['prompt_embeddings'];names=oracle['class_names']
items=[x for x in base['samples'] if x['split']=='calibration'];assert len(items)==512
all_rows=[];seen=set();coverage=set()
for i,(path,labels,classes) in enumerate(selected):
    digest=sha(path);assert digest not in hashes and digest not in seen,path;seen.add(digest);coverage|=classes
    with Image.open(path) as image:
        image=image.convert('RGB');w,h=image.size;scale=min(640/w,640/h);nw,nh=round(w*scale),round(h*scale)
        canvas=Image.new('RGB',(640,640),(114,114,114));canvas.paste(image.resize((nw,nh),Image.Resampling.BILINEAR),((640-nw)//2,(640-nh)//2))
        tensor=np.ascontiguousarray(np.asarray(canvas,dtype=np.float32).transpose(2,0,1)[None]/255)
    imagefile=images/(path.stem+'.bin');tensor.tofile(imagefile)
    chosen=sorted(classes);rng.shuffle(chosen);chosen=chosen[:8]
    negatives=list(set(range(80))-set(chosen));rng.shuffle(negatives);chosen=(chosen+negatives)[:8]
    active=8 if i%4 else 1+i%7
    value=np.zeros((1,8,512),np.float32);value[:,:active]=vectors[:,chosen[:active]]
    promptfile=prompts/(path.stem+'.bin');value.tofile(promptfile)
    item={'split':'validation','image_tensor':imagefile.name,'image_sha256':sha(imagefile),
          'prompt_file':str(promptfile.relative_to(a.output)).replace('\\','/'),'prompt_sha256':sha(promptfile),
          'class_ids':chosen,'class_names':[str(names[x]) for x in chosen],'active_count':active,'source_classes':sorted(classes)}
    items.append(item);all_rows.append({'source':path.name,'source_sha256':digest,'shape':[w,h],'labels':labels,**item})
    if i%32==0:print('prepared',i,flush=True)
base.update(samples=items,scope='Preselected unseen images, original FP32 prompt oracle; no inference-based selection',
            final_image_holdout=True,previous_image_overlap=0,previous_source_hash_overlap=0,
            selection_seed=2026101303,classes_covered=sorted(coverage),production_approved=False)
(a.output/'manifest.json').write_text(json.dumps(base,indent=2))
(a.output/'ground-truth.json').write_text(json.dumps({'scope':'128 independent original YOLO-format labels','items':all_rows},indent=2))
print(json.dumps({'samples':128,'classes_covered':len(coverage),'source_hash_overlap':0,'manifest_sha256':sha(a.output/'manifest.json')}))
