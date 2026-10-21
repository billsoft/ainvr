#!/usr/bin/env python3
"""Freeze AINVR native sources, build an isolated candidate and run offline gates.

No model compilation/inference, production configuration changes or service stops.
The output directory must be new and below the mounted AINVR SSD.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
SOURCE_TREES = ['ai-service/src', 'ai-service/cmake', 'ai-service/third_party',
                'ai-service/tests', 'test/ai_port', 'test/bytetrack']
SOURCE_EXTENSIONS = {'.cpp', '.hpp', '.h', '.c', '.cc', '.inc', '.in', '.py', '.cmake'}
TARGETS = ['ainvr_s100p_control_service', 'config_test', 'channel_options_test',
           'detection_decode_test', 'postprocess_test', 'sei_test', 'result_test',
           'result_buffer_test', 'bpu_timeout_control_test', 'archive_document_test',
           'archive_spool_test', 'archive_admission_test', 'picture_tokens_test',
           'raw_frame_spool_test', 'archive_result_codec_test', 'ffmpeg_runtime_test']
TEST_PATTERN = ('^(config|channel_options|detection_decode|postprocess|sei|result|'
                'result_buffer|bpu_custody_.*|archive_document|archive_spool|'
                'archive_admission|picture_tokens|raw_frame_spool|archive_result_codec|'
                'ffmpeg_runtime)$')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=2, choices=[1, 2])
    args = parser.parse_args()
    output = args.output
    ssd = Path('/mnt/ainvr-ssd')
    if not ssd.is_mount() or not output.is_absolute() or output.resolve() != output:
        raise SystemExit('Use a new canonical SSD output path')
    if not output.is_relative_to(ssd) or output == ssd:
        raise SystemExit('Output must be inside the AINVR SSD')
    output.mkdir(mode=0o700)  # Never reuse/reset an existing build.
    snapshot = output / 'source'
    state = {'schema_version': '1.0', 'pid': os.getpid(), 'started_at': time.time(),
             'process_start_ticks': Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19],
             'phase': 'freezing', 'output': str(output)}

    def status(phase, **fields):
        state.update(phase=phase, updated_at=time.time(), **fields)
        temp = output / 'status.json.new'
        temp.write_text(json.dumps(state, indent=2) + '\n')
        temp.replace(output / 'status.json')

    def run(phase, command):
        status(phase, command=command)
        print(phase, flush=True)
        subprocess.run(command, check=True, cwd=ROOT)

    try:
        os.nice(10)
        subprocess.run(['ionice', '-c', '2', '-n', '7', '-p', str(os.getpid())], check=True)
        selected = {ROOT / 'ai-service/CMakeLists.txt', ROOT / 'ai-service/config/config.example.yaml',
                    ROOT / 'test/model_conversion/calibration_capture.cpp'}
        for tree in SOURCE_TREES:
            for file in (ROOT / tree).rglob('*'):
                if file.is_file() and not file.is_symlink() and (
                    file.name == 'CMakeLists.txt' or file.suffix in SOURCE_EXTENSIONS or
                    str(file.relative_to(ROOT)).startswith('ai-service/tests/') and file.suffix == '.json'
                ):
                    selected.add(file)
        manifest = {}
        for file in sorted(selected):
            rel = file.relative_to(ROOT)
            before = digest(file)
            target = snapshot / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
            if digest(file) != before or digest(target) != before:
                raise RuntimeError('Source changed during freeze: ' + str(rel))
            manifest[str(rel)] = before
        # Recheck the whole snapshot as a single source generation.
        if any(digest(ROOT / rel) != sha for rel, sha in manifest.items()):
            raise RuntimeError('Source generation changed during snapshot')
        (output / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        build = output / 'build'
        run('configuring-native', ['cmake', '-S', str(snapshot / 'ai-service'), '-B', str(build),
            '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_TESTING=ON', '-DAINVR_S100P=ON',
            '-DAINVR_BUILD_CPU_REFERENCE=OFF', '-DAINVR_LICENSE_SERVICE_USER=sunrise',
            '-DAINVR_FFMPEG_ROOT=/opt/ainvr/ffmpeg-8.1.2'])
        run('building-native', ['cmake', '--build', str(build), '-j', str(args.jobs), '--target', *TARGETS])
        run('offline-native-tests', ['ctest', '--test-dir', str(build), '--output-on-failure', '-j', '1', '-R', TEST_PATTERN])
        tracking = output / 'tracking-build'
        run('configuring-tracking', ['cmake', '-S', str(snapshot / 'test/bytetrack'), '-B', str(tracking), '-DCMAKE_BUILD_TYPE=Release'])
        run('building-tracking', ['cmake', '--build', str(tracking), '-j', str(args.jobs)])
        run('offline-tracking-tests', ['ctest', '--test-dir', str(tracking), '--output-on-failure', '-j', '1'])
        binary = build / 'ainvr_s100p_control_service'
        dependencies = subprocess.check_output(['ldd', str(binary)], text=True)
        if 'not found' in dependencies or any(name in dependencies for name in ['libonnxruntime', 'libnvinfer', 'libcuda']):
            raise RuntimeError('Candidate has missing or unsupported inference dependencies')
        runtime = subprocess.check_output([str(binary), '--runtime-info'], text=True)
        (output / 'runtime-info.txt').write_text(runtime)
        changed = [rel for rel, sha in manifest.items() if not (ROOT / rel).is_file() or digest(ROOT / rel) != sha]
        status('passed', binary_sha256=digest(binary), binary=str(binary),
               frozen_sources=len(manifest), current_source_changes=changed,
               deployment_performed=False, hardware_video_acceptance=False)
        print(json.dumps({'phase': 'passed', 'binary': str(binary), 'source_changes': changed}), flush=True)
    except Exception as error:
        status('failed', error=str(error)[:2000], deployment_performed=False)
        raise


if __name__ == '__main__':
    main()
