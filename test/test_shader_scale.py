#!/usr/bin/env python3
"""NV12 GLES scaling: measured GPU work, transfers, CPU use and pixel oracles."""
import argparse
import fcntl
import math
from pathlib import Path
import numpy as np
import cv2
from common import Experiment, ROOT, digest, records


def planes(path, w, h):
    b = np.fromfile(path, dtype=np.uint8)
    if b.size != w * h + 2 * (w//2) * (h//2):
        raise RuntimeError(f"Invalid NV12 size: {path}: {b.size}")
    return [b[:w*h].reshape(h, w, 1), b[w*h:].reshape(h//2, w//2, 2)]


def bilinear(src, ow, oh):
    """Independent float64 pixel-center interpolation, clamped at texture edges."""
    ih, iw, _ = src.shape
    x = (np.arange(ow, dtype=np.float64) + .5) * iw / ow - .5
    y = (np.arange(oh, dtype=np.float64) + .5) * ih / oh - .5
    ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = (x-ix)[None, :, None], (y-iy)[:, None, None]
    x0, x1 = np.clip(ix, 0, iw-1), np.clip(ix+1, 0, iw-1)
    y0, y1 = np.clip(iy, 0, ih-1), np.clip(iy+1, 0, ih-1)
    a = src[y0[:, None], x0[None, :]].astype(np.float64)
    b = src[y0[:, None], x1[None, :]].astype(np.float64)
    c = src[y1[:, None], x0[None, :]].astype(np.float64)
    d = src[y1[:, None], x1[None, :]].astype(np.float64)
    return ((a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy)


def oracle(directory, filter_name, w, h, ow, oh):
    source = planes(directory / "input.nv12", w, h)
    if filter_name == "trilinear":
        lod = math.log2(max(w/ow, h/oh))
        lo, hi = math.floor(lod), math.ceil(lod)
        low = planes(directory / f"mip-{lo}.nv12", w >> lo, h >> lo)
        high = low if hi == lo else planes(directory / f"mip-{hi}.nv12", w >> hi, h >> hi)
    result = []
    for i, src in enumerate(source):
        tw, th = (ow, oh) if i == 0 else (ow//2, oh//2)
        if filter_name == "bilinear":
            ref = bilinear(src, tw, th)
        elif filter_name == "area":
            ref = cv2.resize(src.astype(np.float32), (tw, th), interpolation=cv2.INTER_AREA)
            if ref.ndim == 2:
                ref = ref[..., None]
        else:
            ref = bilinear(low[i], tw, th) * (1-(lod-lo)) + bilinear(high[i], tw, th) * (lod-lo)
        result.append(np.clip(np.rint(ref), 0, 255).astype(np.uint8))
    return np.concatenate([p.ravel() for p in result])


def run_case(exp, executable, filter_name, ow, oh):
    a = exp.args
    name = f"{filter_name}-{ow}x{oh}"
    directory = exp.out / name
    directory.mkdir()
    text, seconds = exp.command([executable, a.width, a.height, ow, oh, a.frames,
                                 ROOT / "shaders", filter_name], name, cwd=directory)
    rows = records(text)
    drivers = [r for r in rows if r.get("event") == "gles_driver"]
    if len(drivers) != 1 or "Mali" not in drivers[0].get("renderer", ""):
        raise RuntimeError("Hardware Mali driver evidence missing")
    metrics = [r for r in rows if r.get("event") == "scale_measurement"]
    modes = {"resident_sampling", "upload_render_download"}
    if filter_name == "trilinear":
        modes.add("resident_rebuild_mips")
    if len(metrics) != len(modes) or {r["mode"] for r in metrics} != modes:
        raise RuntimeError("Incomplete measurement modes")
    if any(r["completed_frames"] != a.frames or r["fps"] <= 0 for r in metrics):
        raise RuntimeError("Invalid completed-frame evidence")
    expected = oracle(directory, filter_name, a.width, a.height, ow, oh)
    validation = []
    for mode in sorted(modes):
        for which in ["first", "last"]:
            path = directory / f"{mode}-{which}.nv12"
            actual = np.fromfile(path, dtype=np.uint8)
            if actual.size != expected.size:
                raise RuntimeError(f"Incomplete output: {path}")
            delta = np.abs(actual.astype(np.int16)-expected.astype(np.int16))
            detail = {"file": str(path), "sha256": digest(path), "max_error": int(delta.max()),
                      "mean_absolute_error": float(delta.mean())}
            validation.append(detail)
            if detail["max_error"] > 2 or detail["mean_absolute_error"] > .75:
                raise RuntimeError(f"Pixel reference mismatch: {detail}")
    return {"driver": drivers[0], "measurements": metrics, "validation": validation,
            "shader_variant": [r for r in rows if r.get("event") == "shader_variant"],
            "input_sha256": digest(directory / "input.nv12"), "process_wall_seconds": seconds,
            "sources_sha256": {str(p): digest(p) for p in [ROOT / "native/gles_scale_probe.c",
                ROOT / "native/gles_context.h", ROOT / "shaders/scale.vert", ROOT / f"shaders/{filter_name}.frag"]},
            "reference": "CPU bilinear / OpenCV float area; trilinear CPU interpolation of actual GPU mip levels",
            "scope": "resident_sampling uses existing mips; resident_rebuild_mips and upload_render_download rebuild every trilinear frame; excludes allocation, decode, disk and pixel validation"}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--width", type=int, default=7680)
    p.add_argument("--height", type=int, default=3840)
    p.add_argument("--targets", nargs="+", default=["3840x1920", "3072x1536", "2560x1280"])
    p.add_argument("--filters", nargs="+", choices=["bilinear", "trilinear", "area"],
                   default=["bilinear", "trilinear", "area"])
    p.add_argument("--frames", type=int, default=60)
    p.add_argument("--timeout", type=int, default=120)
    a = p.parse_args()
    targets = [tuple(map(int, s.lower().split("x"))) for s in a.targets]
    if not 2 <= a.frames <= 1000 or not 1 <= a.timeout <= 300:
        p.error("frames 2..1000 and timeout 1..300 required")
    if a.width % 8 or a.height % 8 or not 32 <= a.width <= 8192 or not 32 <= a.height <= 8192:
        p.error("Input dimensions must be multiples of 8, between 32 and 8192")
    for ow, oh in targets:
        if ow % 2 or oh % 2 or not 32 <= ow <= a.width or not 32 <= oh <= a.height or max(a.width/ow, a.height/oh) > 8:
            p.error("Targets must be even, at least 32, downscale <=8x")
    ROOT.joinpath("results").mkdir(exist_ok=True)
    with ROOT.joinpath("results/.run.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        exp = Experiment("shader_scale", a)
        binary = []
        def build():
            binary.append(exp.build("gles_scale_probe", [ROOT / "native/gles_scale_probe.c"],
                                    ["EGL", "GLESv2", "wayland-client"]))
            return {"executable": str(binary[0])}
        if exp.case("build", build)["status"] == "PASS":
            for ow, oh in targets:
                for filter_name in a.filters:
                    exp.case(f"{filter_name}-{ow}x{oh}", lambda f=filter_name, x=ow, y=oh: run_case(exp, binary[0], f, x, y))
        raise SystemExit(exp.finish())


if __name__ == "__main__":
    main()
