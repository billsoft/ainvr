"""Opt-in Docker integration: SRS_IO_INTEGRATION=1 python3 <this file>.

Uses an isolated container without published ports; never touches production.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import urllib.request
import urllib.parse
import uuid


DEPLOY = Path(__file__).resolve().parents[1]
IMAGE = "ossrs/srs:7.0.162"
FFMPEG = "/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg"


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, capture_output=True,
                          text=True, timeout=30)


@unittest.skipUnless(os.environ.get("SRS_IO_INTEGRATION") == "1",
                     "explicit opt-in required for Docker integration")
class SrsIOIntegration(unittest.TestCase):
    def test_storage_guard_and_hls_failure_isolation(self):
        name = "ainvr-srs-io-test-" + uuid.uuid4().hex[:12]
        publishers = []
        with tempfile.TemporaryDirectory(prefix="ainvr-srs-io-") as temp:
            config = Path(temp) / "srs.conf"
            text = (DEPLOY / "srs-conf/srs.conf").read_text()
            worker = (DEPLOY / "srs-conf/hls.conf").read_text()
            worker = worker.replace("hls_fragment 10;", "hls_fragment 1;")
            worker = worker.replace("hls_window 30;", "hls_window 3;")
            worker = worker.replace("hls_dispose 60;", "hls_dispose 5;")
            worker_config = Path(temp) / "hls.conf"
            worker_config.write_text(worker)
            config.write_text(text)
            args = ["--network", "bridge", "--entrypoint", "/bin/sh",
                    "-v", f"{temp}:/usr/local/srs/conf:ro",
                    "-v", f"{DEPLOY / 'srs-entrypoint.sh'}:/entrypoint.sh:ro"]
            rejected = docker("run", "--rm", *args, IMAGE, "/entrypoint.sh",
                              check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("must be a tmpfs", rejected.stdout + rejected.stderr)

            # A mounted tmpfs is insufficient if config still points at disk.
            worker_config.write_text(worker.replace("hls_path /run/srs-http;",
                                           "hls_path ./objs/nginx/html;"))
            rejected = docker("run", "--rm", *args, "--tmpfs",
                              "/run/srs-http:size=64m,mode=0755", IMAGE,
                              "/entrypoint.sh", check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("roots must use", rejected.stdout + rejected.stderr)
            config.write_text(text)
            worker_config.write_text(worker)

            publisher_logs = []
            try:
                docker("run", "-d", "--name", name, *args, "--tmpfs",
                       "/run/srs-http:size=64m,mode=0755", IMAGE, "/entrypoint.sh")
                ip = docker("inspect", name, "--format",
                            "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}").stdout.strip()
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

                def streams():
                    with opener.open(f"http://{ip}:1985/api/v1/streams/", timeout=3) as response:
                        return json.load(response)["streams"]

                def wait_until(fn, timeout=12):
                    deadline = time.monotonic() + timeout
                    last = None
                    while time.monotonic() < deadline:
                        try:
                            if fn():
                                return
                        except Exception as exc:
                            last = exc
                        time.sleep(0.25)
                    self.fail(f"condition timed out: {last}")

                wait_until(lambda: streams() == [])
                with opener.open(f"http://{ip}:8080/index.html", timeout=3) as response:
                    self.assertEqual(response.status, 200)
                for app in ["live", "other-app"]:
                    publisher_log = tempfile.TemporaryFile()
                    publisher_logs.append(publisher_log)
                    publishers.append(subprocess.Popen([
                        FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-re", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10",
                        "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast",
                        "-g", "10", "-an", "-f", "flv", f"rtmp://{ip}/{app}/io-test",
                    ], stdout=subprocess.DEVNULL, stderr=publisher_log))

                def playlists_ready():
                    for app in ["live", "other-app"]:
                        url = f"http://{ip}:8080/{app}/io-test.m3u8"
                        with opener.open(url, timeout=3) as response:
                            playlist = response.read().decode()
                        if "#EXT-X-STREAM-INF" in playlist:
                            media_uri = next(line.strip() for line in playlist.splitlines()
                                             if line.strip() and not line.startswith("#"))
                            with opener.open(urllib.parse.urljoin(url, media_uri), timeout=3) as response:
                                playlist = response.read().decode()
                        if "#EXTINF" not in playlist:
                            return False
                    return True

                wait_until(playlists_ready)
                self.assertEqual(len(streams()), 2)
                # Deliberately fill only the disposable 64MB tmpfs.
                full = docker("exec", name, "sh", "-c",
                              "dd if=/dev/zero of=/run/srs-http/test-fill bs=4096 count=20000",
                              check=False)
                self.assertNotEqual(full.returncode, 0)
                self.assertIn("No space left", full.stderr)
                def hls_failed():
                    return any("hls" in line.lower() and "failed" in line.lower()
                               for line in docker("logs", name).stdout.splitlines())
                wait_until(hls_failed)
                time.sleep(3)
                self.assertTrue(all(p.poll() is None for p in publishers))
                self.assertEqual(len(streams()), 2)
                self.assertTrue(all(s["publish"]["active"] for s in streams()))
                print("PASS: mount/config guard; static assets; two app playlists; "
                      "ENOSPC preserves both RTMP publishers and API")
            except Exception:
                logs = docker("logs", "--tail", "40", name, check=False)
                print(logs.stdout + logs.stderr)
                for publisher_log in publisher_logs:
                    publisher_log.seek(0)
                    print(publisher_log.read().decode(errors="replace")[-2000:])
                raise
            finally:
                for publisher in publishers:
                    if publisher.poll() is None:
                        publisher.terminate()
                        try:
                            publisher.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            publisher.kill()
                            publisher.wait(timeout=5)
                docker("rm", "-f", name, check=False)
                for publisher_log in publisher_logs:
                    publisher_log.close()


if __name__ == "__main__":
    unittest.main()
