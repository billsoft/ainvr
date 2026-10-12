#!/usr/bin/env python3
"""AINVR online worker: live decode, bounded backlog, license gates, reconnect."""
from pathlib import Path
import argparse
import datetime
import json
import os
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-url', help='Explicit isolated live test source; defaults to user xm stream')
args = parser.parse_args()
OUT = ROOT/'test/results'/('online-worker-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
OUT.mkdir()
CLASSES = OUT/'classes.json'
CLASSES.write_text(json.dumps([str(i) for i in range(80)]))
ENV = dict(os.environ, LD_LIBRARY_PATH='/usr/hobot/lib:'+str(ROOT/'out/deps/onnxruntime-1.23.2/lib'))
PROBE = ROOT/'out/build/ai-s100p/ainvr_online_worker_probe'


def command(url, seconds, mode, name):
    return [str(PROBE), str(ROOT/'ai-service/models/yolo26m.onnx'), url,
            str(CLASSES), str(seconds), str(OUT/(name+'.json')), mode]


def load(name):
    result = json.loads((OUT/(name+'.json')).read_text())
    assert result['stop_ms'] < 12000, result['stop_ms']
    assert all(s['pending_frames'] <= 1 for s in result['timeline'])
    return result


def run(url, seconds, mode, name):
    with (OUT/(name+'.log')).open('w') as log:
        subprocess.run(command(url, seconds, mode, name), env=ENV, stdout=log,
                       stderr=log, check=True, timeout=seconds+25)
    return load(name)


def stop(child):
    if child and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)


summary = {'passed': False, 'runs': {}}
publisher = worker = None
try:
    # Invalid source proves denied/thrown policy is evaluated before opening media.
    for mode in ('deny', 'throw'):
        r = run('/does-not-exist', 1, mode, mode)
        assert r['status']['license_revoked'] and r['status']['state'] == 'error'
        assert r['status']['decoded'] == r['status']['completed'] == 0
        assert r['status']['source_failures'] == 0
        summary['runs'][mode] = r['status']

    url = args.source_url or json.loads((ROOT/'test/inputs/xm.json').read_text())['source_url']
    summary['source_kind'] = 'explicit_test_source' if args.source_url else 'user_xm'
    r = run(url, 12, 'allow', 'xm')
    assert r['status']['completed'] >= 3, r['status']
    assert r['status']['decoded'] > r['status']['completed']
    assert r['status']['superseded_before_inference'] > 0
    assert all(f['frame_width'] == 3840 and f['frame_height'] == 1920 for f in r['frames'])
    assert all(a['frame_index'] < b['frame_index'] for a, b in zip(r['frames'], r['frames'][1:]))
    summary['runs']['xm'] = dict(r['status'], stop_ms=r['stop_ms'])

    r = run(url, 10, 'revoke', 'revoke')
    assert r['status']['license_revoked'] and r['status']['state'] == 'error'
    assert r['status']['completed'] > 0
    revoked = [s for s in r['timeline'] if s['license_revoked']]
    assert revoked and len({s['completed'] for s in revoked}) == 1
    summary['runs']['revoke'] = r['status']

    # Isolated publisher only; never pause or disconnect the user's xm publisher.
    source = ROOT/'test/results/live-xm-20261011-183933-507829/capture.mkv'
    assert source.is_file(), 'Recorded real panorama fixture required'
    isolated = 'rtmp://127.0.0.1:1935/live/ainvr_worker_'+str(os.getpid())
    with (OUT/'publisher.log').open('w') as publog, (OUT/'reconnect.log').open('w') as workerlog:
        def publish():
            return subprocess.Popen(['/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg', '-nostdin',
                '-v', 'error', '-re', '-stream_loop', '-1', '-i', str(source),
                '-map', '0:v:0', '-c', 'copy', '-f', 'flv', isolated], stdout=publog, stderr=publog)
        publisher = publish()
        time.sleep(2)
        assert publisher.poll() is None
        worker = subprocess.Popen(command(isolated, 36, 'allow', 'reconnect'),
                                  env=ENV, stdout=workerlog, stderr=workerlog)
        time.sleep(8)
        stop(publisher)
        # Allow decoder/network buffering to drain before asserting reconnect.
        time.sleep(12)
        publisher = publish()
        worker.wait(timeout=30)
        assert worker.returncode == 0
        r = load('reconnect')
        assert r['status']['source_failures'] > 0
        running = [s for s in r['timeline'] if s['state'] == 'running']
        assert len({s['epoch'] for s in running}) >= 2, r['status']
        first_epoch = running[0]['epoch']
        before = max(s['completed'] for s in running if s['epoch'] == first_epoch)
        assert r['status']['completed'] > before
        summary['runs']['reconnect'] = dict(r['status'], stop_ms=r['stop_ms'])
    summary['passed'] = True
finally:
    stop(worker)
    stop(publisher)
    (OUT/'summary.json').write_text(json.dumps(summary, indent=2))
    print(OUT/'summary.json', flush=True)
