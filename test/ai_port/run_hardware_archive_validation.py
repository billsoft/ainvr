#!/usr/bin/env python3
"""AINVR: original production archive on real GPU/JPU and isolated Mongo.

All fixtures use a dedicated database and SSD scratch directory. A loopback-only
TCP proxy simulates outages for test clients; the shared Mongo service stays up.
Credentials are read in memory and passed only through the child environment.
"""
import json
import argparse
import hashlib
import os
from pathlib import Path
import pwd
import select
import socket
import subprocess
import tempfile
import threading
import time
from urllib.parse import quote
import xml.etree.ElementTree as ET


class MongoProxy:
    def __init__(self, control):
        self.control = control
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.connections = set()
        self.listener = socket.socket()
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen(32)
        self.listener.settimeout(.04)
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def close_connections(self):
        with self.lock:
            for sock in list(self.connections):
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                sock.close()
            self.connections.clear()

    def serve(self):
        previous = None
        while not self.stop.is_set():
            online = not (self.control / 'offline').exists()
            if online != previous:
                if not online:
                    self.close_connections()
                temporary = self.control / 'status.tmp'
                temporary.write_text('online' if online else 'offline')
                temporary.replace(self.control / 'status')
                previous = online
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            if not online:
                client.close()
                continue
            threading.Thread(target=self.forward, args=(client,), daemon=True).start()

    def forward(self, client):
        upstream = None
        try:
            upstream = socket.create_connection(('127.0.0.1', 27017), timeout=2)
            with self.lock:
                self.connections.update((client, upstream))
            client.settimeout(2)
            while not self.stop.is_set() and not (self.control / 'offline').exists():
                readable, _, _ = select.select([client, upstream], [], [], .05)
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is client else client).sendall(data)
        except (OSError, ValueError):
            pass
        finally:
            with self.lock:
                self.connections.discard(client)
                if upstream is not None:
                    self.connections.discard(upstream)
            client.close()
            if upstream is not None:
                upstream.close()

    def close(self):
        self.stop.set()
        self.listener.close()
        self.close_connections()
        self.thread.join(timeout=3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--performance-baseline', action='store_true', help='Only measure the unchanged GPU backend before optimization; not full acceptance')
    parser.add_argument('--build-dir', type=Path, help='Build under out/build; default is the pinned FFmpeg 8 production build')
    options = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    if root != Path('/home/sunrise/ainvr'):
        raise RuntimeError('Run in the authorized board workspace')
    os.chdir(root)
    gpu_source_hash = hashlib.sha256((root / 'ai-service/src/platform/gles_crop.cpp').read_bytes()).hexdigest()
    if options.performance_baseline:
        assert gpu_source_hash == '818e4b0f90bf07252b0c1510dd77550864722f54eb50cd48693530e8125e52eb', 'Baseline requires the unchanged pre-optimization backend'
    subprocess.run(['mountpoint', '-q', '/mnt/ainvr-ssd'], check=True)
    result = root / 'test/results' / ('hardware-archive-' + time.strftime('%Y%m%d-%H%M%S') + '-' + str(os.getpid()))
    result.mkdir()
    build = options.build_dir or root / 'out/build/ai-ffmpeg8'
    if not build.is_absolute():
        build = root / build
    build.resolve().relative_to((root / 'out/build').resolve())
    env = os.environ.copy()
    env['LD_LIBRARY_PATH'] = '/usr/hobot/lib' + (':' + env['LD_LIBRARY_PATH'] if env.get('LD_LIBRARY_PATH') else '')
    env['GSETTINGS_BACKEND'] = 'memory'
    with (result / 'build.log').open('w') as log:
        subprocess.run(['cmake', '-S', 'ai-service', '-B', str(build), '-DAINVR_S100P=ON', '-DBUILD_TESTING=ON',
                        '-DAINVR_FFMPEG_ROOT=/opt/ainvr/ffmpeg-8.1.2'],
                       stdout=log, stderr=subprocess.STDOUT, env=env, check=True, timeout=90)
        subprocess.run(['cmake', '--build', str(build), '--target', 'snapshot_hardware_archive_test',
                        'reused_snapshot_store_test', 'snapshot_crop_gles_test', 'ainvr_s100p_control_service', '-j2'],
                       stdout=log, stderr=subprocess.STDOUT, env=env, check=True, timeout=600)
    user = subprocess.check_output(['systemctl', 'show', 'ainvr-ai', '--property=User', '--value'], text=True).strip() or 'root'
    owner = pwd.getpwnam(user)
    if os.geteuid() != 0 and os.geteuid() != owner.pw_uid:
        raise RuntimeError('Run as root or the configured AI service user')
    scratch_parent = (root / 'data/ai/test-runtime').resolve()
    scratch_parent.mkdir(exist_ok=True, parents=True)
    if os.stat(scratch_parent).st_dev != os.stat('/mnt/ainvr-ssd').st_dev:
        raise RuntimeError('Test scratch must be on external SSD')
    scratch = Path(tempfile.mkdtemp(prefix='hardware-archive-', dir=scratch_parent))
    control = scratch / 'proxy'
    control.mkdir()
    if os.geteuid() == 0:
        for path in (result, scratch, control):
            os.chown(path, owner.pw_uid, owner.pw_gid)
    if os.statvfs(scratch).f_bavail * os.statvfs(scratch).f_frsize < 5 * 1024**3:
        raise RuntimeError('Pending recovery needs 5 GiB free SSD reserve')
    password = (root / 'deploy/infra/secrets/mongo_admin_password').read_text().strip()
    suffix = '/?authSource=admin&serverSelectionTimeoutMS=1500&connectTimeoutMS=500&socketTimeoutMS=2000'
    credentials = 'mongodb://ainvr_admin:' + quote(password, safe='') + '@127.0.0.1:'
    env['AI_SERVICE_TEST_MONGO_URI'] = credentials + '27017' + suffix
    proxy = MongoProxy(control)
    env['AI_SERVICE_TEST_MONGO_PROXY_URI'] = credentials + str(proxy.port) + suffix
    env['AINVR_ARCHIVE_PROXY_CONTROL'] = str(control)
    env['AINVR_ARCHIVE_TEST_ROOT'] = str(scratch)
    env['TMPDIR'] = str(scratch)
    if options.performance_baseline:
        env['AINVR_CONTEXT_BASELINE'] = '1'
    else:
        env.pop('AINVR_CONTEXT_BASELINE', None)
    launcher = ['runuser', '-u', user, '--'] if os.geteuid() == 0 and user != 'root' else []
    try:
        if not options.performance_baseline:
          with (result / 'crop.log').open('w') as log:
            subprocess.run(launcher + [str(build / 'snapshot_crop_gles_test'),
                           '--gtest_output=xml:' + str(result / 'crop.xml')],
                           env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
        with (result / 'hardware.log').open('w') as log:
            selected = ['--gtest_filter=HardwareArchive.Continuous4KErpQueueMeasuresHardwareAndDurability'] if options.performance_baseline else []
            subprocess.run(launcher + [str(build / 'snapshot_hardware_archive_test'),
                           '--gtest_output=xml:' + str(result / 'hardware.xml')] + selected,
                           env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=240)
        if not options.performance_baseline:
          with (result / 'reference.log').open('w') as log:
            subprocess.run([str(build / 'reused_snapshot_store_test'),
                           '--gtest_output=xml:' + str(result / 'reference.xml')],
                           env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
    finally:
        proxy.close()
    if options.performance_baseline:
        suite = ET.parse(result / 'hardware.xml').getroot()
        assert int(suite.attrib['failures']) == 0 and not suite.findall('.//skipped')
        report = {'scope': 'pre-optimization hardware queue performance only; no full acceptance claim',
                  'execution_user': user, 'gpu_source_sha256': gpu_source_hash,
                  'resource_counters_available': False,
                  'properties': {p.attrib['name']: p.attrib['value'] for p in suite.findall('.//property')
                                 if not p.attrib['name'].startswith(('new_contexts_', 'shader_compilations_'))}}
        (result / 'baseline-performance.json').write_text(json.dumps(report, indent=2) + '\n')
        print('Baseline queue performance:', result / 'baseline-performance.json')
        return
    suites = {name: ET.parse(result / (name + '.xml')).getroot() for name in ('crop', 'hardware', 'reference')}
    for suite in suites.values():
        assert int(suite.attrib['failures']) == 0 and int(suite.attrib['errors']) == 0
        assert not suite.findall('.//skipped')
    link = (build / 'CMakeFiles/snapshot_hardware_archive_test.dir/link.txt').read_text()
    assert 'libainvr_reused_snapshot_store.a' in link
    for token in ('libainvr_reused_snapshot_store_reference', 'libainvr_crop_quality_oracle',
                  'libainvr_reference_image_algorithms', 'libainvr_snapshot_jpeg_cpu_reference'):
        assert token not in link
    pending_symbols = subprocess.check_output(['nm', '-C', str(build / 'CMakeFiles/ainvr_reused_snapshot_store.dir/src/output/snapshot_pending.cpp.o')], text=True)
    assert 'cv::imencode' not in pending_symbols and 'cv::imdecode' not in pending_symbols
    summary = {'passed': True, 'execution_user': user,
               'build_directory': str(build),
               'restoration_backend': 'registered S100P BPU; missing HBM rejection tested in real archive',
               'gpu_source_sha256': gpu_source_hash,
               'tested_service_sha256': hashlib.sha256((build / 'ainvr_s100p_control_service').read_bytes()).hexdigest(),
               'hardware_archive_tests': int(suites['hardware'].attrib['tests']),
               'original_archive_regression_tests': int(suites['reference'].attrib['tests']),
               'gpu_crop_quality_tests': int(suites['crop'].attrib['tests']),
               'database': 'ainvr_gpu_snapshot_tests', 'scratch': str(scratch),
               'outage_scope': 'test loopback TCP proxy; production Mongo unchanged',
               'queue_implementation': 'original production SnapshotStore',
               'pending_storage': 'lossless raw RGBA bytes; no CPU PNG codec',
               'pipeline': 'GPU crop/ERP -> optional GPU exposure -> GPU color/padding -> JPU -> Mongo',
               'properties': {p.attrib['name']: p.attrib['value'] for p in suites['hardware'].findall('.//property')},
               'user_models_bpu_ready': False, 'real_inference_to_archive_accepted': False,
               'browser_acceptance_complete': False}
    (result / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print('Production hardware archive integration passed:', result / 'summary.json')


if __name__ == '__main__':
    main()
