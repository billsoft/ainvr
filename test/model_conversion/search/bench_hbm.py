#!/usr/bin/env python3
"""AINVR S100P HBM bench: per-model perf (1 thread latency, 2 thread throughput) + ION lower bound.

ION is read only from /proc/<pid>/fdinfo (dmabuf exp_name ion). Never touches /sys/kernel/debug/ion.
usage: bench_hbm.py OUT.json file.hbm[:model_name] ...
"""
import json, os, re, subprocess, sys, time


def ion_bytes(pid):
    seen, total = set(), 0
    base = f"/proc/{pid}/fdinfo"
    try:
        fds = os.listdir(base)
    except OSError:
        return 0
    for fd in fds:
        try:
            txt = open(f"{base}/{fd}").read()
        except OSError:
            continue
        if "exp_name:\tion" not in txt and "exp_name: ion" not in txt:
            continue
        ino = re.search(r"ino:\s*(\d+)", txt)
        size = re.search(r"size:\s*(\d+)", txt)
        if not (ino and size) or ino.group(1) in seen:
            continue
        seen.add(ino.group(1))
        total += int(size.group(1))
    return total


def run_perf(path, name, threads, frames):
    cmd = ["hrt_model_exec", "perf", "--model_file", path, "--thread_num", str(threads),
           "--frame_count", str(frames)]
    if name:
        cmd += ["--model_name", name]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    peak = 0
    while p.poll() is None:
        peak = max(peak, ion_bytes(p.pid))
        time.sleep(0.05)
    out = p.stdout.read()
    lat = re.search(r"Average\s+latency\s+is:\s*([\d.]+)\s*ms", out)
    fps = re.search(r"Frame\s+rate\s+is:\s*([\d.]+)\s*FPS", out)
    load = re.search(r"Load model to DDR cost ([\d.]+)ms", out)
    return {
        "avg_latency_ms": float(lat.group(1)) if lat else None,
        "fps": float(fps.group(1)) if fps else None,
        "load_ms": float(load.group(1)) if load else None,
        "ion_bytes_peak": peak,
        "rc": p.returncode,
        "tail": None if lat else out[-400:],
    }


def run_py(path, inputs, threads=1):
    """Real-token run through hbm_runtime (perf with random ids is meaningless for Gather); ION from this pid."""
    cmd = ["python3", "/mnt/ainvr-ssd/search-models/scripts/board_run_hbm.py", path, inputs, "/tmp/_bench_out.npy"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    peak = 0
    while p.poll() is None:
        peak = max(peak, ion_bytes(p.pid))
        time.sleep(0.05)
    out = p.stdout.read()
    m = re.search(r'"mean_ms": ([\d.]+), "p95_ms": ([\d.]+)', out)
    return {"avg_latency_ms": float(m.group(1)) if m else None, "p95_ms": float(m.group(2)) if m else None,
            "fps": 1000.0 / float(m.group(1)) if m else None, "ion_bytes_peak": peak, "rc": p.returncode,
            "tail": None if m else out[-300:]}


def main():
    out_path, items = sys.argv[1], sys.argv[2:]
    res = []
    for it in items:
        path, _, name = it.partition(":")
        if name.startswith("@py="):
            rec = {"file": path, "model_name": "real-token-runner", "size": os.path.getsize(path)}
            rec["t1"] = run_py(path, name[4:]); rec["t2"] = rec["t1"]
            res.append(rec)
            print(json.dumps({"file": path, "lat1": rec["t1"]["avg_latency_ms"], "ion_MB": round(rec["t1"]["ion_bytes_peak"] / 1048576, 1)}), flush=True)
            continue
        rec = {"file": path, "model_name": name or None, "size": os.path.getsize(path)}
        rec["t1"] = run_perf(path, name, 1, 200)
        rec["t2"] = run_perf(path, name, 2, 200)
        res.append(rec)
        print(json.dumps({k: rec[k] for k in ("file", "model_name")} |
                         {"lat1": rec["t1"]["avg_latency_ms"], "fps2": rec["t2"]["fps"],
                          "ion_MB": round(rec["t1"]["ion_bytes_peak"] / 1048576, 1)}), flush=True)
    json.dump({"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "results": res},
              open(out_path, "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
