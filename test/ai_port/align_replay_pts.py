#!/usr/bin/env python3
"""Attach actual source presentation timestamps to an offline detection cache.
No inference or production configuration writes. Output must be a new file.
The cache must contain exactly one row per decoded source frame, in order.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
from fractions import Fraction


def frame_times(probe):
    stream = probe["streams"][0]
    time_base = Fraction(stream["time_base"])
    pts = [int(f["best_effort_timestamp"]) for f in probe["frames"]]
    if not pts or any(b <= a for a, b in zip(pts, pts[1:])):
        raise ValueError("source presentation timestamps must strictly increase")
    return [(p-pts[0])*time_base.numerator*1_000_000_000//time_base.denominator for p in pts]


def align(rows, timestamps):
    for index, pts in enumerate(timestamps):
        try:
            row = json.loads(next(rows))
        except StopIteration:
            raise ValueError("detection cache is shorter than source video")
        if row.get("frame_index") != index:
            raise ValueError("cache must contain consecutive source frames starting at zero")
        row["frame_pts_ns"] = pts
        yield json.dumps(row, separators=(",", ":")) + "\n"
    if next(rows, None) is not None:
        raise ValueError("detection cache is longer than source video")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video")
    parser.add_argument("detections")
    parser.add_argument("output")
    args = parser.parse_args()
    target = Path(args.output)
    if target.exists():
        raise ValueError("refusing to overwrite an existing cache")
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_frames", "-show_streams", "-show_entries",
        "stream=time_base:frame=best_effort_timestamp", "-of", "json", args.video
    ], text=True))
    timestamps = frame_times(probe)
    temporary = target.with_name(target.name + ".pending-" + str(os.getpid()))
    try:
        with open(args.detections) as src, temporary.open("x") as dst:
            dst.writelines(align(iter(src), timestamps))
        # Hard-link installation is atomic and fails if another writer created target.
        os.link(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({"frames": len(timestamps), "duration_between_frames_ns": timestamps[-1],
                      "output": str(target), "time_source": "video presentation timestamps"}))


if __name__ == "__main__":
    main()
