#!/usr/bin/env python3
"""Run each resource in isolation and summarize this run only."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import datetime as dt
from common import ROOT, RESOURCES

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--resources", nargs="+", choices=RESOURCES, default=RESOURCES)
    p.add_argument("--frames", type=int, default=30)
    p.add_argument("--width", type=int, default=1920)
    p.add_argument("--height", type=int, default=1080)
    p.add_argument("--timeout", type=int, default=60)
    args = p.parse_args()
    summary = []
    ROOT.joinpath("results").mkdir(exist_ok=True)
    for name in args.resources:
        before = set(ROOT.joinpath("results").glob(f"*-{name}/result.json"))
        print(f"\n=== {name} ===", flush=True)
        cmd = [sys.executable, str(ROOT / f"test_{name}.py"),
               "--frames", str(args.frames), "--width", str(args.width),
               "--height", str(args.height), "--timeout", str(args.timeout)]
        try:
            result = subprocess.run(cmd, timeout=max(180, args.timeout * 10))
            after = set(ROOT.joinpath("results").glob(f"*-{name}/result.json")) - before
            if len(after) != 1:
                raise RuntimeError(f"Expected exactly one fresh result, got {len(after)}")
            file = after.pop()
            data = json.loads(file.read_text())
            summary.append({"resource": name, "status": data["status"],
                            "checks": data["checks"], "result": str(file),
                            "exit": result.returncode})
        except Exception as e:
            summary.append({"resource": name, "status": "FAIL", "reason": str(e)})
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    file = ROOT / "results" / f"summary-{stamp}.json"
    file.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    lines = ["# RDK S100P hardware experiment results", "",
             "| Resource | Status | Passed | Failed | Skipped |",
             "|---|---|---:|---:|---:|"]
    for item in summary:
        checks = item.get("checks", [])
        counts = [sum(c["status"] == s for c in checks) for s in ["PASS", "FAIL", "SKIP"]]
        lines.append(f"| {item['resource']} | {item['status']} | {counts[0]} | {counts[1]} | {counts[2]} |")
    file.with_suffix(".md").write_text("\n".join(lines) + "\n")
    print(f"SUMMARY {file}", flush=True)
    return 1 if any(v["status"] == "FAIL" for v in summary) else 0

if __name__ == "__main__":
    raise SystemExit(main())
