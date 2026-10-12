#!/usr/bin/env python3
"""A/B SRS 7.0.162 RTMP delivery on real copy-only 4K input, isolated ports."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
BIN = Path('/opt/ainvr/ffmpeg-8.1.2/bin')


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr')
    image = subprocess.check_output(['docker', 'inspect', '--format',
        '{{.Config.Image}}', 'ainvr-srs'], text=True).strip()
    assert image == 'ossrs/srs:7.0.162'
    config = ROOT / 'deploy/infra/config/srs.conf'
    before = hashlib.sha256(config.read_bytes()).hexdigest()
    result = ROOT / 'test/results' / ('srs-buffer-' +
        datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    result.mkdir(mode=0o700)
    containers, processes, logs, threads = [], [], [], []
    rows = {}
    start = time.monotonic()
    variants = [(100, 12935), (350, 13935)]

    def read(name, process):
        for line in process.stdout:
            parts = dict(p.split('=', 1) for p in line.strip().split('|')
                         if '=' in p)
            if parts.get('dts_time') not in (None, 'N/A'):
                rows[name].append(dict(dts=float(parts['dts_time']),
                                      received=time.monotonic()-start))

    try:
        for latency, port in variants:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', port))
            name = 'ainvr-srs-buffer-' + str(latency) + '-' + str(os.getpid())
            directory = result / str(latency)
            directory.mkdir()
            (directory / 'srs.conf').write_text(f'''
listen 127.0.0.1:{port};
daemon off;
srs_log_tank console;
srs_log_level info;
max_connections 10;
http_api {{ enabled off; }}
http_server {{ enabled off; }}
rtc_server {{ enabled off; }}
vhost __defaultVhost__ {{
    tcp_nodelay on;
    min_latency on;
    play {{ gop_cache on; queue_length 10; mw_latency {latency}; }}
    hls {{ enabled off; }}
}}
''')
            subprocess.run(['docker', 'run', '-d', '--rm', '--network', 'host',
                '--name', name, '-v', str(directory)+':/probe:ro',
                '--entrypoint', './objs/srs', image, '-c', '/probe/srs.conf'],
                check=True, stdout=subprocess.DEVNULL, timeout=20)
            containers.append(name)
        time.sleep(2)
        log = (result / 'publisher.log').open('w')
        logs.append(log)
        command = [str(BIN/'ffmpeg'), '-v', 'warning',
            '-nostdin', '-rw_timeout', '15000000', '-i',
            'http://127.0.0.1:8080/live/xm.flv']
        for _, port in variants:
            command += ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
                        '-f', 'flv', 'rtmp://127.0.0.1:'+str(port)+'/live/probe']
        publisher = subprocess.Popen(command,
            stdout=subprocess.DEVNULL, stderr=log)
        processes.append(publisher)
        time.sleep(2)
        assert publisher.poll() is None, 'copy-only publisher failed at startup'
        for latency, port in variants:
            name = str(latency)
            rows[name] = []
            log = (result / (name+'-reader.log')).open('w')
            logs.append(log)
            process = subprocess.Popen(['stdbuf', '-oL', str(BIN/'ffprobe'),
                '-v', 'error', '-rw_timeout', '15000000',
                '-select_streams', 'v:0', '-show_packets', '-show_entries',
                'packet=dts_time', '-of', 'compact=p=0',
                'rtmp://127.0.0.1:'+str(port)+'/live/probe'],
                stdout=subprocess.PIPE, stderr=log, text=True)
            processes.append(process)
            thread = threading.Thread(target=read, args=(name, process),
                                      daemon=True)
            thread.start()
            threads.append(thread)
        time.sleep(65)
        (result / 'socket-state.txt').write_text(subprocess.check_output(
            ['ss', '-tmni'], text=True, timeout=5))
        assert publisher.poll() is None, 'copy-only publisher stopped'
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        for thread in threads:
            thread.join(timeout=3)
        for name in containers:
            (result / (name+'.log')).write_text(subprocess.check_output(
                ['docker', 'logs', name], stderr=subprocess.STDOUT,
                text=True, timeout=5))
            subprocess.run(['docker', 'stop', '-t', '2', name],
                stdout=subprocess.DEVNULL, check=True, timeout=10)
        for log in logs:
            log.close()
    summaries = {}
    for name, packets in rows.items():
        (result / (name+'-packets.json')).write_text(json.dumps(packets))
        assert len(packets) > 100, name+' insufficient packets'
        steps = [b['dts']-a['dts'] for a,b in zip(packets,packets[1:])]
        summaries[name] = dict(packets=len(packets), max_gap=max(steps),
            gaps=[step for step in steps if step > 0.2],
            backwards=sum(step <= 0 for step in steps),
            media_seconds=packets[-1]['dts']-packets[0]['dts'])
    report = dict(measurements=summaries, image=image,
        buffer_hypothesis_supported=bool(summaries['100']['gaps']) and
            not summaries['350']['gaps'],
        production_configuration_unchanged=before == hashlib.sha256(
            config.read_bytes()).hexdigest(), containers_removed=True,
        source='real HTTP-FLV; compressed copy; identical single-demux input')
    (result/'summary.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2)); print('RESULT',result)


if __name__ == '__main__':
    main()
