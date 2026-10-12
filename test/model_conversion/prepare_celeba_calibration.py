"""AINVR offline CelebA calibration for face detection and GPEN256.

Uses official train/validation partitions and annotated face boxes. CPU image
operations are compiler preparation only, never a production fallback.
"""
import argparse
import hashlib
import json
import random
from pathlib import Path
import numpy as np
from PIL import Image

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args(); a.output.mkdir(parents=True,exist_ok=False)
boxes={}
for line in (a.root/'Anno/list_bbox_celeba.txt').read_text().splitlines()[2:]:
    parts=line.split(); boxes[parts[0]]=list(map(int,parts[1:]))
groups={0:[],1:[]}
for line in (a.root/'Eval/list_eval_partition.txt').read_text().splitlines():
    name,partition=line.split()
    if int(partition) in groups: groups[int(partition)].append(name)
rng=random.Random(20261012)
for names in groups.values(): rng.shuffle(names)
manifest={'dataset':str(a.root.resolve()),'seed':20261012,'partition':'official 0=train 1=validation',
          'face_input':'RGB NCHW float32 0..1, 640 square bilinear letterbox fill114',
          'gpen_input':'RGB NCHW float32 -1..1, annotated square face crop; bicubic down/up sampling',
          'gpen_crop_contract_verified':False,'accuracy_validated':False,'items':[]}
hashes={0:set(),1:set()}
for partition,count,split in [(0,512,'calibration'),(1,128,'validation')]:
    for model in ['face','gpen256']: (a.output/model/split).mkdir(parents=True)
    kept=0
    for name in groups[partition]:
        path=a.root/'Img/img_celeba'/name
        with Image.open(path) as img:
            img=img.convert('RGB'); w,h=img.size
            x,y,bw,bh=boxes[name]
            if bw<32 or bh<32: continue
            side=max(bw,bh); cx=x+bw/2; cy=y+bh/2
            left=max(0,int(cx-side/2)); top=max(0,int(cy-side/2))
            right=min(w,int(cx+side/2)); bottom=min(h,int(cy+side/2))
            if right-left<32 or bottom-top<32: continue
            crop=img.crop((left,top,right,bottom))
            # Vary source resolution to represent enhancement inputs; keep a
            # reference crop so quality can be checked independently later.
            low_size=[48,64,96,128,192,224][kept%6]
            crop.thumbnail((low_size,low_size),Image.Resampling.BICUBIC)
            scale=min(256/crop.width,256/crop.height)
            nw,nh=round(crop.width*scale),round(crop.height*scale)
            restored_input=Image.new('RGB',(256,256),(128,128,128))
            restored_input.paste(crop.resize((nw,nh),Image.Resampling.BICUBIC),((256-nw)//2,(256-nh)//2))
            gpen=np.ascontiguousarray(np.asarray(restored_input,dtype=np.float32).transpose(2,0,1)[None]/127.5-1)
            scale=min(640/w,640/h); nw,nh=round(w*scale),round(h*scale)
            canvas=Image.new('RGB',(640,640),(114,114,114))
            canvas.paste(img.resize((nw,nh),Image.Resampling.BILINEAR),((640-nw)//2,(640-nh)//2))
            face=np.ascontiguousarray(np.asarray(canvas,dtype=np.float32).transpose(2,0,1)[None]/255)
        digest=hashlib.sha256(path.read_bytes()).hexdigest(); hashes[partition].add(digest)
        item={'source':name,'source_sha256':digest,'split':split,'bbox':boxes[name],
              'crop_xyxy':[left,top,right,bottom],'gpen_low_size':low_size,'tensors':{}}
        for model,arr in [('face',face),('gpen256',gpen)]:
            target=a.output/model/split/(Path(name).stem+'.bin'); arr.tofile(target)
            item['tensors'][model]={'path':str(target.relative_to(a.output)),
                                   'sha256':hashlib.sha256(arr.tobytes()).hexdigest()}
        manifest['items'].append(item); kept+=1
        if kept%64==0: print(split,kept,flush=True)
        if kept==count: break
    assert kept==count
assert not hashes[0]&hashes[1]
(a.output/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print('Complete: 512 calibration + 128 validation for each model',flush=True)
