#!/usr/bin/env python3
"""Fisheye -> ERP through S100 dedicated GDC CUSTOM grids, without GPU calls."""
import argparse
import fcntl
import json
import math
import time
from pathlib import Path
import cv2
import numpy as np
from common import Experiment, ROOT, SDK, digest, records


def radial(theta, model, coefficients):
    if model == "equidistant":
        t2 = theta*theta
        k1, k2, k3, k4 = coefficients
        return theta*(1+t2*(k1+t2*(k2+t2*(k3+t2*k4))))
    if model == "equisolid":
        return 2*np.sin(theta/2)
    if model == "stereographic":
        return 2*np.tan(theta/2)
    return np.sin(theta)


def mapping(a, ow, oh, xs=None, ys=None, allow_grid_boundary=False):
    """ERP pixel center -> unit sphere -> ideal/calibrated radial fisheye."""
    xs = np.arange(ow) if xs is None else xs
    ys = np.arange(oh) if ys is None else ys
    longitude = ((xs+.5)/ow-.5)*math.radians(a.hfov)
    latitude = (.5-(ys+.5)/oh)*math.radians(a.vfov)
    dx = np.cos(latitude[:, None])*np.sin(longitude[None, :])
    dy = np.broadcast_to(np.sin(latitude[:, None]), dx.shape)
    dz = np.cos(latitude[:, None])*np.cos(longitude[None, :])
    theta = np.arctan2(np.hypot(dx, dy), dz)
    if not allow_grid_boundary and np.max(theta) > math.radians(a.lens_fov/2)+1e-9:
        raise ValueError("ERP requests rays outside this lens: use a smaller crop or another camera")
    focal = a.radius / radial(math.radians(a.lens_fov/2), a.lens_model, a.coefficients)
    r = focal*radial(theta, a.lens_model, a.coefficients)
    q = np.hypot(dx, dy)
    factor = np.divide(r, q, out=np.zeros_like(r), where=q>1e-12)
    return a.cx+factor*dx, a.cy-factor*dy


def input_image(a, path):
    if a.input:
        data = Path(a.input).read_bytes()
        if len(data) != a.width*a.height*3//2:
            raise ValueError("Input must be tightly packed NV12 with specified dimensions")
        path.write_bytes(data)
        return
    # A longitude/latitude-coded ideal equidistant fisheye. ERP should straighten
    # the coordinate ramps; U and V both vary, so chroma processing is checked.
    if a.lens_model != "equidistant" or any(a.coefficients):
        raise ValueError("Synthetic analytic scene requires ideal equidistant lens; supply --input for other models")
    focal = a.radius/math.radians(a.lens_fov/2)
    def world(x, y):
        xx, yy = x[None, :]-a.cx, a.cy-y[:, None]
        distance = np.hypot(xx, yy)
        theta = distance/focal
        scale = np.divide(np.sin(theta), distance, out=np.full_like(distance, 1/focal), where=distance>1e-12)
        longitude = np.arctan2(xx*scale, np.cos(theta))
        latitude = np.arcsin(np.clip(yy*scale, -1, 1))
        return longitude, latitude, distance <= a.radius
    lon, lat, valid = world(np.arange(a.width), np.arange(a.height))
    y = np.where(valid, np.clip(np.rint(16+219*(lon/math.pi+.5)), 16, 235), 16).astype(np.uint8)
    lon, lat, valid = world(np.arange(a.width//2)*2, np.arange(a.height//2)*2)
    u = np.where(valid, np.rint(16+219*(lat/math.pi+.5)), 128).astype(np.uint8)
    v = np.where(valid, np.rint(128+70*np.sin(4*lon)*np.cos(3*lat)), 128).astype(np.uint8)
    path.write_bytes(y.tobytes()+np.stack([u, v], axis=-1).tobytes())
    cv2.imwrite(str(path.with_suffix('.png')), y)


def nv12(path, w, h):
    b = np.fromfile(path, np.uint8)
    if b.size != w*h*3//2:
        raise RuntimeError(f"Incomplete NV12: {path}")
    return b[:w*h].reshape(h, w), b[w*h:].reshape(h//2, w//2, 2)


def reference(a, input_path, x, y):
    src_y, src_uv = nv12(input_path, a.width, a.height)
    # GDC uses the luma map at even output locations for co-sited NV12 chroma.
    out_y = cv2.remap(src_y, x.astype(np.float32), y.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    out_uv = cv2.remap(src_uv, (x[::2, ::2]/2).astype(np.float32), (y[::2, ::2]/2).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return out_y, out_uv


def validate(a, directory, iw, ih, ow, oh, x, y, projection):
    expected = reference(a, directory/'input.nv12', x, y)
    details = []
    for mode in ['shared_input', 'cpu_copy_and_flush']:
        for which in ['first', 'last']:
            path = directory/f'{mode}-{which}.nv12'
            actual = nv12(path, ow, oh)
            errors = []
            for got, ref in zip(actual, expected):
                # GDC's interpolation footprint touching source edges can be
                # black-filled. Identity checks the interior and reports borders.
                if projection == 'identity':
                    got, ref = got[2:-2, 2:-2], ref[2:-2, 2:-2]
                d = np.abs(got.astype(np.int16)-ref.astype(np.int16))
                m = {"mean_absolute_error": float(d.mean()), "p99_error": float(np.percentile(d, 99)), "max_error": int(d.max()),
                     "fraction_error_above_4":float(np.mean(d>4)),
                     "checked_scope":"2-pixel border excluded" if projection=='identity' else "full plane"}
                errors.append(m)
                if m['mean_absolute_error'] > 1.25 or m['p99_error'] > 4:
                    raise RuntimeError(f"GDC coordinate/pixel reference mismatch: {path}: {errors}")
            details.append({'path':str(path), 'sha256':digest(path), 'Y_UV_errors':errors})
    cv2.imwrite(str(directory/'gdc-erp.png'), actual[0])
    cv2.imwrite(str(directory/'cpu-reference.png'), expected[0])
    geometry = None
    if projection == 'erp' and not a.input:
        # Independent world-coordinate check, not just the grid used by GDC.
        ideal = 16+219*(((np.arange(ow)+.5)/ow-.5)*math.radians(a.hfov)/math.pi+.5)
        interior = np.hypot(x-a.cx, y-a.cy) < a.radius-4
        interior &= np.broadcast_to(np.abs((.5-(np.arange(oh)+.5)/oh)*a.vfov)[:, None] < 85, (oh, ow))
        delta = np.abs(actual[0].astype(float)-ideal[None, :])[interior]
        geometry = {'ERP_longitude_ramp_mae':float(delta.mean()), 'checked_pixels':int(delta.size)}
        latitude = (.5-(np.arange(oh//2)*2+.5)/oh)*math.radians(a.vfov)
        expected_u = 16+219*(latitude/math.pi+.5)
        delta_u = np.abs(actual[1][:,:,0].astype(float)-expected_u[:,None])[interior[::2,::2]]
        geometry['ERP_latitude_ramp_mae'] = float(delta_u.mean())
        if not delta.size or geometry['ERP_longitude_ramp_mae'] > 1.25 or geometry['ERP_latitude_ramp_mae'] > 1.25:
            raise RuntimeError(f"World longitude geometry failed: {geometry}")
    return {'outputs':details, 'world_geometry':geometry}


def run_case(exp, binary, projection):
    a = exp.args
    directory = exp.out/projection
    directory.mkdir()
    if projection == 'identity':
        ow, oh = a.width, a.height
        x, y = np.meshgrid(np.arange(ow, dtype=float), np.arange(oh, dtype=float))
        # Smooth Cartesian coordinates isolate lattice placement from the
        # synthetic fisheye disk's abrupt cutoff and hardware filter ringing.
        yy = np.broadcast_to(np.rint(16+219*np.arange(ow)/(ow-1)).astype(np.uint8), (oh,ow))
        uu = np.broadcast_to(np.rint(32+192*np.arange(oh//2)[:,None]/(oh//2-1)), (oh//2,ow//2))
        vv = np.broadcast_to(np.rint(128+64*np.sin(np.arange(ow//2)[None,:]*2*math.pi/ow)), uu.shape)
        (directory/'input.nv12').write_bytes(yy.tobytes()+np.stack([uu,vv],axis=-1).astype(np.uint8).tobytes())
    else:
        input_image(a, directory/'input.nv12')
        ow, oh = a.output_width, a.output_height
        x, y = mapping(a, ow, oh)
    assert np.isfinite(x).all() and np.isfinite(y).all()
    if x.min() < 0 or y.min() < 0 or x.max() > a.width-1 or y.max() > a.height-1:
        raise ValueError("Mapping exceeds source bounds")
    if projection == 'identity':
        gx, gy = np.meshgrid(np.arange(ow+1, dtype=float), np.arange(oh+1, dtype=float))
    else:
        gx, gy = mapping(a, ow, oh, np.arange(ow+1), np.arange(oh+1), allow_grid_boundary=True)
    points = np.stack([gx, gy], axis=-1).astype('<f8')
    points.tofile(directory/'map-xy-f64.bin')
    (directory/'projection.json').write_text(json.dumps({'projection':projection, 'input':[a.width,a.height],
         'output':[ow,oh], 'lens_model':a.lens_model, 'lens_fov':a.lens_fov, 'cx':a.cx, 'cy':a.cy,
         'radius':a.radius, 'coefficients':a.coefficients, 'ERP_hfov':a.hfov, 'ERP_vfov':a.vfov,
         'map_format':'little endian float64 XY, (OH+1)x(OW+1) endpoint lattice, coordinates in input pixels'}, indent=2))
    text, seconds = exp.command([binary,a.width,a.height,ow,oh,a.frames,directory/'map-xy-f64.bin',
                                 directory/'input.nv12',a.tile_step], projection, cwd=directory)
    rows = records(text)
    metrics = [r for r in rows if r.get('event')=='gdc_erp_measurement']
    if len(metrics)!=2 or any(r['completed_frames']!=a.frames or r['fps']<=0 or r['hardware']!='HB_GDC:0' for r in metrics):
        raise RuntimeError("GDC completed-frame evidence missing")
    return {'measurements':metrics, 'config':[r for r in rows if r.get('event')=='gdc_config'],
            'validation':validate(a,directory,a.width,a.height,ow,oh,x,y,projection),
            'mapping_sha256':digest(directory/'map-xy-f64.bin'), 'bin_sha256':digest(directory/'gdc-erp.bin'),
            'native_sha256':digest(ROOT/'native/gdc_erp_probe.c'), 'python_sha256':digest(__file__), 'process_wall_seconds':seconds,
            'scope':'dedicated GDC; static precomputed mapping; no GPU, decode, streaming, calibration or stitched 360 pipeline'}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--width',type=int,default=1920)
    p.add_argument('--height',type=int,default=1080)
    p.add_argument('--output-width',type=int,default=1920)
    p.add_argument('--output-height',type=int,default=960)
    p.add_argument('--frames',type=int,default=60)
    p.add_argument('--timeout',type=int,default=180)
    p.add_argument('--tile-step',type=int,default=8)
    p.add_argument('--projections',nargs='+',choices=['identity','erp'],default=['identity','erp'])
    p.add_argument('--hfov',type=float,default=160)
    p.add_argument('--vfov',type=float,default=80)
    p.add_argument('--lens-fov',type=float,default=180)
    p.add_argument('--lens-model',choices=['equidistant','equisolid','stereographic','orthographic'],default='equidistant')
    p.add_argument('--coefficients',nargs=4,type=float,default=[0,0,0,0],help='OpenCV fisheye k1,k2,k3,k4; equidistant model only')
    p.add_argument('--cx',type=float)
    p.add_argument('--cy',type=float)
    p.add_argument('--radius',type=float)
    p.add_argument('--input',help='Existing packed NV12; no synthetic world-geometry claim')
    a=p.parse_args()
    if a.lens_model!='equidistant' and any(a.coefficients):
        p.error('Polynomial coefficients apply only to equidistant/OpenCV fisheye model')
    if a.lens_model=='orthographic' and a.lens_fov>180:
        p.error('Orthographic radial law is not monotonic beyond 180-degree lens FOV')
    if a.width%16 or a.output_width%16 or a.height%2 or a.output_height%2 or not 96<=a.width<=3840 or not 96<=a.height<=2160 or not 96<=a.output_width<=3840 or not 96<=a.output_height<=2160:
        p.error('GDC scope: width multiple of 16, height even; 96..3840 by 96..2160')
    if not 2<=a.frames<=1000 or not 1<=a.tile_step<=64 or not 1<=a.timeout<=300 or not 0<a.hfov<=180 or not 0<a.vfov<=180 or not 0<a.lens_fov<=220:
        p.error('Invalid finite test/projection bounds')
    a.cx=(a.width-1)/2 if a.cx is None else a.cx
    a.cy=(a.height-1)/2 if a.cy is None else a.cy
    a.radius=min(a.width,a.height)*.48 if a.radius is None else a.radius
    if a.radius<=0 or not all(math.isfinite(v) for v in [a.cx,a.cy,a.radius,a.lens_fov,a.hfov,a.vfov,*a.coefficients]):
        p.error('Lens parameters must be finite, radius positive')
    ROOT.joinpath('results').mkdir(exist_ok=True)
    with ROOT.joinpath('results/.run.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        exp=Experiment('fisheye_erp',a)
        binary=[]
        def build():
            binary.append(exp.build('gdc_erp_probe',[ROOT/'native/gdc_erp_probe.c'],['vpf','vio','cam','hbmem']))
            official=SDK/'sample_gdc/3-gdc_static_valid/gdc_static_valid.c'
            return {'executable':str(binary[0]),'official_reference_sha256':digest(official),
                    'hardware':'HB_GDC:0; no EGL/GLES/OpenCL/Vulkan linked'}
        if exp.case('build',build)['status']=='PASS':
            for projection in a.projections:
                exp.case(projection,lambda projection=projection:run_case(exp,binary[0],projection))
        raise SystemExit(exp.finish())


if __name__=='__main__':
    main()
