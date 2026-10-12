"""Bounded smoke test of the deployed AINVR SRS HLS path."""
import json
from pathlib import Path
import subprocess
import time
import urllib.request
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[2]


def main():
    stream = 'ainvr-hls-smoke-' + uuid.uuid4().hex[:12]
    output = ROOT / 'test/results' / stream
    output.mkdir()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with (output / 'publisher.log').open('w') as log:
        process = subprocess.Popen([
            '/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg', '-nostdin', '-hide_banner',
            '-loglevel', 'error', '-re', '-f', 'lavfi', '-i',
            'testsrc2=size=640x360:rate=25', '-t', '40', '-c:v', 'libx264',
            '-threads', '1', '-preset', 'ultrafast', '-g', '25', '-an',
            '-f', 'flv', 'rtmp://127.0.0.1/live/' + stream],
            stdout=subprocess.DEVNULL, stderr=log)
        try:
            deadline = time.monotonic() + 35
            body = b''
            playlist_url = 'http://127.0.0.1:8080/live/' + stream + '.m3u8'
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError('Publisher stopped; inspect publisher.log')
                try:
                    with opener.open(playlist_url, timeout=2) as r:
                        body = r.read()
                    if b'#EXT-X-STREAM-INF' in body:
                        variant = next(line for line in body.decode().splitlines() if line and not line.startswith('#'))
                        playlist_url = urllib.parse.urljoin(playlist_url, variant)
                        continue
                    if b'#EXTINF' in body:
                        break
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
                time.sleep(.5)
            assert b'#EXTINF' in body, 'HLS media playlist did not appear'
            segment = next(line for line in body.decode().splitlines() if line and not line.startswith('#'))
            url = urllib.parse.urljoin(playlist_url, segment)
            with opener.open(url, timeout=3) as r:
                segment_data = r.read()
            assert len(segment_data) > 188, 'Empty HLS segment'
            (output / 'playlist.m3u8').write_bytes(body)
            (output / 'summary.json').write_text(json.dumps({
                'status': 'PASS', 'stream': stream, 'segment_bytes': len(segment_data),
                'scope': 'deployed H264 HLS output; not authenticated browser playback'}, indent=2))
            print(output)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == '__main__':
    main()
