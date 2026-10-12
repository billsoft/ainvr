#!/usr/bin/env python3
"""Bounded S100P RTSP -> ingest copy -> SRS -> recorder MP4 component probe.

Uses a synthetic camera, never edits console config or licensing. Each run keeps
its own media and JSON under test/results/non-ai-live/<timestamp>. Production
authorization remains enforced by the running application services.
Run with /home/sunrise/ainvr/.venv/bin/python test/non_ai/live_pipeline.py.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'recording-service/src'))
from recorder.recording_pipeline import RecordingPipeline
from recorder.storage_io import IsolatedIO

spec = importlib.util.spec_from_file_location('ainvr_ingest_probe', ROOT / 'ingest-service/main.py')
ingest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingest)
FF = '/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg'
PROBE = '/opt/ainvr/ffmpeg-8.1.2/bin/ffprobe'
os.environ['INGEST_FFMPEG'] = FF
os.environ['RECORDER_FFMPEG8'] = FF


def checked(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=25)
    if result.returncode:
        raise RuntimeError('Media validation failed: ' + result.stderr[-800:])
    return result.stdout


async def probe_codec(codec, output, host):
    destination = output / codec
    destination.mkdir()
    # Refuse to occupy a port already used by another application.
    with socket.socket() as sock:
        sock.bind(('0.0.0.0', 18554))
    result = {'codec': codec, 'passed': False}
    copy = pipe = None
    io = IsolatedIO()
    with (destination / 'source.log').open('w') as log:
        source = subprocess.Popen(['/usr/bin/python3', str(ROOT / 'ingest-service/tests/media_probe.py'),
            'rtsp', '--codec', codec, '--seconds', '60', '--port', '18554',
            '--result', str(destination / 'source.json')], stdout=log, stderr=log,
            start_new_session=True)
        try:
            for _ in range(30):
                if source.poll() is not None:
                    raise RuntimeError('Synthetic RTSP camera failed; see source.log')
                try:
                    with socket.create_connection(('127.0.0.1', 18554), timeout=.2):
                        break
                except OSError:
                    await asyncio.sleep(.2)
            stream = 'ainvr-probe-' + str(os.getpid()) + '-' + codec
            copy = ingest.CopyProcess({'source': 'rtsp://' + host + ':18554/camera',
                'app': 'live', 'stream': stream, 'transport': 'tcp', 'timeout': 10})
            for _ in range(80):
                if copy.poll() is not None:
                    raise RuntimeError('Ingest stopped, error line count=' + str(copy.errors))
                if copy.frames >= 15:
                    break
                await asyncio.sleep(.2)
            if copy.frames < 15:
                raise RuntimeError('Ingest produced no video')
            pipe = RecordingPipeline(channel_id=stream,
                rtmp_url='rtmp://127.0.0.1:1935/live/' + stream,
                root=str(destination / 'recordings'), segment_seconds=2, io=io,
                soft_cap=16 << 20, hard_cap=24 << 20, codec=codec, settle_sec=0)
            await pipe.start()
            await asyncio.sleep(9)
            if not await pipe.stop(term_timeout=5, kill_timeout=2):
                raise RuntimeError('Recorder did not stop within its budget')
            result['ingest_frames'] = copy.frames
            result['pipeline_error'] = pipe.error
            result['segments'] = []
            for path in sorted((destination / 'recordings').rglob('*.mp4')):
                metadata = json.loads(checked([PROBE, '-v', 'error', '-select_streams', 'v:0',
                    '-count_packets', '-show_entries',
                    'stream=codec_name,codec_tag_string,width,height,nb_read_packets:format=duration',
                    '-of', 'json', str(path)]))
                video = metadata['streams'][0]
                if video['codec_name'] != ('hevc' if codec == 'h265' else 'h264'):
                    raise RuntimeError('Wrong codec in segment')
                if int(video['nb_read_packets']) < 1:
                    raise RuntimeError('Empty recording segment')
                checked([FF, '-hide_banner', '-v', 'error', '-xerror', '-i', str(path),
                         '-map', '0:v:0', '-f', 'null', '-'])
                result['segments'].append({'path': str(path.relative_to(ROOT)), **metadata})
            if len(result['segments']) < 2 or pipe.error:
                raise RuntimeError('Recording did not produce valid segments')
            result['packet_count'] = sum(int(s['streams'][0]['nb_read_packets']) for s in result['segments'])
            if result['packet_count'] < 60:
                raise RuntimeError('Too few recorded packets')
            # System FFmpeg exports a reference frame; the packet pipeline uses FFmpeg 8.
            first = ROOT / result['segments'][0]['path']
            checked(['/usr/bin/ffmpeg', '-hide_banner', '-v', 'error', '-i', str(first),
                     '-frames:v', '1', str(destination / 'frame.jpg')])
            result['passed'] = True
        except Exception as error:
            result['error'] = str(error)
        finally:
            if pipe and not pipe.exited:
                await pipe.stop(term_timeout=2, kill_timeout=2)
            if copy:
                copy.stop()
            io.shutdown()
            if source.poll() is None:
                os.killpg(source.pid, signal.SIGTERM)
                try:
                    source.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(source.pid, signal.SIGKILL)
                    source.wait(timeout=3)
    (destination / 'result.json').write_text(json.dumps(result, indent=2))
    return result


async def main():
    host = os.environ.get('AINVR_PROBE_HOST', '192.168.100.189')
    output = ROOT / 'test/results/non-ai-live' / (time.strftime('%Y%m%d-%H%M%S') + '-' + str(os.getpid()))
    output.mkdir(parents=True)
    # Check an existing SRS; do not launch or restart it.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:1985/api/v1/versions', timeout=3) as response:
        if response.status != 200:
            raise RuntimeError('SRS is not ready')
    results = [await probe_codec(c, output, host) for c in ('h264', 'h265')]
    report = {'scope': 'live component test; production licensing unchanged',
              'passed': all(r['passed'] for r in results), 'codecs': results}
    (output / 'summary.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({'passed': report['passed'], 'result': str(output / 'summary.json')}))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
