#!/usr/bin/env python3
"""AINVR: MP4 B-frame timestamps, RTMP ingestion and bounded stalled input."""
from pathlib import Path
import datetime
import json
import os
import socket
import subprocess
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]


def main():
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    work = ROOT / 'test/runtime' / ('media-source-' + stamp)
    out = ROOT / 'test/results' / ('media-source-' + stamp)
    work.mkdir();out.mkdir()
    video = work / 'bframes.mp4'
    subprocess.run(['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=15', '-frames:v', '12',
        '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-bf', '2',
        '-g', '12', str(video)], check=True, timeout=45)
    classes = work / 'classes.json';classes.write_text('["face"]')
    env = dict(os.environ, LD_LIBRARY_PATH='/usr/hobot/lib:' + str(ROOT / 'out/deps/onnxruntime-1.23.2/lib'))
    base = [str(ROOT / 'out/build/ai-s100p/ainvr_pipeline_probe'),
            str(ROOT / 'ai-service/models/derived/s100p/scrfd_10g_kps_640.onnx')]

    def run(name, source, count=3):
        report = out / (name + '.json')
        with (out / (name + '.log')).open('w') as log:
            subprocess.run([*base, source, 'scrfd', str(count), str(report), str(classes)],
                           env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=40)
        frames = json.loads(report.read_text())['frames']
        assert len(frames) == count
        assert all(f['decode_backend'] == 'vpu-jpu' for f in frames)
        assert all(f['preprocess_backend'] == 'pym+gles-color' for f in frames)
        assert all(not f['fallback_reasons'] for f in frames)
        return frames

    bframes = run('bframes', str(video), 12)
    expected = [round(i * 1e9 / 15) for i in range(12)]
    assert all(abs(f['source_pts_ns']-p)<=1 for f,p in zip(bframes,expected))
    no_b = work / 'no-bframes.mp4'
    subprocess.run(['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(video),
        '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-bf', '0', '-g', '12',
        str(no_b)], check=True, timeout=45)
    video = no_b
    frames = run('mp4', str(video), 12)
    expected = [round(i * 1e9 / 15) for i in range(12)]
    actual = [f['source_pts_ns'] for f in frames]
    assert all(abs(a-b) <= 1 for a, b in zip(actual, expected)), actual
    stream = 'ainvr-source-test-' + uuid.uuid4().hex[:12]
    url = 'rtmp://127.0.0.1/live/' + stream
    with (out / 'publisher.log').open('w') as log:
        publisher = subprocess.Popen(['/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg', '-nostdin',
            '-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1',
            '-i', str(video), '-c:v', 'copy', '-an', '-f', 'flv', url],
            stdout=subprocess.DEVNULL, stderr=log)
        try:
            # Wait on the actual SRS stream, not an arbitrary startup delay.
            import urllib.request
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            deadline = time.monotonic() + 8
            while True:
                with opener.open('http://127.0.0.1:1985/api/v1/streams/', timeout=2) as response:
                    streams = json.load(response)['streams']
                if any(s['name'] == stream for s in streams):break
                assert publisher.poll() is None and time.monotonic() < deadline
                time.sleep(.1)
            live = run('rtmp', url)
            assert all(f['source_pts_ns'] is not None for f in live)
            assert all(a['source_pts_ns'] < b['source_pts_ns'] for a,b in zip(live,live[1:]))
        finally:
            publisher.terminate()
            try:publisher.wait(timeout=5)
            except subprocess.TimeoutExpired:publisher.kill();publisher.wait(timeout=5)

    stop = threading.Event()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0));listener.listen(1);listener.settimeout(10)
        port = listener.getsockname()[1]
        def stall():
            try:
                conn, _ = listener.accept()
                with conn:stop.wait(10)
            except socket.timeout:pass
        thread = threading.Thread(target=stall);thread.start()
        start = time.monotonic()
        try:
            result = subprocess.run([*base, f'http://127.0.0.1:{port}/stall', 'scrfd', '1',
                str(out / 'stall.json'), str(classes)], env=env, capture_output=True, text=True, timeout=12)
            elapsed = time.monotonic() - start
            assert result.returncode != 0 and elapsed < 10
            assert not (out / 'stall.json').exists()
            (out / 'stall.log').write_text(result.stdout + result.stderr)
        finally:stop.set();thread.join(timeout=11)
    summary = {'status': 'PASS', 'mp4_frames': len(frames), 'mp4_pts_ns': actual,
               'bframes': '12 hardware-decoded frames mapped to source presentation timestamps',
               'rtmp_frames': len(live), 'stalled_source_seconds': elapsed,
               'scope': 'bounded input integration; CPU inference; not deployed AI channel service'}
    (out / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary));print(out)


if __name__ == '__main__':main()
