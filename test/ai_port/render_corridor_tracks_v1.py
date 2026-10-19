"""Render corridor tracking evidence for manual identity review (test-only, read-only inputs).

Reads the hardware-decoded NV12 frames and the stride-1 tracking report, writes:
  tracks-person.png  : per person track, 8 crops evenly over its lifetime (one row per ID)
  overview-NN.png    : 12 sampled frames per sheet with person boxes and IDs
"""
from pathlib import Path
import json,sys
import numpy as np
from PIL import Image,ImageDraw,ImageFont
W,H=1920,1080;FRAME=W*H*3//2
NV12=Path('/mnt/ainvr-ssd/analytics-validation/vpu-20261019-110028/hardware.nv12')
REPORT=Path(sys.argv[2] if len(sys.argv)>2 else '/home/sunrise/ainvr/test/results/analytics/corridor-bpu-tracking-full-stride1-v3.json')
OUT=Path(sys.argv[1]);OUT.mkdir(parents=True,exist_ok=True)
def frame(i):
  with NV12.open('rb') as f:
    f.seek(i*FRAME);b=np.frombuffer(f.read(FRAME),np.uint8)
  y=b[:W*H].reshape(H,W).astype(np.float32);uv=b[W*H:].reshape(H//2,W//2,2).astype(np.float32)
  u=uv[...,0].repeat(2,0).repeat(2,1)-128;v=uv[...,1].repeat(2,0).repeat(2,1)-128;y=(y-16)*1.164
  rgb=np.stack([y+1.596*v,y-.392*u-.813*v,y+2.017*u],-1)
  return Image.fromarray(np.clip(rgb,0,255).astype(np.uint8))
r={x['frame']['frame_index']:x for x in json.loads(REPORT.read_text())['results']}
tracks={}
for i,x in sorted(r.items()):
  for d in x['frame']['detections']:
    if d.get('track_id') and d['class_name']=='person':tracks.setdefault(d['track_id'].split(':')[-1],[]).append((i,d['bbox']))
COL=[(255,60,60),(60,200,60),(60,120,255),(255,200,0),(255,0,255),(0,220,220),(255,140,0),(160,80,255)]
color={t:COL[k%len(COL)] for k,t in enumerate(sorted(tracks,key=int))}
font=ImageFont.load_default()
def big(size):
  for name in ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf','DejaVuSans.ttf'):
    try:return ImageFont.truetype(name,size)
    except OSError:pass
  return font
# 1. identity strips
rows=sorted(tracks,key=int);cw,chh=160,240
sheet=Image.new('RGB',(60+8*cw,len(rows)*chh),(30,30,30));d=ImageDraw.Draw(sheet)
for ri,t in enumerate(rows):
  v=tracks[t];picks=[v[int(k*(len(v)-1)/7)] for k in range(8)]
  d.text((5,ri*chh+5),f'ID {t}',fill=color[t],font=font)
  for ci,(fi,b) in enumerate(picks):
    pad=10;box=(max(0,b['x']-pad),max(0,b['y']-pad),min(W,b['x']+b['w']+pad),min(H,b['y']+b['h']+pad))
    crop=frame(fi).crop(tuple(int(z) for z in box));crop.thumbnail((cw-4,chh-20))
    sheet.paste(crop,(60+ci*cw,ri*chh+2));d.text((60+ci*cw,ri*chh+chh-16),f'f{fi}',fill=(220,220,220),font=font)
sheet.save(OUT/'tracks-person.png')
# 2. overview sheets
samples=[i for i in sorted(r) if 40<=i<480][::2] if len(r)<499 else list(range(40,480,8));tw,th=480,270
for s in range(0,len(samples),12):
  part=samples[s:s+12];sh=Image.new('RGB',(4*tw,3*th),(0,0,0))
  for k,fi in enumerate(part):
    im=frame(fi);dd=ImageDraw.Draw(im)
    for d2 in r[fi]['frame']['detections']:
      if d2['class_name']!='person':continue
      b=d2['bbox'];t=(d2.get('track_id') or '').split(':')[-1];c=color.get(t,(255,255,255))
      dd.rectangle([b['x'],b['y'],b['x']+b['w'],b['y']+b['h']],outline=c,width=6)
      dd.rectangle([b['x'],b['y']-40,b['x']+150,b['y']],fill=c);dd.text((b['x']+6,b['y']-36),f'#{t or "-"}',fill=(0,0,0),font=big(32))
    dd.text((10,10),f'frame {fi}',fill=(255,255,0),font=big(40))
    sh.paste(im.resize((tw,th)),((k%4)*tw,(k//4)*th))
  sh.save(OUT/f'overview-{s//12:02d}.png')
print(json.dumps({t:[tracks[t][0][0],tracks[t][-1][0],len(tracks[t])] for t in rows}))
