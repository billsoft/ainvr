#!/usr/bin/env python3
"""Compare live compressed packet delivery with ingress counters; no mutations."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
PROBE = '/opt/ainvr/ffmpeg-8.1.2/bin/ffprobe'


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr')
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    result = ROOT / 'test/results' / ('srs-delivery-' + stamp)
    result.mkdir(mode=0o700)
    config = ROOT / 'deploy/infra/config/srs.conf'
    before = hashlib.sha256(config.read_bytes()).hexdigest()
    stop = threading.Event()
    samples, errors, readers, processes, logs = [], [], {}, [], []
    start = time.monotonic()

    def ingress():
        while not stop.is_set():
            try:
                with urllib.request.urlopen(
                    'http://127.0.0.1:1985/api/v1/streams', timeout=2
                ) as response:
                    stream = next(s for s in json.load(response)['streams']
                                  if s['app'] == 'live' and s['name'] == 'xm')
                samples.append(dict(wall_seconds=time.monotonic()-start,
                    frames=stream['video_frames'], bytes=stream['recv_bytes'],
                    source_cid=stream['publish']['cid']))
            except Exception as exc:
                errors.append(str(exc))
            stop.wait(0.25)

    def receive(name, process):
        for line in process.stdout:
            fields = dict(part.split('=', 1) for part in line.strip().split('|')
                          if '=' in part)
            if fields.get('dts_time') not in (None, 'N/A'):
                readers[name].append(dict(wall_seconds=time.monotonic()-start,
                    dts=float(fields['dts_time']), flags=fields.get('flags', '')))

    monitor = threading.Thread(target=ingress, daemon=True)
    monitor.start()
    threads = []
    try:
        for name, url in [('rtmp', 'rtmp://127.0.0.1:1935/live/xm'),
                          ('http_flv', 'http://127.0.0.1:8080/live/xm.flv')]:
            readers[name] = []
            log = (result / (name + '.log')).open('w')
            logs.append(log)
            command = ['stdbuf', '-oL', PROBE, '-v', 'error',
                '-rw_timeout', '15000000', '-select_streams', 'v:0',
                '-show_packets', '-show_entries', 'packet=dts_time,flags',
                '-of', 'compact=p=0', url]
            process = subprocess.Popen(command, stdout=subprocess.PIPE,
                                       stderr=log, text=True)
            processes.append(process)
            thread = threading.Thread(target=receive, args=(name, process),
                                      daemon=True)
            thread.start()
            threads.append(thread)
        stop.wait(60)
    finally:
        stop.set()
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        for thread in threads:
            thread.join(timeout=3)
        monitor.join(timeout=3)
        for log in logs:
            log.close()
    (result / 'ingress.json').write_text(json.dumps(samples, indent=2))
    summaries = {}
    for name, rows in readers.items():
        (result / (name + '-packets.json')).write_text(json.dumps(rows))
        assert len(rows) > 10, name + ' insufficient live packets'
        gaps = [dict(previous_dts=a['dts'], next_dts=b['dts'],
                     gap_seconds=b['dts']-a['dts'],
                     received_at=b['wall_seconds'])
                for a, b in zip(rows, rows[1:]) if b['dts']-a['dts'] > 0.2]
        keys = [r['dts'] for r in rows if 'K' in r['flags']]
        summaries[name] = dict(packets=len(rows), gaps=gaps,
            keyframe_dts=keys, media_seconds=rows[-1]['dts']-rows[0]['dts'],
            receipt_seconds=rows[-1]['wall_seconds']-rows[0]['wall_seconds'])
    assert len(samples) > 10, 'insufficient ingress samples'
    spans = [dict(wall_seconds=b['wall_seconds'],
                  interval=b['wall_seconds']-a['wall_seconds'],
                  frames=b['frames']-a['frames'], bytes=b['bytes']-a['bytes'])
             for a, b in zip(samples, samples[1:])]
    report = dict(scope='same-window compressed delivery and ingress',
        measurements=summaries, ingress_top_bursts=sorted(
            spans, key=lambda x: x['frames'], reverse=True)[:12],
        ingress_frames=samples[-1]['frames']-samples[0]['frames'],
        source_cids=sorted({s['source_cid'] for s in samples}),
        errors=errors, continuity_verified=all(not s['gaps']
                                             for s in summaries.values()),
        configuration_unchanged=before == hashlib.sha256(
            config.read_bytes()).hexdigest())
    (result / 'summary.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print('RESULT', result)


if __name__ == '__main__':
    main()
