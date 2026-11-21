"""Independent labeled challenge inputs; CPU fixture and coordinate oracle only."""
import hashlib
import json
from pathlib import Path
import sys
import cv2
import numpy as np

W,H=512,384
cv2.setNumThreads(1)
dest=Path(sys.argv[1])
dest.mkdir()
fixtures=dest/'fixtures'
fixtures.mkdir()
rng=np.random.default_rng(4219)
scene=cv2.imread('test/results/scene-matching-20261121/camera-before.jpg')
scene=cv2.resize(scene,(W,H),interpolation=cv2.INTER_AREA)
other=cv2.resize(cv2.imread('/usr/share/backgrounds/Mirror_by_Uday_Nakade.jpg'),(W,H),interpolation=cv2.INTER_AREA)
identity=np.eye(3)
cases=[]


def save(image):
    ok,b=cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,91])
    assert ok
    name=hashlib.sha256(b).hexdigest()+'.jpg'
    (fixtures/name).write_bytes(b)
    return name


def shift(dx,dy):
    return np.array([[1,0,dx],[0,1,dy],[0,0,1.]])


def roi(name,x,y,w,h,policy,m):
    return dict(name=name,polygon=[[x/W,y/H],[(x+w)/W,y/H],[(x+w)/W,(y+h)/H],[x/W,(y+h)/H]],
                policy=policy,oracleH=None if m is None else m.tolist())


def add(name,a,b,regions):
    cases.append(dict(name=name,category='independent',reference=save(a),current=save(b),regions=regions))


stable=roi('unchanged',270,80,90,88,'visible',identity)
for i,(size,dx,dy) in enumerate([(11,17,9),(29,-16,11),(45,20,-14)]):
    x,y=97,175
    layer=rng.integers(25,232,(size,size,3),dtype=np.uint8)
    a=scene.copy();b=scene.copy()
    a[y:y+size,x:x+size]=layer
    b[y+dy:y+dy+size,x+dx:x+dx+size]=layer
    add('independent_layer_'+str(size),a,b,[roi('layer',x+1,y+1,size-2,size-2,'reject_wrong_plane',shift(dx,dy)),stable])
a=scene.copy();b=scene.copy()
b[179:207,152:182]=other[179:207,152:182]
add('opaque_textured_replacement',a,b,[roi('absent',153,180,27,25,'reject',None),stable])
# Two visually identical copies in otherwise non-periodic surroundings change physical identity.
a=scene.copy()
patch=scene[112:192,160:240].copy()
for x in (64,352):
    a[256:336,x:x+80]=patch
add('local_twin_swap',a,a.copy(),[roi('twin',76,268,56,56,'reject_wrong_plane',shift(288,0)),stable])
for name,pw,ph,dx,dy in [('vertical_period',59,48,0,48),('diagonal_period',39,31,39,31)]:
    tile=scene[99:99+ph,170:170+pw]
    a=np.tile(tile,((H+ph-1)//ph,(W+pw-1)//pw,1))[:H,:W]
    b=np.clip(a.astype(int)+8,0,255).astype('uint8')
    add(name,a,b,[roi('periodic_copy',137,109,103,95,'reject_wrong_plane',shift(dx,dy))])
for name,src,m in [('second_scene_translation',other,shift(9,-7)),
                   ('camera_new_affine',scene,np.array([[1.018,.012,-4],[-.012,1.018,5],[0,0,1]]))]:
    b=cv2.warpPerspective(src,m,(W,H))
    add(name,src,b,[roi('region_one',130,92,99,86,'visible',m),roi('region_two',270,161,85,96,'visible',m)])
(dest/'manifest.json').write_text(json.dumps(dict(width=W,height=H,maxVertexErrorPx=2.5,cases=cases),indent=2)+'\n')
