"""Bounded, sequential hardware experiments; JSON is the source of truth."""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import time
import traceback

ROOT = Path(__file__).resolve().parent
SDK = Path("/app/multimedia_samples")
RESOURCES = ["cpu", "memory", "gpu", "bpu", "vpu", "jpu", "pym",
             "isp", "gdc", "stitch", "camera", "ynr", "mcu", "display",
             "storage", "network"]


class Skip(Exception):
    pass


def read(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def records(text):
    return [json.loads(line.removeprefix("HWJSON "))
            for line in text.splitlines() if line.startswith("HWJSON ")]


def environment():
    return {"thermal_millicelsius": {str(p): read(p) for p in Path("/sys/class/thermal").glob("thermal_zone*/temp")},
            "cpu_frequency_kHz": {str(p): read(p) for p in Path("/sys/devices/system/cpu/cpufreq").glob("policy*/scaling_cur_freq")},
            "accelerator_frequency_Hz": {str(p): read(p) for p in Path("/sys/class/devfreq").glob("*/cur_freq")}}


class Experiment:
    def __init__(self, resource, args):
        self.resource = resource
        self.args = args
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        self.out = ROOT / "results" / f"{stamp}-{resource}"
        self.out.mkdir(parents=True, exist_ok=False)
        self.checks = []
        self.commands = []
        self.environment_before = environment()

    def command(self, argv, name, cwd=None, timeout=None, env=None, separate_stderr=False):
        """Capture output and kill only this command's process group on timeout."""
        argv = [str(v) for v in argv]
        log = self.out / f"{name}.log"
        start = time.monotonic()
        from contextlib import ExitStack
        with ExitStack() as stack:
            f = stack.enter_context(log.open("wb"))
            error_output = stack.enter_context((self.out / f"{name}.stderr.log").open("wb")) if separate_stderr else subprocess.STDOUT
            proc = subprocess.Popen(argv, cwd=cwd or self.out,
                                    stdout=f, stderr=error_output,
                                    start_new_session=True,
                                    env={**os.environ, **(env or {})})
            timed_out = False
            try:
                proc.wait(timeout=timeout or self.args.timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=3)
        elapsed = time.monotonic() - start
        self.commands.append({"argv": argv, "cwd": str(cwd or self.out),
                              "seconds": elapsed, "returncode": proc.returncode,
                              "timeout": timed_out, "log": str(log)})
        text = log.read_text(errors="replace")
        if timed_out:
            raise RuntimeError(f"{name}: timeout; see {log}")
        if proc.returncode:
            raise RuntimeError(f"{name}: exit {proc.returncode}; see {log}\n{text[-1800:]}")
        return text, elapsed

    def case(self, name, fn):
        start = time.monotonic()
        try:
            detail = fn() or {}
            item = {"name": name, "status": "PASS", "detail": detail}
        except Skip as e:
            item = {"name": name, "status": "SKIP", "reason": str(e)}
        except Exception as e:
            item = {"name": name, "status": "FAIL", "reason": str(e)}
            (self.out / f"{len(self.checks):02d}-exception.log").write_text(traceback.format_exc())
        item["wall_seconds"] = time.monotonic() - start
        self.checks.append(item)
        print(f"[{item['status']}] {self.resource}/{name}", flush=True)
        return item

    def build(self, target, sources, libraries=(), extra=()):
        import shutil
        if not shutil.which("gcc"):
            raise Skip("gcc unavailable; install build-essential to run native probes")
        build = ROOT / "build"
        build.mkdir(exist_ok=True)
        argv = ["gcc", "-O2", "-std=gnu11", "-pthread", "-Wno-return-type",
                "-I/usr/hobot/include", "-I/usr/include/cjson",
                f"-I{SDK / 'utils'}", f"-I{SDK / 'vp_sensors'}",
                *extra, *map(str, sources), "-L/usr/hobot/lib",
                "-Wl,-rpath,/usr/hobot/lib", "-o", str(build / target),
                *[f"-l{x}" for x in libraries], "-lm"]
        for source in sources:
            if not Path(source).is_file():
                raise Skip(f"SDK source missing: {source}")
        self.command(argv, f"build-{target}", timeout=90)
        dependencies = list(sources)
        for value in extra:
            if value.startswith('-DPROBE_SOURCE="'):
                dependencies.append(Path(value.split('=', 1)[1].strip('"')))
        if target == "codec_probe":
            dependencies.append(SDK / "sample_codec/sample_codec.c")
        hashes = {str(s): digest(s) for s in dependencies}
        (self.out / f"{target}-sources.json").write_text(json.dumps(hashes, indent=2))
        return build / target

    def native(self, target, *argv, name=None, env=None):
        text, wall = self.command([target, *argv], name or Path(target).name, env=env)
        rows = records(text)
        if not rows:
            raise RuntimeError("No HWJSON evidence; program output alone is not a pass")
        return {"measurements": rows, "process_wall_seconds": wall}

    def finish(self):
        states = {c["status"] for c in self.checks}
        status = ("FAIL" if "FAIL" in states else
                  "PARTIAL" if "SKIP" in states and "PASS" in states else
                  "SKIP" if states == {"SKIP"} else "PASS")
        data = {"schema": 1, "resource": self.resource, "status": status,
                "created": dt.datetime.now().astimezone().isoformat(),
                "host": {"model": read("/proc/device-tree/model"),
                         "kernel": platform.release(), "os": read("/etc/os-release"),
                         "rdk_version": read("/etc/version")},
                "parameters": vars(self.args), "checks": self.checks,
                "environment_before": self.environment_before, "environment_after": environment(),
                "commands": self.commands,
                "scope": "PASS means this experiment passed; it does not certify hardware maxima."}
        (self.out / "result.json").write_text(json.dumps(data, ensure_ascii=False, indent=2))
        report = [f"# {self.resource}: {status}", "",
                  "PASS 只表示此实验通过，不代表已验证官方极限规格。", ""]
        for c in self.checks:
            report += [f"## {c['name']} — {c['status']}", "",
                       c.get("reason", ""), "",
                       "```json", json.dumps(c.get("detail", {}), ensure_ascii=False, indent=2),
                       "```", ""]
        (self.out / "report.md").write_text("\n".join(report))
        print(f"RESULT {self.out / 'result.json'}", flush=True)
        return 1 if status == "FAIL" else 0


def parser(resource):
    p = argparse.ArgumentParser(description=f"RDK S100P {resource} experiment")
    p.add_argument("--frames", type=int, default=30)
    p.add_argument("--width", type=int, default=1920)
    p.add_argument("--height", type=int, default=1080)
    p.add_argument("--timeout", type=int, default=60)
    p.add_argument("--seconds", type=float, default=2)
    p.add_argument("--model", default="/opt/hobot/model/s100/basic/resnet18_224x224_nv12.hbm")
    p.add_argument("--peer", help="Existing iperf3 server IP/name; no network setup is changed")
    p.add_argument("--raw", help="Unpacked Bayer RAW replay file (2 bytes/pixel for RAW10/12)")
    p.add_argument("--raw-format", choices=["raw8", "raw10", "raw12"], default="raw10")
    p.add_argument("--camera-command", help="Explicit finite SDK camera pipeline command")
    p.add_argument("--ynr-command", help="Explicit finite ISP1-YNR1-PYM1 pipeline command")
    p.add_argument("--sensor", type=int, help="Official sensor configuration index; list shown by test_camera.py")
    p.add_argument("--gdc-bin", help="GDC configuration matching the selected sensor")
    p.add_argument("--link-port", type=int, choices=range(4), help="GMSL deserializer link 0..3")
    p.add_argument("--sample-decoded", action="store_true", help="Save/check first and last decoded frame instead of dumping every frame")
    if resource in ["gpu_scale", "pym_8k"]:
        p.set_defaults(width=7680, height=3840, frames=60)
    return p


def main(resource):
    args = parser(resource).parse_args()
    if not 1 <= args.frames <= 1000 or not 0 < args.seconds <= 30 or not 1 <= args.timeout <= 300:
        raise SystemExit("frames 1..1000, seconds (0,30], timeout 1..300 required")
    bounds = {"jpu": (32, 32, 8192, 8192), "gpu_scale": (32, 32, 8192, 8192), "pym": (32, 32, 4096, 4096),
              "isp": (256, 128, 4096, 2160)}.get(resource, (256, 128, 8192, 4096))
    min_w, min_h, max_w, max_h = bounds
    if args.width % 32 or args.height % 8 or not min_w <= args.width <= max_w or not min_h <= args.height <= max_h:
        raise SystemExit(f"Use width multiple of 32 ({min_w}..{max_w}), height multiple of 8 ({min_h}..{max_h})")
    ROOT.joinpath("results").mkdir(exist_ok=True)
    with ROOT.joinpath("results/.run.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Another hardware experiment is running; run sequentially")
        exp = Experiment(resource, args)
        import experiments
        try:
            getattr(experiments, f"test_{resource}")(exp)
        except Exception as e:
            exp.case("setup", lambda: (_ for _ in ()).throw(e))
        raise SystemExit(exp.finish())
