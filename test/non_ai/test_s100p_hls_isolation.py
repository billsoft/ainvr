"""Opt-in fault injection against disposable containers, never production."""
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
import socket

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / 'srs-web-console/deploy'
CONFIG = ROOT / 'deploy/infra/config'
IMAGE = 'ossrs/srs:7.0.162'
FFMPEG = '/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg'

def docker(*args, check=True):
    return subprocess.run(['docker', *args], capture_output=True, text=True,
                          check=check, timeout=25)

@unittest.skipUnless(os.getenv('SRS_IO_INTEGRATION') == '1', 'Docker opt-in')
class IsolationTest(unittest.TestCase):
    def test_worker_freeze_crash_and_disk_full_preserve_publisher(self):
        # Fail before creating a container if this host's test ports are occupied.
        for port, kind in [(21935, socket.SOCK_STREAM), (21936, socket.SOCK_STREAM),
                           (21985, socket.SOCK_STREAM), (21880, socket.SOCK_STREAM),
                           (28000, socket.SOCK_DGRAM), (28080, socket.SOCK_DGRAM)]:
            with socket.socket(socket.AF_INET, kind) as probe:
                if kind == socket.SOCK_STREAM:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(('0.0.0.0', port))
                if kind == socket.SOCK_STREAM:
                    probe.listen(1)
        # Fails on the old single-process configuration before touching Docker.
        worker = (CONFIG / 'hls.conf').read_text().replace(':1936;', ':21936;')
        name = 'ainvr-hls-isolation-' + uuid.uuid4().hex[:10]
        pub = None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryFile() as log:
            conf = Path(tmp)
            main = (CONFIG / 'srs.conf').read_text()
            for before, after in [('listen 1935;', 'listen 127.0.0.1:21935;'),
                                  (':1985;', ':21985;'), (':8080;', ':21880;'),
                                  ('listen 8000;', 'listen 28000;'),
                                  ('listen 10080;', 'listen 28080;'),
                                  (':1936;', ':21936;')]:
                main = main.replace(before, after)
            (conf / 'srs.conf').write_text(main)
            (conf / 'hls.conf').write_text(worker.replace('hls_fragment 10;', 'hls_fragment 1;')
                                        .replace('hls_window 30;', 'hls_window 3;')
                                        .replace('hls_dispose 60;', 'hls_dispose 3;'))
            try:
                # This board kernel has no Docker bridge support. Dedicated ports
                # keep the disposable worker separate from the deployed service.
                docker('run', '-d', '--name', name, '--network', 'host',
                       '--ulimit', 'nofile=65536:65536',
                       '--tmpfs', '/run/srs-http:size=32m,mode=0755',
                       '-v', f'{conf}:/usr/local/srs/conf:ro',
                       '-v', f'{DEPLOY / "srs-entrypoint.sh"}:/entrypoint.sh:ro',
                       '--entrypoint', '/bin/sh', IMAGE, '/entrypoint.sh')
                ip = '127.0.0.1'
                def get(path, port=21985):
                    with opener.open(f'http://{ip}:{port}{path}', timeout=2) as r:
                        return r.read()
                def streams():
                    return json.loads(get('/api/v1/streams/'))['streams']
                def wait(fn, timeout=20):
                    deadline = time.monotonic() + timeout
                    while time.monotonic() < deadline:
                        try:
                            if fn(): return
                        except Exception: pass
                        time.sleep(.25)
                    self.fail('condition timed out')
                wait(lambda: streams() == [])
                hevc = os.getenv('SRS_TEST_CODEC') == 'hevc'
                source = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30']
                encoder = ['-c:v', 'libx264', '-x264-params', 'nal-hrd=cbr',
                           '-threads', '1', '-preset', 'ultrafast', '-b:v', '4M',
                           '-minrate', '4M', '-maxrate', '4M', '-bufsize', '4M', '-g', '30']
                if hevc:
                    # The AINVR FFmpeg build supports HEVC enhanced FLV, but has
                    # no x265 encoder. Produce a bounded fixture with Ubuntu's
                    # x265-enabled binary, then stream-copy using FFmpeg 8.
                    fixture = conf / 'source.mp4'
                    subprocess.run(['/usr/bin/ffmpeg', '-nostdin', '-hide_banner',
                        '-loglevel', 'error', *source, '-frames:v', '90',
                        '-c:v', 'libx265', '-preset', 'ultrafast', '-threads', '1',
                        '-x265-params', 'pools=1:frame-threads=1:log-level=error',
                        '-b:v', '4M', '-g', '30', '-an', str(fixture)],
                        check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=log)
                    source = ['-stream_loop', '-1', '-i', str(fixture)]
                    encoder = ['-c:v', 'copy']
                pub = subprocess.Popen([FFMPEG, '-nostdin', '-hide_banner', '-loglevel', 'error',
                    '-re', *source, *encoder, '-an', '-f', 'flv',
                    f'rtmp://{ip}:21935/other-app/isolation'], stdout=subprocess.DEVNULL, stderr=log)
                wait(lambda: len(streams()) == 1)
                cid = streams()[0]['publish']['cid']
                def playlist():
                    path = '/other-app/isolation.m3u8'
                    body = get(path, 21880)
                    if b'#EXT-X-STREAM-INF' in body:
                        uri = next(l.strip() for l in body.decode().splitlines() if l and not l.startswith('#'))
                        body = get(urllib.parse.urljoin(path, uri), 21880)
                    return body
                wait(lambda: b'#EXTINF' in playlist())
                def worker_pid():
                    return docker('exec', name, 'cat', '/run/srs-hls.pid').stdout.strip()
                pid = worker_pid()
                self.assertNotEqual(pid, '1')
                docker('exec', name, 'kill', '-STOP', pid)
                start_bytes = streams()[0]['recv_bytes']
                # Longer than the 10-second forwarding queue. Source must keep flowing.
                for _ in range(14):
                    time.sleep(1)
                    self.assertEqual(streams()[0]['publish']['cid'], cid)
                    self.assertIsNone(pub.poll())
                self.assertGreater(streams()[0]['recv_bytes'], start_bytes + 1000000)
                docker('exec', name, 'kill', '-CONT', pid)
                docker('exec', name, 'kill', '-KILL', pid)
                wait(lambda: worker_pid() != pid)
                old = playlist()
                wait(lambda: playlist() != old)
                self.assertEqual(streams()[0]['publish']['cid'], cid)
                full = docker('exec', name, 'sh', '-c',
                              'dd if=/dev/zero of=/run/srs-http/fill bs=1M count=40', check=False)
                self.assertNotEqual(full.returncode, 0)
                # The error marker must retain even an ENOSPC shorter than
                # the five-second capacity sampling period.
                wait(lambda: docker('exec', name, 'test', '-f', '/dev/shm/srs-hls-io-error', check=False).returncode == 0)
                self.assertEqual(streams()[0]['publish']['cid'], cid)
                self.assertIsNone(pub.poll())
                docker('exec', name, 'rm', '/run/srs-http/fill')
                old = playlist()
                wait(lambda: playlist() != old, 25)
                self.assertEqual(streams()[0]['publish']['cid'], cid)
                self.assertIsNone(pub.poll())
            finally:
                if pub and pub.poll() is None:
                    pub.terminate()
                    try: pub.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pub.kill(); pub.wait(timeout=5)
                if os.getenv('SRS_TEST_VERBOSE'):
                    log.seek(0)
                    print(log.read().decode(errors='replace')[-4000:])
                    logs = docker('logs', name, check=False).stdout
                    print('\n'.join(l for l in logs.splitlines() if any(w in l.lower() for w in
                        ('warn', 'error', '[srs-io]', 'forwarder:', 'hls:')))[-10000:])
                docker('rm', '-f', name, check=False)

if __name__ == '__main__':
    unittest.main()
