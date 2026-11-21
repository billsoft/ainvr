"""Offline ground truth and JPEG fixtures only. Run from the repository root."""
import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OLD = ROOT / 'test/results/scene-matching-20261121'
W, H = 512, 384
I = np.eye(3)


def rect(x, y, r, b):
    return [[x, y], [r, y], [r, b], [x, b]]


def make(out, small_foreground=False):
    out.mkdir()
    fixtures = out / 'fixtures'
    fixtures.mkdir()
    cv2.setNumThreads(1)
    scene = cv2.resize(cv2.imread(str(OLD / 'camera-before.jpg')), (W, H), interpolation=cv2.INTER_AREA)
    cabinet = json.loads((OLD / 'live-before.json').read_text())['manual'][0]['document']['zones'][0]['points']
    upper = json.loads((OLD / 'rebound-before-restart.json').read_text())['manual'][0]['document']['zones'][0]['points']
    middle = rect(.35, .36, .56, .55)
    tiny = rect(.39, .38, .412, .406)
    cases = []

    def label(name, polygon, policy='visible', matrix=I):
        return dict(name=name, polygon=polygon, policy=policy,
                    oracleH=matrix.tolist() if matrix is not None else None)

    def save(image):
        ok, data = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 94])
        assert ok
        body = data.tobytes()
        name = hashlib.sha256(body).hexdigest() + '.jpg'
        if not (fixtures / name).exists():
            (fixtures / name).write_bytes(body)
        return name

    def add(name, a, b, labels, category):
        cases.append(dict(name=name, category=category, reference=save(a), current=save(b), regions=labels))

    def regions(matrix):
        return [label(name, poly, matrix=matrix) for name, poly in [('center', middle), ('cabinet', cabinet), ('upper', upper)]]

    def warp(a, matrix):
        return cv2.warpPerspective(a, matrix, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)

    def shift(x, y):
        return np.array([[1., 0, x], [0, 1., y], [0, 0, 1.]])

    for name, matrix in [('identity', I), ('translate8', shift(8, -4)), ('translate_diag', shift(16,16)), ('translate24', shift(-24, 12)),
                         ('zoom085', np.vstack([cv2.getRotationMatrix2D((W/2,H/2), 0, .85), [0,0,1]])),
                         ('roll5', np.vstack([cv2.getRotationMatrix2D((W/2,H/2), 5, 1), [0,0,1]])),
                         ('zoom115', np.vstack([cv2.getRotationMatrix2D((W/2,H/2), 0, 1.15), [0,0,1]])),
                         ('projective', np.array(json.loads((OLD/'oracle.json').read_text())['homography_pixels']))]:
        add(name, scene, warp(scene,matrix), regions(matrix), 'geometry')

    for name, gain, offset in [('bright', 1.08, 10), ('washed', .70, 42), ('dim', .76, 0), ('dark', .46, 0)]:
        image = np.clip(scene.astype(float)*gain+offset, 0, 255).astype('uint8')
        add(name, scene, image, regions(I), 'exposure')

    # Known fully occluded reference features. Negative ROI is strictly inside the mask.
    for name, box, hidden in [('occlude_center', (150,115,318,245),middle),
                              ('occlude_tiny', (197,143,215,159),tiny),
                              ('occlude_lower', (0,228,W,H),rect(.36,.66,.55,.78))]:
        b = scene.copy()
        x,y,r,bot=box
        b[y:bot,x:r] = 112
        other = middle if name=='occlude_lower' else upper
        add(name, scene, b, [label('hidden',hidden,'reject',None),label('visible',other)], 'occlusion')

    # The central patch translates independently; the surrounding plane stays stationary.
    for dx in [4,8,20]:
        b = scene.copy()
        b[110:252,140:330] = warp(scene,shift(dx,0))[110:252,140:330]
        add('two_planes_'+str(dx),scene,b,[label('moving_plane',middle,'reject_wrong_plane',shift(dx,0)),
                                          label('static_plane',upper)], 'parallax')
    flat = np.full_like(scene, 122)
    ramp = np.broadcast_to(np.linspace(88,134,W,dtype=np.uint8)[None,:,None],scene.shape).copy()
    for name,img in [('flat',flat),('smooth_gradient',ramp)]:
        add(name,img,img,[label('no_identifiable_features',middle,'reject',None)],'low_texture')
    for name in ['Mirror_by_Uday_Nakade','Blue_flower_by_Elena_Stravoravdi']:
        src = cv2.imread('/usr/share/backgrounds/'+name+'.jpg')
        target = cv2.resize(src,(W,H),interpolation=cv2.INTER_AREA)
        add('unrelated_'+name,scene,target,[label('center',middle,'reject',None),
                                           label('cabinet',cabinet,'reject',None)],'unrelated')
    add('unrelated_flat_current',scene,flat,[label('center',middle,'reject',None)],'unrelated')
    # An opaque band just outside each target stresses coarse cell spillover.
    b=scene.copy()
    b[:,473:]=112
    add('occlude_outside_cabinet',scene,b,[label('cabinet',cabinet),label('upper',upper)],'occlusion')
    rng=np.random.default_rng(58173)
    permutation=rng.permutation(48)
    shuffled=scene.copy()
    for dest,src in enumerate(permutation):
        y,x=divmod(dest,8); sy,sx=divmod(int(src),8)
        shuffled[y*64:y*64+64,x*64:x*64+64]=scene[sy*64:sy*64+64,sx*64:sx*64+64]
    add('shuffled_tiles',scene,shuffled,[label('no_shared_plane',middle,'reject',None)],'unrelated')
    # Exact periodic shift is observationally ambiguous. Preserve latent physical displacement.
    for period in [32,64]:
        tile=scene[96:96+period,160:160+period]
        periodic=np.tile(tile,(H//period,W//period,1))
        add('periodic_shift_'+str(period),periodic,np.roll(periodic,period,axis=1),
            [label('ambiguous_copy',middle,'reject_wrong_plane',shift(period,0))],'periodic')
    if small_foreground:
        # Add a genuinely moving textured foreground on a static background.
        # All three reference polygons and their translated targets lie inside
        # the same 64x64 reference cell in 512x384 space (column 3, row 2).
        cases.clear()
        for size,dx in [(8,22),(16,22),(24,18)]:
            x,y=199,147
            patch=scene[96:96+size,160:160+size].copy()
            patch[::3,::3]=[10,225,245]
            a=scene.copy()
            b=scene.copy()
            a[y:y+size,x:x+size]=patch
            b[y:y+size,x+dx:x+dx+size]=patch
            poly=rect((x+1)/W,(y+1)/H,(x+size-1)/W,(y+size-1)/H)
            add('single_cell_foreground_'+str(size),a,b,[label('moving_foreground',poly,'reject_wrong_plane',shift(dx,0)),
                label('stable_cabinet',upper)],'subcell_parallax')
            cases[-1]['fixtureTruth']=dict(cell=19,boxXYWH=[x,y,size,size],dx=dx,dy=0,
                nativeLatticeInsideBox=sum(x<=sx<x+size and y<=sy<y+size
                    for sx in range(12,W-12,12) for sy in range(12,H-12,12)))
        used={c[k] for c in cases for k in ('reference','current')}
        for f in fixtures.glob('*.jpg'):
            if f.name not in used:
                f.unlink()
    manifest=dict(schema=1,width=W,height=H,source='test/results/scene-matching-20261121/camera-before.jpg',
                  sourceSha256=hashlib.sha256((OLD/'camera-before.jpg').read_bytes()).hexdigest(),
                  oracle='CPU-generated JPEG inputs and known pixel homographies; no CPU inference',
                  maxVertexErrorPx=2.5,cases=cases)
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(f'{len(cases)} pairs, {sum(len(c["regions"]) for c in cases)} labeled polygons')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=Path)
    parser.add_argument('--small-foreground',action='store_true')
    args=parser.parse_args()
    make(args.output,args.small_foreground)
