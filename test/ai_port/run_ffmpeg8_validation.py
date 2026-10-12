#!/usr/bin/env python3
"""AINVR: pinned media ABI, real VPU, original publisher/SEI and isolated API.

User model inference and actual browser playback remain separate acceptance gates.
Existing runners use independent test channels and private service configuration.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr') and os.geteuid() == 0
    assert Path('/mnt/ainvr-ssd').is_mount()
    result = ROOT/'test/results'/('ffmpeg8-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    result.mkdir(mode=0o700)
    user = subprocess.check_output(['systemctl', 'show', 'ainvr-ai', '-p', 'User', '--value'], text=True).strip()
    account = pwd.getpwnam(user)
    license_user = subprocess.check_output(['systemctl', 'show', 'ainvr-license',
        '-p', 'User', '--value'], text=True).strip()
    assert license_user, 'License service must have an explicit Unix account'
    pwd.getpwnam(license_user)
    os.chown(result, account.pw_uid, account.pw_gid)
    build = ROOT/'out/build/ai-ffmpeg8'
    env = dict(os.environ, AINVR_TEST_BUILD_DIR=str(build), LD_LIBRARY_PATH='/usr/hobot/lib')
    with (result/'build.log').open('w') as log:
        subprocess.run(['cmake', '-S', str(ROOT/'ai-service'), '-B', str(build),
            '-DAINVR_S100P=ON', '-DBUILD_TESTING=ON', '-DCMAKE_BUILD_TYPE=RelWithDebInfo',
            '-DAINVR_LICENSE_SERVICE_USER='+license_user],
            stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        subprocess.run(['cmake', '--build', str(build), '--target', 'ffmpeg_runtime_test',
            'ainvr_s100p_control_service', '-j2'], stdout=log, stderr=subprocess.STDOUT,
            check=True, timeout=480)
    with (result/'abi.log').open('w') as log:
        subprocess.run(['runuser', '-u', user, '--', str(build/'ffmpeg_runtime_test'),
            '--gtest_output=xml:'+str(result/'abi.xml')], env=env, stdout=log,
            stderr=subprocess.STDOUT, check=True, timeout=30)
    xml = ET.parse(result/'abi.xml').getroot()
    assert not xml.findall('.//skipped')
    assert all(int(xml.attrib.get(k, '0')) == 0 for k in ['failures', 'errors', 'disabled'])
    print('PASS pinned linked FFmpeg ABI', flush=True)
    reports = {}
    for name, runner in [
        ('source', 'run_stream_source_validation.py'),
        ('sei', 'run_stream_source_sei_validation.py'),
        ('worker', 'run_reused_worker_validation.py'),
        ('controller', 'run_reused_worker_service_validation.py'),
    ]:
        log_path = result/(name+'.log')
        with log_path.open('w') as log:
            subprocess.run(['python3', str(ROOT/'test/ai_port'/runner)], env=env,
                stdout=log, stderr=subprocess.STDOUT, check=True, timeout=420)
        lines = log_path.read_text().splitlines()
        path = Path(next(line.removeprefix('RESULT ') for line in reversed(lines) if line.startswith('RESULT ')))
        assert path.resolve().is_relative_to(ROOT/'test/results')
        report = json.loads((path/'summary.json').read_text())
        assert report['passed']
        reports[name] = {'report': str(path.relative_to(ROOT)/'summary.json'), 'result': report}
        print('PASS', name, flush=True)
    binary = build/'ainvr_s100p_control_service'
    summary = {'passed': True, 'ffmpeg_version': '8.1.2', 'abi_unit_tests': int(xml.attrib['tests']),
        'build': str(build.relative_to(ROOT)), 'license_service_user': license_user,
        'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
        'original_validation_reports': reports, 'user_model_inference_verified': False,
        'actual_browser_playback_verified': False, 'production_binary_changed': False}
    (result/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    print('PASS pinned runtime and media chain; no production rollout yet', flush=True)
    print('RESULT', result, flush=True)


if __name__ == '__main__':
    main()
