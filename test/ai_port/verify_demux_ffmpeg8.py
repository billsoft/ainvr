#!/usr/bin/env python3
"""AINVR bounded RTMP/HTTP-FLV comparison, without decoding or inference.

Pass a local video fixture. Results report measured rates, not codec capacity.
An isolated stream is used; the user's publisher is never stopped or changed.
"""
from pathlib import Path
import argparse
import datetime
import json
import subprocess
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixture', type=Path)
    args = parser.parse_args()
    fixture = args.fixture.resolve(strict=True)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    out = ROOT / 'test/results' / ('demux-ffmpeg8-' + stamp)
    out.mkdir()
    binary = out / 'media_read_probe'
    import os, shlex
    env = dict(os.environ, PKG_CONFIG_PATH='/opt/ainvr/ffmpeg-8.1.2/lib/pkgconfig')
    flags = subprocess.check_output(['pkg-config', '--cflags', '--libs', '--static',
        'libavformat', 'libavcodec', 'libavutil'], env=env, text=True)
    subprocess.run(['g++', '-std=c++17', '-O2', '-I' + str(ROOT/'ai-service/src'),
        str(ROOT/'test/ai_port/media_read_probe.cpp'),
        str(ROOT/'ai-service/src/stream/media_source.cpp'),
        *shlex.split(flags), '-o', str(binary)], check=True, timeout=60)
    stream = 'ainvr_demux_' + uuid.uuid4().hex[:12]
    url = 'rtmp://127.0.0.1:1935/live/' + stream
    summary = {'ffmpeg': '8.1.2 (static SDK)', 'scope': 'Demux only; no inference or hardware capacity claim'}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with (out/'publisher.log').open('w') as log:
        publisher = subprocess.Popen(['/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg',
            '-nostdin', '-v', 'error', '-re', '-stream_loop', '-1', '-i',
            str(fixture), '-map', '0:v:0', '-c', 'copy', '-f', 'flv', url],
            stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 8
            while True:
                with opener.open('http://127.0.0.1:1985/api/v1/streams/', timeout=2) as response:
                    streams = json.load(response)['streams']
                if any(s['name'] == stream for s in streams):
                    break
                assert publisher.poll() is None and time.monotonic() < deadline
                time.sleep(.1)
            for name, source in [('rtmp', url), ('http_flv',
                    'http://127.0.0.1:8080/live/' + stream + '.flv')]:
                result = subprocess.run([str(binary), source, '12'],
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
                (out/(name+'.log')).write_text(result.stdout)
                result.check_returncode()
                samples = [line.split() for line in result.stdout.splitlines()
                           if line.startswith('sample ')]
                warm = [s for s in samples if float(s[1]) >= 3]
                assert len(warm) >= 2, 'Insufficient steady-state samples'
                a, b = warm[0], warm[-1]
                summary[name] = {'steady_packet_fps':
                    (int(b[2])-int(a[2]))/(float(b[1])-float(a[1]))}
        finally:
            if publisher.poll() is None:
                publisher.terminate()
                try:
                    publisher.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    publisher.kill(); publisher.wait(timeout=5)
            (out/'summary.json').write_text(json.dumps(summary, indent=2))
    print(out/'summary.json')


if __name__ == '__main__':
    main()
