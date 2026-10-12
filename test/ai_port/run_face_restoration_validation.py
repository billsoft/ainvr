#!/usr/bin/env python3
"""AINVR: verify original restoration pixel rules on the S100P Mali GPU.

Run in /home/sunrise/ainvr:
  python3 test/ai_port/run_face_restoration_validation.py --build

The runner uses sunrise, isolated SSD scratch, a 120-second test deadline and
saved GoogleTest XML. OpenCV image math exists only in the test oracle. Measured
FPS covers GPU preparation/blending and transfers; it excludes model inference.
Synthetic tensor outputs and invalid byte fixtures test the pixel path and
metadata guards. No executable model is substituted or executed by this suite.

Production model contract: GPEN=256, CodeFormer=512; one float32 RGB NCHW input
and output [1,3,S,S]. The original cubic/gray128 letterbox, /127.5-1 normalization,
blend clipping and uint8 truncation are preserved. A CodeFormer fidelity input
must be fixed during export, as the original interface takes only an image.
HBM needs a matching .hbm.ainvr.json contract and SHA256. A metadata contract
does not prove model quality: real HBM inference and accuracy remain separate.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import subprocess
import tempfile
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    if root != Path('/home/sunrise/ainvr') or os.geteuid() != 0:
        raise SystemExit('Run as root in the authorized board workspace')
    ssd = Path('/mnt/ainvr-ssd')
    if not ssd.is_mount():
        raise SystemExit('Mount the AINVR SSD for test scratch')
    build = root / 'out/build/ai-ffmpeg8'
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    result = root / 'test/results' / ('face-restoration-' + stamp)
    result.mkdir()
    account = pwd.getpwnam('sunrise')
    os.chown(result, account.pw_uid, account.pw_gid)
    if args.build:
        with (result / 'build.log').open('w') as log:
            subprocess.run(['cmake', '-S', str(root / 'ai-service'), '-B', str(build),
                            '-DAINVR_S100P=ON', '-DBUILD_TESTING=ON',
                            '-DAINVR_FFMPEG_ROOT=/opt/ainvr/ffmpeg-8.1.2'],
                           check=True, stdout=log, stderr=subprocess.STDOUT, timeout=90)
            subprocess.run(['cmake', '--build', str(build), '--target',
                            'face_restore_test', 'ainvr_s100p_control_service', '-j2'],
                           check=True, stdout=log, stderr=subprocess.STDOUT, timeout=600)
    test = build / 'face_restore_test'
    production = build / 'ainvr_s100p_control_service'
    if not test.is_file() or not production.is_file():
        raise SystemExit('Build the targets first, or pass --build')
    scratch_parent = ssd / 'test-scratch'
    scratch_parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='face-restoration-', dir=scratch_parent) as temp:
        os.chown(temp, account.pw_uid, account.pw_gid)
        environment = os.environ.copy()
        environment.update(TMPDIR=temp, LD_LIBRARY_PATH='/usr/hobot/lib',
                           AINVR_DRM_RENDER_NODE='/dev/dri/renderD128')
        environment.pop('HW_WAYLAND_SOCKET', None)
        xml = result / 'tests.xml'
        with (result / 'tests.log').open('w') as log:
            run = subprocess.run(['runuser', '-u', 'sunrise', '--', str(test),
                                  '--gtest_output=xml:' + str(xml)],
                                 env=environment, stdout=log, stderr=subprocess.STDOUT,
                                 timeout=120)
    tree = ET.parse(xml).getroot()
    counts = {key: int(tree.get(key, '0')) for key in ('tests', 'failures', 'errors', 'disabled')}
    skipped = len(list(tree.iter('skipped')))
    drivers = []
    for line in (result / 'tests.log').read_text().splitlines():
        if line.startswith('HWJSON '):
            try:
                drivers.append(json.loads(line[7:]))
            except json.JSONDecodeError:
                pass  # Concurrent context diagnostics may interleave; one valid real driver is required.
    actual_gpu = any('Mali' in entry.get('renderer', '') for entry in drivers)
    properties = {}
    for case in tree.iter('testcase'):
        properties[case.get('name')] = {
            item.get('name'): item.get('value') for item in case.iter('property')}
    symbols = subprocess.check_output(['nm', '-C', '-u', str(build /
        'CMakeFiles/ainvr_face_restore_gles.dir/src/platform/face_restore_gles.cpp.o')], text=True)
    forbidden = ('cv::resize(', 'cv::cvtColor(', 'cv::addWeighted(', 'cv::split(', 'cv::merge(')
    cpu_image_math_absent = not any(token in symbols for token in forbidden)
    link = (build / 'CMakeFiles/ainvr_s100p_control_service.dir/link.txt').read_text()
    oracle_absent = not any(token in link for token in
        ('face_restore_test', 'ainvr_reference_image_algorithms', 'ainvr_exposure_cpu_reference',
         'ainvr_snapshot_jpeg_cpu_reference', 'onnxruntime', 'nvinfer', 'cudart'))
    runtime = subprocess.check_output([str(production), '--runtime-info'], text=True, timeout=10)
    # The SDK emits version diagnostics before main, even without loading a model.
    runtime_records = []
    for line in runtime.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and 'version' in item and 'ffmpeg' in item:
            runtime_records.append(item)
    if len(runtime_records) != 1:
        raise RuntimeError('Expected one unambiguous service runtime record')
    report = {'checked_at': datetime.datetime.now().isoformat(), 'test_counts': counts,
              'skipped': skipped, 'real_mali_driver': actual_gpu, 'driver_records': drivers,
              'pixel_test_properties': properties, 'cpu_image_math_absent': cpu_image_math_absent,
              'production_test_oracles_absent': oracle_absent, 'runtime_info': runtime_records[0],
              'production_binary_sha256': hashlib.sha256(production.read_bytes()).hexdigest(),
              'model_inference_verified': False, 'enhancement_accuracy_verified': False,
              'performance_scope': 'GPU pixel preparation/blending and transfers; excludes inference',
              'model_requirements': {'gpen': [256, 256], 'codeformer': [512, 512],
                  'input': 'float_nchw_rgb_minus1_1_cubic_gray128',
                  'output': 'float_nchw_rgb_minus1_1'}, 'result_directory': str(result)}
    report['passed'] = (run.returncode == 0 and counts['tests'] >= 9 and
        counts['failures'] == counts['errors'] == counts['disabled'] == skipped == 0 and
        actual_gpu and cpu_image_math_absent and oracle_absent)
    (result / 'summary.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({'passed': report['passed'], 'result': str(result / 'summary.json')}))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
