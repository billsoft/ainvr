#!/usr/bin/env python3
"""AINVR: source hardware adapter for reused channel/publisher contracts."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import threading
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr')
    assert Path('/mnt/ainvr-ssd').is_mount()
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    result = ROOT / 'test/results' / f'stream-source-{stamp}-{os.getpid()}'
    result.mkdir()
    runtime = ROOT / 'data/ai/test-runtime' / result.name
    runtime.mkdir()
    build = Path(os.environ.get('AINVR_TEST_BUILD_DIR', ROOT/'out/build/ai-api-compat')).resolve()
    assert build.is_relative_to(ROOT/'out/build'), 'Build directory must stay in the AINVR build tree'
    user = subprocess.check_output(['systemctl', 'show', 'ainvr-ai', '--property=User', '--value'], text=True).strip()
    account = pwd.getpwnam(user)
    assert os.geteuid() == 0, 'Run as root to build and launch tests as the production account'
    os.chown(result, account.pw_uid, account.pw_gid)
    os.chown(runtime, account.pw_uid, account.pw_gid)
    with (result / 'build.log').open('w') as log:
        subprocess.run(['cmake', '-S', str(ROOT/'ai-service'), '-B', str(build),
                        '-DAINVR_S100P=ON', '-DBUILD_TESTING=ON'], stdout=log,
                       stderr=subprocess.STDOUT, check=True, timeout=60)
        subprocess.run(['cmake', '--build', str(build), '--target', 'stream_source_test',
                        'compressed_tap_test', 'reused_publisher_test', '-j2'],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=240)
    fixtures = [('h264', '1920x1080', 24, 'libx264', 2),
                ('h265', '640x360', 24, 'libx265', 2),
                ('long', '320x240', 240, 'libx264', 0)]
    with (result / 'fixture.log').open('w') as log:
        for name, size, count, codec, bf in fixtures:
            args = ['/usr/bin/ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
                    '-f', 'lavfi', '-i', f'testsrc2=size={size}:rate=30', '-frames:v', str(count),
                    '-c:v', codec, '-threads', '2', '-preset', 'ultrafast', '-bf', str(bf), '-g', '30']
            if codec == 'libx265':
                args += ['-x265-params', 'pools=1:frame-threads=1:log-level=error']
            args += [str(runtime / (name+'.mp4'))]
            subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        subprocess.run(['/usr/bin/ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
                        '-f', 'lavfi', '-i', 'testsrc2=size=640x320:rate=1', '-frames:v', '1',
                        '-c:v', 'mjpeg', '-threads', '1', str(runtime/'jpeg.jpg')],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=30)
    env = dict(os.environ, LD_LIBRARY_PATH='/usr/hobot/lib',
               AINVR_SOURCE_H264=str(runtime/'h264.mp4'), AINVR_SOURCE_H265=str(runtime/'h265.mp4'),
               AINVR_SOURCE_LONG=str(runtime/'long.mp4'),
               AINVR_SOURCE_JPEG=str(runtime/'jpeg.jpg'),
               AINVR_SOURCE_MISSING=str(runtime/'intentionally-missing.mp4'),
               AINVR_SOURCE_LIVE='rtmp://127.0.0.1:1935/live/xm')
    stop = threading.Event()
    with socket.socket() as server:
        server.bind(('127.0.0.1', 0)); server.listen(1); server.settimeout(1)
        env['AINVR_SOURCE_STALL'] = f'http://127.0.0.1:{server.getsockname()[1]}/stall?secret-token'

        def stall():
            while not stop.is_set():
                try:
                    conn, _ = server.accept()
                except socket.timeout:
                    continue
                with conn:
                    stop.wait(5)

        thread = threading.Thread(target=stall); thread.start()
        try:
            for name, binary in [('source', 'stream_source_test'), ('tap', 'compressed_tap_test'),
                                 ('publisher', 'reused_publisher_test')]:
                with (result / (name+'.log')).open('w') as log:
                    subprocess.run(['runuser', '-u', user, '--', str(build/binary),
                                    '--gtest_output=xml:'+str(result/(name+'.xml'))],
                                   env=env, stdout=log, stderr=subprocess.STDOUT,
                                   check=True, timeout=90)
        finally:
            stop.set(); thread.join(timeout=6)
    suites = [ET.parse(result/(n+'.xml')).getroot() for n in ['source', 'tap', 'publisher']]
    assert all(int(x.attrib.get(k, '0')) == 0 for x in suites for k in ['failures', 'errors', 'disabled'])
    assert all(not x.findall('.//skipped') for x in suites)
    props = {case.attrib['name']: {p.attrib['name']:p.attrib['value']
                                  for p in case.findall('.//property')}
             for case in suites[0].findall('.//testcase')}
    summary = {'passed': True, 'tests_passed': sum(int(x.attrib['tests']) for x in suites),
               'execution_user': user, 'properties': props,
               'source_sha256': hashlib.sha256((ROOT/'ai-service/src/stream/source.cpp').read_bytes()).hexdigest(),
               'decoder_sha256': hashlib.sha256((ROOT/'ai-service/src/platform/vpu_decoder.cpp').read_bytes()).hexdigest(),
               'decode_backend': 'S100P VPU', 'compressed_bytes_unchanged': True,
               'input': 'real 3840x1920 RTMP live/xm plus isolated H.264/H.265 B-frame fixtures',
               'business': 'original publisher and GOP shedding contract',
               'models_inferred': False, 'production_worker_integrated': False,
               'user_configuration_modified': False}
    (result/'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2)); print('RESULT', result)


if __name__ == '__main__':
    main()
