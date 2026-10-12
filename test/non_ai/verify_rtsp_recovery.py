#!/usr/bin/env python3
"""Bounded RTSP copy/recovery acceptance with real SRS and S100P VPU.

GStreamer creates synthetic camera fixtures only. Production CopyProcess and
Supervisor run unchanged against private streams; no model inference is claimed.
"""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = '/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg'


def wait(predicate, seconds, description, tick=None):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if tick:
            tick()
        if predicate():
            return
        time.sleep(.15)
    raise AssertionError(description)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private_address():
    addresses = json.loads(subprocess.check_output(
        ['ip', '-j', 'address', 'show', 'eth0'], text=True, timeout=5))
    return next(a['local'] for interface in addresses for a in interface['addr_info']
                if a['family'] == 'inet')


def port_ready(address, port):
    try:
        with socket.create_connection((address, port), timeout=.2):
            return True
    except OSError:
        return False


def stop(child):
    if child.poll() is None:
        # Also works for the explicitly paused test camera.
        child.send_signal(signal.SIGCONT)
        child.terminate()
        try:
            child.wait(timeout=4)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=4)


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr')
    assert Path('/mnt/ainvr-ssd').is_mount() and os.geteuid() == 0
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + str(os.getpid())
    result = ROOT / 'test/results' / ('rtsp-recovery-' + stamp)
    result.mkdir()
    work = ROOT / 'data/ai/test-runtime' / result.name
    work.mkdir()
    build = ROOT / 'out/build/ai-ffmpeg8'
    production = ROOT / 'deploy/s100p/bin/ainvr_ai_service'
    protected = [ROOT/'data/recorder/config.json',
                 ROOT/'deploy/s100p/runtime/recorder.env', production,
                 ROOT/'ingest-service/main.py']
    before = {str(p): digest(p) for p in protected}
    spec = importlib.util.spec_from_file_location('production_ingest', ROOT/'ingest-service/main.py')
    ingest = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ingest)
    user = subprocess.check_output(['systemctl', 'show', 'ainvr-ai', '-p', 'User', '--value'],
                                   text=True, timeout=5).strip()
    address = private_address()
    cameras = []
    owned = []
    records = []
    sup = ingest.Supervisor()
    env = dict(os.environ, LD_LIBRARY_PATH='/usr/hobot/lib')

    def cancelled(_signal, _frame):
        # Supervisors and synthetic camera processes must be cleaned up when a
        # bounded external harness requests termination, just as on Ctrl-C.
        raise KeyboardInterrupt('RTSP acceptance interrupted')

    signal.signal(signal.SIGTERM, cancelled)

    def camera(codec, name, port=None):
        if port is None:
            with socket.socket() as reservation:
                reservation.bind(('0.0.0.0', 0))
                port = reservation.getsockname()[1]
        log = (result/(name+'-camera.log')).open('w')
        child = subprocess.Popen(['/usr/bin/python3', str(ROOT/'ingest-service/tests/media_probe.py'),
            'rtsp', '--codec', codec, '--port', str(port), '--seconds', '240',
            '--result', str(result/(name+'-camera.json'))], stdout=log,
            stderr=subprocess.STDOUT, start_new_session=True)
        log.close()
        cameras.append(child)
        wait(lambda: port_ready(address, port), 10, 'Synthetic RTSP camera did not listen')
        assert child.poll() is None
        return child, port

    def config(codec, transport, port, suffix):
        identity = 'ainvr-rtsp-' + stamp + '-' + suffix
        return {'id': identity, 'generation': '1', 'source': f'rtsp://{address}:{port}/camera',
                'app': 'live', 'stream': identity, 'transport': transport, 'timeout': 3}

    def reconcile(configs):
        sup.reconcile(configs, True)
        for job in sup.jobs.values():
            p = job['process']
            if p is not None and p not in owned:
                owned.append(p)

    def running(c, minimum=30):
        job = sup.jobs.get(c['id'])
        return bool(job and job['process'] and job['process'].poll() is None
                    and job['process'].frames >= minimum and job['state'] == 'streaming')

    def capture(c, codec, name):
        # The shipped FFmpeg intentionally has TS, FLV and MOV muxers, not raw
        # elementary-stream muxers. TS retains Annex-B packets for the VPU probe.
        output = work/(name+'.ts')
        args = [FFMPEG, '-nostdin', '-hide_banner', '-loglevel', 'error',
                '-rw_timeout', '5000000', '-i', 'rtmp://127.0.0.1:1935/live/'+c['stream'],
                '-map', '0:v:0', '-an', '-frames:v', '15', '-c:v', 'copy',
                '-bsf:v', 'h264_mp4toannexb' if codec == 'h264' else 'hevc_mp4toannexb',
                '-f', 'mpegts', str(output)]
        with (result/(name+'-capture.log')).open('w') as log:
            subprocess.run(args, stdout=log, stderr=subprocess.STDOUT,
                           check=True, timeout=20)
        with (result/(name+'-vpu.log')).open('w') as log:
            subprocess.run(['runuser', '-u', user, '--', str(build/'ainvr_decode_probe'),
                            str(output), '640', '320', '15'], env=env,
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=20)
        text = (result/(name+'-vpu.log')).read_text()
        start = text.find('{\n')
        data, _ = json.JSONDecoder().raw_decode(text[start:])
        assert data['decoded_frames'] == data['expected_frames'] == 15
        assert (data['width'], data['height']) == (640, 320)
        assert 0 < data['mean_y'] < 255
        return data

    try:
        with (result/'build.log').open('w') as log:
            subprocess.run(['cmake', '--build', str(build), '--target', 'ainvr_decode_probe', '-j2'],
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
        for codec in ['h264', 'h265']:
            for transport in ['tcp', 'udp']:
                name = codec+'-'+transport
                child, port = camera(codec, name+'-before')
                c = config(codec, transport, port, name)
                tick = lambda: reconcile([c])
                wait(lambda: running(c), 25, name+' initial ingest failed', tick)
                old = sup.jobs[c['id']]['process']
                original_pid = old.proc.pid
                first = capture(c, codec, name+'-before')
                stop(child)
                outage = time.monotonic()
                wait(lambda: sup.jobs[c['id']]['failures'] >= 1 and old.poll() is not None,
                     18, name+' did not enter recovery after actual camera exit', tick)
                retry_count = sup.jobs[c['id']]['failures']
                child, _ = camera(codec, name+'-after', port)
                wait(lambda: running(c), 35, name+' did not recover after camera restart', tick)
                recovery_seconds = time.monotonic()-outage
                replacement = sup.jobs[c['id']]['process']
                assert replacement.proc.pid != original_pid
                recovered = capture(c, codec, name+'-after')
                record = {'codec': codec, 'transport': transport, 'passed': True,
                          'before_vpu': first, 'after_vpu': recovered,
                          'retries_observed': retry_count, 'old_pid': original_pid,
                          'new_pid': replacement.proc.pid,
                          'outage_to_recovery_seconds': recovery_seconds,
                          'outage_to_vpu_validation_seconds': time.monotonic()-outage}
                records.append(record)
                print(json.dumps(record), flush=True)
                reconcile([])
                assert old.poll() is not None and replacement.poll() is not None
                stop(child)

        # One stalled camera must not stop another input handled by the same supervisor.
        first, port_a = camera('h264', 'stall-a')
        second, port_b = camera('h265', 'healthy-b')
        a = config('h264', 'tcp', port_a, 'stall-a')
        b = config('h265', 'udp', port_b, 'healthy-b')
        tick = lambda: reconcile([a, b])
        wait(lambda: running(a) and running(b), 25, 'Concurrent inputs failed', tick)
        healthy = sup.jobs[b['id']]['process']
        frames = healthy.frames
        first.send_signal(signal.SIGSTOP)
        wait(lambda: sup.jobs[a['id']]['failures'] >= 1, 20,
             'Stalled camera did not trigger bounded recovery', tick)
        assert healthy.poll() is None and healthy.frames > frames + 30
        assert sup.jobs[b['id']]['process'] is healthy and sup.jobs[b['id']]['failures'] == 0
        first.send_signal(signal.SIGCONT)
        wait(lambda: running(a), 35, 'Paused camera did not recover', tick)
        evidence = capture(b, 'h265', 'healthy-during-recovery')
        records.append({'passed': True, 'case': 'concurrent_stall_isolation',
                        'healthy_frames_during_stall': healthy.frames-frames,
                        'healthy_process_preserved': True, 'vpu': evidence})
    finally:
        # Exact owned handles only; no production workers/configuration are touched.
        for child in cameras:
            if child.poll() is None:
                child.send_signal(signal.SIGCONT)
        reconcile([])
        for child in cameras:
            stop(child)
        assert all(p.poll() is not None for p in owned)
        assert {str(p): digest(p) for p in protected} == before
        summary = {'passed': len(records) == 5 and all(r['passed'] for r in records),
                   'cases': records, 'production_files_unchanged': True,
                   'camera_fixture': 'GStreamer synthetic source; CPU encoding is test-only',
                   'ingest': 'unchanged production CopyProcess and Supervisor, FFmpeg stream copy',
                   'decode': 'real S100P VPU as production AI account',
                   'user_model_inference_verified': False, 'browser_playback_verified': False,
                   'production_service_end_to_end_verified': False,
                   'scope': 'RTSP TCP/UDP H264/H265 recovery and concurrent stall isolation',
                   'all_owned_processes_stopped': True,
                   'execution_user': user,
                   'runner_sha256': digest(Path(__file__)),
                   'scope_resolution': [640, 320],
                   'vpu_frames_verified': sum(r.get('before_vpu', {}).get('decoded_frames', 0)
                       + r.get('after_vpu', {}).get('decoded_frames', 0)
                       + r.get('vpu', {}).get('decoded_frames', 0) for r in records),
                   'ingest_source_sha256': before[str(ROOT/'ingest-service/main.py')]}
        (result/'summary.json').write_text(json.dumps(summary, indent=2))
        print('RESULT', result, flush=True)
    assert summary['passed']


if __name__ == '__main__':
    main()
