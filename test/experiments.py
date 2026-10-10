"""One experiment per resource; no software fallback is counted as hardware success."""
import glob
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import time
from common import ROOT, SDK, Skip, digest, read

MEDIA_LIBS = ["vpf", "vio", "cam", "hbmem", "multimedia", "cjson",
              "avformat", "avcodec", "avutil", "swresample"]


def required(paths):
    missing = [str(p) for p in paths if not Path(p).exists()]
    if missing:
        raise Skip("Unavailable: " + ", ".join(missing))
    return {"available": [str(p) for p in paths]}


def helpers():
    return sorted(SDK.joinpath("utils").glob("*.c")) + sorted(SDK.joinpath("vp_sensors").rglob("*.c"))


def host(exp):
    return exp.build("host_probe", [ROOT / "native/host_probe.c"])


def test_cpu(exp):
    exp.case("topology", lambda: {
        "cpuinfo": read("/proc/cpuinfo"), "online": read("/sys/devices/system/cpu/online"),
        "policies": {str(p): read(p) for p in Path("/sys/devices/system/cpu/cpufreq").glob("policy*/scaling_*freq")}})
    def benchmark():
        result = exp.native(host(exp), "cpu", exp.args.seconds)
        mask = (1 << 64) - 1
        value = 1234567
        for _ in range(200000):
            value ^= value >> 12
            value ^= (value << 25) & mask
            value ^= value >> 27
            value = (value * 2685821657736338717) & mask
        if any(row["checksum"] != value for row in result["measurements"]):
            raise RuntimeError("C checksum disagrees with independent Python reference")
        result["python_reference_checksum"] = value
        return result
    exp.case("per-core-and-all-core-computation", benchmark)


def test_memory(exp):
    exp.case("capacity", lambda: {"meminfo": read("/proc/meminfo")})
    exp.case("64MiB-pattern-copy-and-full-verification", lambda: exp.native(host(exp), "memory"))


def test_gpu(exp):
    exp.case("driver", lambda: required(["/dev/mali0", "/usr/hobot/lib/libOpenCL.so"]))
    exp.case("OpenCL-kernel-correctness-and-profiling", lambda:
             exp.native(exp.build("gpu_probe", [ROOT / "native/gpu_probe.c"], ["OpenCL"]), name="OpenCL"))
    def render():
        raise Skip("Headless OpenCL tested separately. OpenGL ES rendering needs a connected display and Wayland session.")
    exp.case("OpenGL-ES-rendering", render)


def test_bpu(exp):
    exp.case("driver-and-frequency", lambda: {
        **required(["/dev/bpu_core0"]),
        "core_count": read("/sys/devices/system/bpu/core_num"),
        "devfreq": {str(p): read(p) for p in Path("/sys/class/devfreq").glob("*bpu*/cur_freq")}})
    def infer():
        required([exp.args.model])
        detail = exp.native("/usr/bin/python3", ROOT / "native/bpu_probe.py",
                            exp.args.model, exp.args.frames, name="BPU-inference")
        detail["model_sha256"] = digest(exp.args.model)
        return detail
    exp.case("model-load-inference-determinism-latency", infer)


def codec_binary(exp):
    return exp.build("codec_probe", [ROOT / "native/codec_probe.c", *helpers()],
                     MEDIA_LIBS, [f"-I{SDK / 'sample_codec'}"])


def nv12_pattern(path, w, h):
    import numpy as np
    y = np.tile((16 + (np.arange(w, dtype=np.uint32) * 219 // max(w - 1, 1))).astype(np.uint8), (h, 1))
    uv = np.full((h // 2, w), 128, dtype=np.uint8)
    with path.open("wb") as f:
        f.write(y.tobytes()); f.write(uv.tobytes())
    return y, uv


def codec_cases(exp, ids):
    binary = None
    for name, index, extension in ids:
        def roundtrip(name=name, index=index, extension=extension):
            nonlocal binary
            if binary is None:
                binary = codec_binary(exp)
            w, h = exp.args.width, exp.args.height
            frames = max(8, exp.args.frames)
            input_file = exp.out / f"{name}-input.nv12"
            y, uv = nv12_pattern(input_file, w, h)
            encoded = exp.out / f"{name}.{extension}"
            decoded = exp.out / f"{name}-decoded.nv12"
            enc = exp.native(binary, "encode", index, w, h, frames, input_file, encoded, name=f"{name}-encode")
            dec = exp.native(binary, "decode", index, w, h, frames, encoded, decoded, name=f"{name}-decode",
                             env={"HW_SAMPLE_DECODED": "1"} if exp.args.sample_decoded else None)
            size = w * h * 3 // 2
            checked_frames = 2 if exp.args.sample_decoded else frames
            if decoded.stat().st_size != size * checked_frames:
                raise RuntimeError("Decoded frame count/size mismatch")
            import numpy as np
            maes = []
            with decoded.open("rb") as f:
                for _ in range(checked_frames):
                    frame = np.frombuffer(f.read(size), np.uint8)
                    maes.append(float(np.mean(np.abs(frame[:w*h].astype(np.int16) - y.ravel().astype(np.int16)))))
                    if float(np.mean(np.abs(frame[w*h:].astype(np.int16) - uv.ravel().astype(np.int16)))) > 5:
                        raise RuntimeError("Decoded neutral chroma mismatch")
            if max(maes) > 12:
                raise RuntimeError(f"Decoded gradient differs excessively: luma MAE {max(maes)}")
            oracle = None
            if shutil.which("ffprobe"):
                text, _ = exp.command(["ffprobe", "-v", "error", *(["-f", "mjpeg"] if index >= 2 else []), "-count_frames", "-show_entries",
                                      "stream=codec_name,width,height,nb_read_frames", "-of", "json", encoded],
                                     f"{name}-ffprobe", separate_stderr=True)
                oracle = json.loads(text)
                streams = oracle.get("streams", [])
                if not streams or streams[0].get("width") != w or streams[0].get("height") != h:
                    raise RuntimeError("Independent ffprobe dimensions mismatch")
                if int(streams[0].get("nb_read_frames", -1)) != frames:
                    raise RuntimeError("Independent ffprobe frame count mismatch")
            return {"encode": enc, "decode": dec, "luma_MAE_max": max(maes),
                    "checked_pixel_frames": checked_frames,
                    "encoded_bytes": encoded.stat().st_size, "encoded_sha256": digest(encoded),
                    "ffprobe": oracle, "validation": "frame counts, dimensions, gradient luma and neutral chroma",
                    "coverage": "one stream at selected resolution; maxima and simultaneous encode/decode not certified"}
        exp.case(f"{name}-hardware-roundtrip", roundtrip)


def test_vpu(exp):
    exp.case("driver", lambda: required(["/dev/vpu", "/usr/hobot/lib/libmultimedia.so"]))
    codec_cases(exp, [("h264", 0, "h264"), ("h265", 1, "h265")])


def test_jpu(exp):
    exp.case("driver", lambda: required(["/dev/jpu"]))
    codec_cases(exp, [("mjpeg", 2, "mjpg"), ("jpeg", 3, "jpg")])


def test_pym(exp):
    def all_modules():
        binary = exp.build("pym_probe", [ROOT / "native/pym_probe.c"], ["vpf", "vio", "cam", "hbmem"])
        return binary
    holder = {}
    for i in [0, 1, 4]:
        def run(i=i):
            required([f"/dev/pym{i}_src", f"/dev/pym{i}_cap"])
            if "binary" not in holder:
                holder["binary"] = all_modules()
            return exp.native(holder["binary"], i, exp.args.width, exp.args.height,
                              exp.args.frames, name=f"PYM{i}")
        exp.case(f"PYM{i}-six-layer-dimensions-content-and-latency", run)


def test_gpu_scale(exp):
    exp.case("GPU-and-CPU-NV12-half-scaling", lambda: exp.native(
        exp.build("gpu_scale_probe", [ROOT / "native/gpu_scale_probe.c"], ["OpenCL"]),
        exp.args.width, exp.args.height, exp.args.frames))


def test_pym_8k(exp):
    if (exp.args.width, exp.args.height) != (7680, 3840):
        raise RuntimeError("This explicit out-of-spec probe is limited to 7680x3840")
    binary = exp.build("pym_probe", [ROOT / "native/pym_probe.c"], ["vpf", "vio", "cam", "hbmem"])
    for i in [0, 1, 4]:
        exp.case(f"PYM{i}-out-of-spec-7680x3840-to-3840x1920", lambda i=i: exp.native(
            binary, i, 7680, 3840, exp.args.frames, "--probe-8k", name=f"PYM{i}-8k"))


def sdk_binary(exp, target, source, gdc=False, stitch=False, camera=False):
    extra = [f'-DPROBE_SOURCE="{source}"', f"-I{source.parent}"]
    sources = [ROOT / "native/sdk_probe.c"]
    if gdc:
        extra.append("-DPROBE_GDC=1")
    if stitch:
        extra.append("-DPROBE_STITCH=1")
    if camera:
        extra.append("-DPROBE_CAMERA=1")
    if stitch:
        sources.append(source.parent / "utils.c")
    else:
        sources.extend(helpers())
    return exp.build(target, sources, MEDIA_LIBS, extra)


def capture_preview(exp, path, width, height, name):
    import numpy as np
    import cv2
    required([path])
    data = path.read_bytes()
    if len(data) != width * height * 3 // 2:
        raise RuntimeError("Captured NV12 size mismatch")
    frame = np.frombuffer(data, np.uint8).reshape(height * 3 // 2, width)
    image = cv2.cvtColor(frame, cv2.COLOR_YUV2BGR_NV12)
    output = exp.out / f"{name}.png"
    if not cv2.imwrite(str(output), image):
        raise RuntimeError("Could not save preview")
    return {"nv12": str(path), "preview": str(output), "sha256": digest(path)}


def test_gdc(exp):
    def replay():
        source = SDK / "sample_gdc/4-gdc_stress_test/gdc_stress_test.c"
        config = source.parent / "gdc_1920x1080.bin"
        image = source.parent / "test_res/test_image_1920x1080.yuv"
        required([config, image])
        binary = sdk_binary(exp, "gdc_probe", source, gdc=True)
        capture = exp.out / "gdc.nv12"
        detail = exp.native(binary, config, image, capture, exp.args.frames, name="GDC-replay")
        if detail["measurements"][-1]["completed_getframe_calls"] != exp.args.frames:
            raise RuntimeError("GDC completion count mismatch")
        return {**detail, **capture_preview(exp, capture, 1920, 1080, "gdc"),
                "validation": "nonconstant output and frame completion; geometric calibration not certified",
                "config_sha256": digest(config)}
    exp.case("1080p-offline-transformation-and-throughput", replay)


def test_stitch(exp):
    def replay():
        source = Path("/app/multimedia_demo/camsys_demo/sample_gdc_stitch/sample_gdc_stitch.c")
        required([source, source.parent / "alpha_lut_apa.bin"])
        binary = sdk_binary(exp, "stitch_probe", source, stitch=True)
        capture = exp.out / "stitch.nv12"
        text, wall = exp.command([binary, "-l", exp.args.frames, "-d", "0"],
                                 "GDC-STITCH-replay", env={"HW_CAPTURE": str(capture)})
        from common import records
        rows = records(text)
        if not rows or rows[-1].get("completed_getframe_calls") != exp.args.frames * 5:
            raise RuntimeError("Expected four GDC and one STITCH completion per loop")
        return {"measurements": rows, "process_wall_seconds": wall,
                **capture_preview(exp, capture, 896, 896, "stitch"),
                "pipeline_fps": exp.args.frames / rows[-2]["pipeline_seconds"],
                "coverage": "4x GDC + STITCH pipeline; aggregate throughput is not STITCH-only throughput",
                "validation": "completion and frame content sanity; visual stitching quality not certified"}
    exp.case("four-image-GDC-and-STITCH-pipeline", replay)


def test_isp(exp):
    exp.case("ISP0-ISP1-interfaces", lambda: required(["/dev/isp0_src", "/dev/isp1_src", "/dev/ac_isp"]))
    def replay():
        raw = Path(exp.args.raw) if exp.args.raw else exp.out / "synthetic-bayer.raw"
        if not exp.args.raw:
            import numpy as np
            bits = int(exp.args.raw_format.removeprefix("raw"))
            # Every Bayer position receives the same smooth scene, avoiding a
            # dependency on the dummy sensor's color-filter arrangement.
            x = np.linspace(1 << (bits - 4), (1 << bits) * 3 // 4, exp.args.width)
            image = np.tile(x, (exp.args.height, 1)).astype('u1' if bits == 8 else '<u2')
            raw.write_bytes(image.tobytes())
        required([raw])
        expected = exp.args.width * exp.args.height * (1 if exp.args.raw_format == "raw8" else 2)
        if raw.stat().st_size != expected:
            raise RuntimeError(f"RAW size mismatch: expected {expected}")
        source = SDK / "sample_isp/isp_feedback/isp_feedback.c"
        binary = sdk_binary(exp, "isp_probe", source)
        capture = exp.out / "isp.nv12"
        text, wall = exp.command([binary, "-f", raw, "-F", exp.args.raw_format,
                                 "-W", exp.args.width, "-H", exp.args.height, "-l", exp.args.frames],
                                 "ISP-replay", env={"HW_CAPTURE": str(capture)})
        from common import records
        rows = records(text)
        if not rows or rows[-1].get("completed_getframe_calls") != exp.args.frames:
            raise RuntimeError("ISP completion count mismatch")
        return {"measurements": rows, "process_wall_seconds": wall,
                "raw_sha256": digest(raw), "input": "supplied RAW" if exp.args.raw else "synthetic grayscale Bayer ramp",
                "coverage": "official ISP0 replay path; ISP1 online path requires camera; no sensor color tuning certification",
                "preview": capture_preview(exp, capture, exp.args.width, exp.args.height, "isp")}
    exp.case("Bayer-RAW-replay-processing", replay)


def finite_pipeline(exp, command, name):
    if not command:
        raise Skip(f"Specify --{name}-command with a finite SDK pipeline configured for the attached sensor; no arbitrary sensor initialization")
    argv = shlex.split(command)
    text, elapsed = exp.command(argv, f"{name}-pipeline")
    from common import records
    rows = records(text)
    if not rows or not any(r.get("completed_frames", 0) > 0 for r in rows):
        raise RuntimeError("Pipeline must emit HWJSON with completed_frames > 0; exit 0 alone is insufficient")
    return {"measurements": rows, "process_wall_seconds": elapsed}


def test_camera(exp):
    exp.case("MIPI-CIM-device-inventory", lambda: {
        "nodes": sorted(glob.glob("/dev/*cim*") + glob.glob("/dev/*vin*") + glob.glob("/dev/video*")),
        "coverage": "inventory only; not proof of sensor capture"})
    exp.case("official-sensor-configurations", lambda: camera_probe(exp, list_only=True))
    exp.case("sensor-capture-and-frame-rate", lambda: camera_probe(exp))


def test_ynr(exp):
    exp.case("YNR1-interfaces", lambda: required(["/dev/ynr1_src", "/dev/ynr1_cap"]))
    exp.case("official-pipeline-build", lambda: camera_probe(exp, list_only=True))
    exp.case("ISP1-YNR1-PYM1-online-denoising", lambda: camera_probe(exp, ynr=True))


def camera_probe(exp, list_only=False, ynr=False):
    command = exp.args.ynr_command if ynr else exp.args.camera_command
    if command and not list_only:
        return finite_pipeline(exp, command, "ynr" if ynr else "camera")
    source = SDK / "sample_pipeline/single_pipe_vin_isp_ynr_pym_gdc/single_pipe_vin_isp_ynr_pym_gdc.c"
    if not hasattr(exp, "camera_binary"):
        exp.camera_binary = sdk_binary(exp, "camera_probe", source, camera=True)
    binary = exp.camera_binary
    if list_only:
        text, _ = exp.command([binary, "--list"], "sensor-configurations")
        return {"configurations": text, "coverage": "available SDK configurations; not proof of attached sensors"}
    if exp.args.sensor is None:
        raise Skip("Select the connected sensor with --sensor INDEX; no sensor is chosen or initialized automatically")
    config = Path(exp.args.gdc_bin) if exp.args.gdc_bin else SDK / "vp_sensors/gdc_bin/imx219_gdc.bin"
    if exp.args.sensor != 0 and not exp.args.gdc_bin:
        raise Skip("Supply --gdc-bin matching this sensor configuration")
    required([config])
    argv = [binary, "-s", exp.args.sensor, "-f", config]
    if exp.args.link_port is not None:
        argv.extend(["-l", exp.args.link_port])
    capture = exp.out / "camera.nv12"
    text, wall = exp.command(argv, "sensor-pipeline", env={
        "HW_CAPTURE": str(capture), "HW_FRAMES": str(exp.args.frames),
        "HW_REQUIRE_YNR": "1" if ynr else "0"})
    from common import records
    rows = records(text)
    if not rows or rows[-1].get("completed_getframe_calls") != exp.args.frames:
        raise RuntimeError("Sensor pipeline did not complete the requested frame count")
    frames = [row for row in rows if row.get("event") == "frame"]
    if not frames:
        raise RuntimeError("No captured frame dimensions")
    return {"measurements": rows, "process_wall_seconds": wall,
            "validation": "bounded frame completion, frame ID progression, dimensions; no denoising image-quality certification",
            **capture_preview(exp, capture, frames[0]["width"], frames[0]["height"], "camera")}


def test_mcu(exp):
    def inventory():
        nodes = list(Path("/sys/class/remoteproc").glob("*mcu*"))
        if not nodes:
            raise Skip("MCU remoteproc interfaces absent")
        return {p.name: {"state": read(p / "state"), "firmware": read(p / "firmware"),
                         "name": read(p / "name")} for p in nodes}
    exp.case("remoteproc-firmware-state", inventory)
    exp.case("IPC-roundtrip-and-real-time-latency",
             lambda: (_ for _ in ()).throw(Skip("Requires matching MCU echo/test firmware and its IPC endpoint; existing firmware is not replaced")))


def test_display(exp):
    def inventory():
        entries = {str(p.parent): {"status": read(p), "modes": read(p.parent / "modes")}
                   for p in Path("/sys/class/drm").glob("card*-*/status")}
        if not entries:
            raise Skip("DRM connectors absent")
        return entries
    exp.case("DRM-connector-modes", inventory)
    exp.case("HDMI-scanout-and-render-rate",
             lambda: (_ for _ in ()).throw(Skip("Needs connected HDMI display and an identified Wayland session")))


def test_storage(exp):
    def io():
        # Ordinary unique file inside results; no raw block-device writes.
        file = exp.out / "storage-test.bin"
        block = os.urandom(1024 * 1024); repeats = 64
        expected = hashlib.sha256(block * repeats).hexdigest()
        start = time.perf_counter()
        with file.open("xb") as f:
            for _ in range(repeats):
                f.write(block)
            f.flush(); os.fsync(f.fileno())
        write_seconds = time.perf_counter() - start
        start = time.perf_counter(); actual = digest(file); read_seconds = time.perf_counter() - start
        if actual != expected:
            raise RuntimeError("Storage readback SHA256 mismatch")
        return {"bytes": len(block) * repeats, "write_fsync_MBps": 64 / write_seconds,
                "cached_read_hash_MBps": 64 / read_seconds,
                "note": "filesystem test; reads may hit page cache, includes hashing; not raw eMMC read speed"}
    exp.case("64MiB-file-write-fsync-readback", io)


def test_network(exp):
    def inventory():
        return {p.name: {k: read(p / k) for k in ["operstate", "speed", "duplex", "carrier", "mtu"]}
                for p in Path("/sys/class/net").iterdir()}
    exp.case("link-state-speed", inventory)
    def throughput():
        if not exp.args.peer:
            raise Skip("Specify --peer for an existing iperf3 server; loopback does not validate physical Ethernet")
        if not shutil.which("iperf3"):
            raise Skip("iperf3 unavailable")
        measurements = []
        for reverse in [False, True]:
            argv = ["iperf3", "-c", exp.args.peer, "-t", "5", "-J"]
            if reverse:
                argv.append("-R")
            text, _ = exp.command(argv, "iperf3-reverse" if reverse else "iperf3-forward")
            value = json.loads(text)
            if value.get("error"):
                raise RuntimeError(value["error"])
            measurements.append(value)
        return {"iperf3": measurements}
    exp.case("physical-link-TCP-forward-and-reverse", throughput)
