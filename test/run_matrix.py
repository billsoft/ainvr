#!/usr/bin/env python3
"""Explicit bounded resolution sweep; no claim that a successful row is a peak."""
import argparse
import subprocess
import sys
from common import ROOT

p = argparse.ArgumentParser()
p.add_argument("--resource", choices=["vpu", "jpu", "pym"], required=True)
p.add_argument("--frames", type=int, default=60)
p.add_argument("--include-limits", action="store_true", help="Also probe the documented dimension bound; substantial NV12 output files")
args = p.parse_args()
failed = False
sizes = [(1280, 720), (1920, 1080), (3840, 2160)]
if args.include_limits:
    sizes.append({"vpu": (8192, 4096), "jpu": (8192, 8192), "pym": (4096, 4096)}[args.resource])
for width, height in sizes:
    print(f"\n{args.resource}: {width}x{height}", flush=True)
    r = subprocess.run([sys.executable, ROOT / f"test_{args.resource}.py",
                        "--width", str(width), "--height", str(height),
                        "--frames", str(args.frames)], timeout=600)
    failed |= r.returncode != 0
raise SystemExit(1 if failed else 0)
