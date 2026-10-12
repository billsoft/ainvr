#!/usr/bin/env python3
"""AINVR controlled 4K30 publisher versus online hardware decode + CPU inference.

Creates an independent SRS stream; does not modify the user's camera publisher.
Records actual monotonic durations and separate capture read/submit/receive costs.
"""
from pathlib import Path
import datetime
import json
import os
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
STAMP = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
OUT = ROOT/'test/results'/('capture-cadence-'+STAMP)
WORK = ROOT/'test/runtime'/('capture-cadence-'+STAMP)
OUT.mkdir(); WORK.mkdir()
publisher = worker = None
summary = {'passed': False, 'scope': 'Single 4K30 H264 channel; CPU ONNX inference; not NPU or multichannel throughput'}


def stop(child):
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait(timeout=5)


try:
    source = WORK/'constant-4k30.mp4'
    with (OUT/'encode.log').open('w') as log:
        subprocess.run(['/usr/bin/ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi',
                        '-i', 'testsrc2=size=3840x1920:rate=30', '-frames:v', '60',
                        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2',
                        '-g', '30', '-bf', '0', '-crf', '30', '-n', str(source)],
                       stdout=log, stderr=log, check=True, timeout=120)
    classes = WORK/'classes.json'; classes.write_text(json.dumps([str(i) for i in range(80)]))
    name = 'ainvr_cadence_'+str(os.getpid())
    url = 'rtmp://127.0.0.1:1935/live/'+name
    env = dict(os.environ, LD_LIBRARY_PATH='/usr/hobot/lib:'+str(ROOT/'out/deps/onnxruntime-1.23.2/lib'))
    samples = []
    with (OUT/'publisher.log').open('w') as plog, (OUT/'worker.log').open('w') as wlog:
        publisher = subprocess.Popen(['/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg', '-nostdin',
            '-v', 'error', '-re', '-stream_loop', '-1', '-i', str(source),
            '-map', '0:v:0', '-c', 'copy', '-f', 'flv', url], stdout=plog, stderr=plog)
        time.sleep(2); assert publisher.poll() is None
        started = time.monotonic()
        worker = subprocess.Popen([str(ROOT/'out/build/ai-s100p/ainvr_online_worker_probe'),
            str(ROOT/'ai-service/models/yolo26m.onnx'), url, str(classes), '25',
            str(OUT/'worker.json'), 'allow'], env=env, stdout=wlog, stderr=wlog)
        while time.monotonic()-started < 25:
            with urllib.request.urlopen('http://127.0.0.1:1985/api/v1/streams/', timeout=3) as response:
                streams = json.load(response)['streams']
            stream = next((s for s in streams if s['app']=='live' and s['name']==name), None)
            samples.append({'elapsed_s': time.monotonic()-started,
                            'video_frames': stream['video_frames'] if stream else None})
            time.sleep(1)
        worker.wait(timeout=15); assert worker.returncode == 0
    (OUT/'srs.json').write_text(json.dumps(samples, indent=2))
    report = json.loads((OUT/'worker.json').read_text())
    warm = [s for s in report['timeline'] if s['sample_elapsed_s'] >= 5]
    a, b = warm[0], warm[-1]
    elapsed = b['sample_elapsed_s']-a['sample_elapsed_s']
    received = [s for s in samples if s['elapsed_s'] >= 5 and s['video_frames'] is not None]
    x, y = received[0], received[-1]
    summary.update(status=report['status'], stop_ms=report['stop_ms'],
                   decoded_fps=(b['decoded']-a['decoded'])/elapsed,
                   ingress_fps=(y['video_frames']-x['video_frames'])/(y['elapsed_s']-x['elapsed_s']),
                   capture_phase_ms={k:b[k]-a[k] for k in
                                     ('capture_read_ms','capture_submit_ms','capture_receive_ms')})
    assert report['status']['source_failures'] == 0, report['status']
    assert report['status']['completed'] >= 5
    assert all(s['pending_frames'] <= 1 for s in report['timeline'])
    assert 28 <= summary['ingress_fps'] <= 32, summary
    assert summary['decoded_fps'] >= 28, summary
    summary['passed'] = True
finally:
    stop(worker); stop(publisher)
    (OUT/'summary.json').write_text(json.dumps(summary, indent=2))
    print(OUT/'summary.json', flush=True)
