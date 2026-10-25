#!/usr/bin/env python3
"""Bounded loopback-only ZLM API smoke test; not a media acceptance test."""
import configparser
import hashlib
import json
from pathlib import Path
import secrets
import socket
import subprocess
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "out/gb28181/ZLMediaKit"
BINARY = SOURCE / "release/linux/Release/MediaServer"
OUTPUT = ROOT / "test/results/gb28181/zlm-smoke"


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    config = configparser.ConfigParser(interpolation=None, strict=False)
    config.optionxform = str
    config.read(SOURCE / "conf/config.ini")
    token = secrets.token_hex(32)
    for section, changes in {
        "api": {"secret": token},
        "general": {"listen_ip": "127.0.0.1"},
        "http": {"port": "19580", "sslport": "0"},
        "rtsp": {"port": "19554", "sslport": "0"},
        "rtmp": {"port": "0", "sslport": "0"},
        "rtp_proxy": {"port": "0"},
        "srt": {"port": "0"},
        "rtc": {"port": "0", "tcpPort": "0", "enableTurn": "0"},
        "onvif": {"port": "0"},
        "shell": {"port": "0"},
        "hook": {"enable": "0"},
        "protocol": {"enable_mp4": "0", "enable_hls": "0", "enable_hls_fmp4": "0", "enable_rtmp": "0", "enable_rtsp": "1"},
    }.items():
        if section not in config:
            config[section] = {}
        config[section].update(changes)
    config_path = OUTPUT / "private.ini"
    with config_path.open("w") as f:
        config.write(f, space_around_delimiters=False)
    config_path.chmod(0o600)
    # Refuse to disturb an existing service or test on these fixed test ports.
    probes = []
    try:
        for port, kind in [(19580, socket.SOCK_STREAM), (19554, socket.SOCK_STREAM), (32000, socket.SOCK_DGRAM)]:
            s = socket.socket(socket.AF_INET, kind)
            s.bind(("127.0.0.1", port))
            probes.append(s)
    finally:
        for s in probes:
            s.close()

    def call(operation, **params):
        data = urllib.parse.urlencode({"secret": token, **params}).encode()
        request = urllib.request.Request(f"http://127.0.0.1:19580/index/api/{operation}", data=data)
        with urllib.request.urlopen(request, timeout=2) as response:
            result = json.load(response)
        if result.get("code") != 0:
            raise RuntimeError(f"ZLM operation failed: {operation}")
        return result

    with (OUTPUT / "process.log").open("wb") as log:
        process = subprocess.Popen([str(BINARY), "-c", str(config_path), "-t", "2", "--affinity", "0", "-l", "4", "--log-dir", str(OUTPUT / "logs"), "--log-size", "2", "--log-slice", "2"], stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 12
            while True:
                if process.poll() is not None:
                    raise RuntimeError("ZLM exited before readiness")
                try:
                    call("getApiList")
                    break
                except (OSError, RuntimeError):
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.2)
            for mode in (0, 1, 2):
                stream = f"ainvr_smoke_{mode}"
                result = call("openRtpServer", port=32000, stream_id=stream, tcp_mode=mode, local_ip="127.0.0.1", ssrc=123456, re_use_port=0)
                assert result["port"] == 32000
                result = call("closeRtpServer", stream_id=stream)
                assert result["hit"] == 1
                assert call("closeRtpServer", stream_id=stream)["hit"] == 0
            report = {"result": "passed", "scope": "loopback API and port lifecycle only", "mediaVerified": False, "binarySha256": hashlib.sha256(BINARY.read_bytes()).hexdigest(), "modes": ["udp", "tcp-passive", "tcp-active"]}
            (OUTPUT / "report.json").write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report))
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
            config_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
