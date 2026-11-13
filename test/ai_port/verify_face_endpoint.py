#!/usr/bin/env python3
"""Bounded real control-service HTTP/JPU/GLES/BPU verification, no pixel CPU work.

Run only in the coordinated native hardware window. No production config or
binary is changed. Only sanitized result summaries are retained (never vectors).
"""
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "test/results/face-native-20261112"
OUT.mkdir(exist_ok=True)
lock = (ROOT / "test/results/capabilities-20261112/native-build.lock").open("a")
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
token = secrets.token_hex(32)
config = OUT / "isolated-config.json"
overlay = OUT / "isolated-overlay.json"
for path, value in [(config, {"server": {"host": "127.0.0.1", "port": port,
                             "api_key": token}, "channels": []}), (overlay, {})]:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream)
env = dict(os.environ, CONFIG_CENTER_URL="")
binary = ROOT / "out/build/ai-s100p/ainvr_s100p_control_service"
report = {"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
          "cpu_image_fallback": False, "accuracy_verified": False, "completed": False, "checks": []}
report["source_sha256"] = {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in (
    "ai-service/src/face_embedding/hardware.hpp", "ai-service/src/face_identity/integration.hpp",
    "ai-service/src/face_identity/residency.hpp",
    "ai-service/src/stream/sei.cpp", "ai-service/src/analytics/observation_journal.hpp",
    "ai-service/src/analytics/region_observation_capabilities.hpp", "ai-service/src/adapters/detection_decode.cpp")}
base = f"http://127.0.0.1:{port}"


def call(path, body=None, headers=None, authenticated=True):
    hdr = {"x-service-token": token} if authenticated else {}
    hdr.update(headers or {})
    request = urllib.request.Request(base + path, data=body, headers=hdr)
    started = time.monotonic()
    try:
        response = urllib.request.urlopen(request, timeout=35)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response), round((time.monotonic()-started)*1000, 2)


def check(name, ok, **details):
    report["checks"].append(dict(name=name, passed=bool(ok), **details))
    (OUT / "endpoint-summary.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report["checks"][-1]), flush=True)


def status():
    return call("/v1/faces/extractor/status")


def configure(model, enabled=True, revision=None):
    if revision is None:
        revision = status()[1]["configuration_revision"]
    return call("/v1/faces/extractor/configure", json.dumps({"enabled": enabled,
        "detector_model": "face-det-scrfd-500m", "embedding_model": model,
        "expected_revision": revision}).encode(), {"Content-Type": "application/json"})


def extract(path, pins=None, overrides=None):
    jpeg = path.read_bytes()
    pins = pins or status()[1]
    meta = {"request_id": str(uuid.uuid4()), "model_space_hash": pins["model_space_hash"],
            "detector_sha256": pins["detector_sha256"],
            "jpeg_sha256": hashlib.sha256(jpeg).hexdigest(), "expires_ms": int(time.time()*1000)+30000}
    meta.update(overrides or {})
    return call("/v1/faces/extract", jpeg, {"Content-Type": "image/jpeg", "x-ainvr-face": json.dumps(meta)})


log = (OUT / "endpoint-service.log").open("w")
process = subprocess.Popen([str(binary), str(config), str(overlay), str(ROOT / "ai-service"),
    str(ROOT / "deploy/s100p/runtime/ai-service.env")], cwd=ROOT, env=env,
    stdout=log, stderr=subprocess.STDOUT)
try:
    deadline = time.monotonic()+40
    while time.monotonic()<deadline:
        if process.poll() is not None:
            raise RuntimeError("isolated control service exited; see endpoint-service.log")
        try:
            code, state, _ = status()
            if code == 200:
                break
        except (OSError, ValueError):
            pass
        time.sleep(.25)
    else:
        raise RuntimeError("licensed extractor control unavailable within 40 seconds")
    rows = json.loads(Path("/run/ainvr/bpu-reservations.json").read_text()).get("holders", []) if Path("/run/ainvr/bpu-reservations.json").exists() else []
    code, health, _ = call("/health")
    adapters = health.get("capabilities", {}).get("model_adapters", [])
    check("health_advertises_actual_pose_and_locateanything", code == 200 and
          "yolo26_pose_bpu" in adapters and "locateanything_bpu" in adapters, adapters=adapters)
    check("unconfigured_has_no_demand_or_budget", not state["configured"] and not state["can_extract"]
          and not state["configuration"]["enabled"] and not any(r.get("pid") == process.pid for r in rows))
    code, state, _ = configure("face-embed-mbf", enabled=True)
    if code != 200 or not state.get("can_extract"):
        raise RuntimeError("explicit face enable not admitted")
    check("real_config_lazy_admitted", state["configured"] and not state["loaded"], status=state)
    code, error, _ = call("/v1/faces/extractor/status", authenticated=False)
    check("missing_token_rejected", code == 403, http=code)
    code, error, _ = configure("face-embed-mbf", revision=999999)
    check("configuration_revision_fenced", code == 409, http=code)
    fixture = OUT / "celeba-000001.jpg"
    code, error, _ = extract(fixture, overrides={"model_space_hash": "0"*64})
    check("model_space_fenced", code == 409, http=code)
    code, error, _ = extract(fixture, overrides={"jpeg_sha256": "0"*64})
    check("jpeg_hash_fenced", code == 422, http=code)
    report["fixture_partition"] = "CelebA official list_eval_partition.txt: 1 (validation)"
    spaces = {}
    for model in ("face-embed-mbf", "face-embed-r50"):
        if model.endswith("r50"):
            code, state, _ = configure(model)
            check("r50_configured", code == 200 and state.get("can_extract"), status=state)
        success = False
        for name in ("celeba-162772.jpg", "celeba-162771.jpg", "celeba-162774.jpg"):
            code, result, ms = extract(OUT/name)
            vector = result.pop("embedding", None)
            norm = math.sqrt(sum(x*x for x in vector)) if isinstance(vector, list) else None
            ok = (code == 200 and result.get("status") == "extracted" and
                  result.get("quality", {}).get("accepted") is True and
                  isinstance(vector, list) and len(vector) == 512 and
                  all(math.isfinite(x) for x in vector) and abs(norm-1) < 1e-5)
            rejected = (code == 200 and result.get("status") in
                        ("no_face", "multiple_faces", "quality_rejected") and vector is None)
            check(model+":"+name, ok or rejected, http=code, elapsed_ms=ms,
                  vector_dimensions=len(vector) if isinstance(vector, list) else 0,
                  l2_norm=norm, result=result)
            if ok:
                spaces[model] = result["model_space_hash"]
                check(model+":loaded_status", status()[1].get("ready") is True)
                code2, repeat, _ = extract(OUT/name)
                vector2 = repeat.get("embedding")
                distance = math.sqrt(sum((a-b)**2 for a,b in zip(vector, vector2))) if isinstance(vector2,list) and len(vector2)==512 else None
                check(model+":same_image_repeat", code2 == 200 and distance is not None and distance < 1e-5,
                      l2_distance=distance)
                rows = json.loads(Path("/run/ainvr/bpu-reservations.json").read_text())["holders"]
                own = [r for r in rows if r.get("pid") == process.pid]
                check(model+":real_loaded_reservation", any(r.get("service")=="ai-service" and
                      r.get("state")=="loaded" for r in own), rows=len(own))
                success=True
            if code != 200:
                time.sleep(5.1)
        check(model+":successful_hardware_extraction", success)
        if success:
            for _ in range(30):
                rows = json.loads(Path("/run/ainvr/bpu-reservations.json").read_text())["holders"]
                own = [r for r in rows if r.get("pid") == process.pid]
                if len(own) == 1:
                    break
                time.sleep(.2)
            check(model+":retired_generation_not_accumulated", len(own) == 1, rows=len(own))
    check("distinct_embedding_spaces", len(spaces)==2 and len(set(spaces.values()))==2)
    multi = ROOT / "test/results/review-product-20261106/final-419ca102de2804ac9c38776b824e059f602ed5ed1316729df8eea7483a759220-0-source.jpg"
    code, result, ms = extract(multi)
    check("multiple_faces_no_vector", code == 200 and result.get("status")=="multiple_faces" and
          "embedding" not in result, http=code, result=result, elapsed_ms=ms)
    before = status()[1]
    time.sleep(22)  # no BFF/status traffic; native maintenance owns grant renewal
    after = status()[1]
    check("native_renews_without_status_poll", after["expires_ms"] > before["expires_ms"] and
          after["generation"] == before["generation"] and after["can_extract"],
          expiry_extension_ms=after["expires_ms"]-before["expires_ms"])
    code, state, _ = configure("face-embed-r50", enabled=False)
    check("disable_revokes_demand", code == 200 and not state.get("can_extract") and
          not state.get("configured"), status=state)
    retired = False
    for _ in range(30):
        rows = json.loads(Path("/run/ainvr/bpu-reservations.json").read_text())["holders"]
        if not any(r.get("pid") == process.pid for r in rows):
            retired = True
            break
        time.sleep(.2)
    check("disabled_resources_release_real_reservation", retired)
    report["completed"] = True
finally:
    process.terminate()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
    log.close()
    config.unlink(missing_ok=True)  # only this test's temporary token/config
    report["exit_code"] = process.returncode
    report["passed"] = report["completed"] and all(x["passed"] for x in report["checks"]) and bool(report["checks"])
    (OUT / "endpoint-summary.json").write_text(json.dumps(report, indent=2))
if not report["passed"]:
    raise SystemExit(1)
