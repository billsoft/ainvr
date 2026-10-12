#!/usr/bin/env python3
"""AINVR source -> original publisher -> isolated SRS output -> VPU/SEI readback."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr')
    assert Path('/mnt/ainvr-ssd').is_mount()
    assert os.geteuid() == 0, 'Build as root; execute hardware as the production service account'
    result = ROOT/'test/results'/('stream-source-sei-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+str(os.getpid()))
    result.mkdir()
    build = Path(os.environ.get('AINVR_TEST_BUILD_DIR', ROOT/'out/build/ai-api-compat')).resolve()
    assert build.is_relative_to(ROOT/'out/build'), 'Build directory must stay in the AINVR build tree'
    user = subprocess.check_output(['systemctl', 'show', 'ainvr-ai', '--property=User', '--value'], text=True).strip()
    account = pwd.getpwnam(user)
    os.chown(result, account.pw_uid, account.pw_gid)
    with (result/'build.log').open('w') as log:
        subprocess.run(['cmake', '-S', str(ROOT/'ai-service'), '-B', str(build),
                        '-DAINVR_S100P=ON', '-DBUILD_TESTING=ON'], stdout=log,
                       stderr=subprocess.STDOUT, check=True, timeout=60)
        subprocess.run(['cmake', '--build', str(build), '--target', 'ainvr_stream_source_sei_probe', '-j2'],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=240)
    with (result/'transport.log').open('w') as log:
        subprocess.run(['runuser', '-u', user, '--', 'env', 'LD_LIBRARY_PATH=/usr/hobot/lib',
                        'GSETTINGS_BACKEND=memory', str(build/'ainvr_stream_source_sei_probe'),
                        'rtmp://127.0.0.1:1935/live/xm', str(result/'transport.json')],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=75)
    with (result/'browser-parser.log').open('w') as log:
        subprocess.run(['/opt/ainvr/node-v24.20.0-linux-arm64/bin/node', '--experimental-strip-types',
                        str(ROOT/'test/ai_port/verify_browser_sei.mts'), str(result/'transport.json'),
                        str(result/'browser-parser.json')], stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=30)
    transport = json.loads((result/'transport.json').read_text())
    browser = json.loads((result/'browser-parser.json').read_text())
    assert transport['passed'] and browser['passed']
    assert transport['source_hardware_decoded_frames'] >= 12
    assert transport['output_evidence']['verified_sei_frames'] >= 12
    assert transport['output_evidence']['vpu_decoded_frames'] >= 3
    assert transport['steady_state_metadata_strict'] and transport['steady_frames_stamped'] >= 12
    assert transport['vcl_payloads_match_after_annexb_padding_normalization']
    assert not transport['video_reencoded'] and not transport['inference_executed']
    summary = {'passed': True, 'execution_user': user, 'source_adapter': transport['source_adapter'],
               'source_size': transport['source_size'],
               'input_vpu_decoded_frames': transport['source_hardware_decoded_frames'],
               'output_verified_sei_frames': transport['output_evidence']['verified_sei_frames'],
               'output_vpu_decoded_frames': transport['output_evidence']['vpu_decoded_frames'],
               'startup_metadata_misses': transport['startup_metadata_misses'],
               'startup_warmup_seconds': transport['startup_warmup_seconds'],
               'steady_frames_stamped': transport['steady_frames_stamped'],
               'steady_state_metadata_strict': transport['steady_state_metadata_strict'],
               'final_adaptive_delay_seconds': transport['final_adaptive_delay_seconds'],
               'original_publisher_used': True, 'compressed_vcl_unchanged': True,
               'decoded_display_pts_used_for_sei': True, 'production_browser_parser_passed': True,
               'actual_browser_playback_verified': False, 'inference_executed': False,
               'production_worker_integrated': False, 'user_configuration_modified': False,
               'source_sha256': hashlib.sha256((ROOT/'ai-service/src/stream/source.cpp').read_bytes()).hexdigest(),
               'decoder_sha256': hashlib.sha256((ROOT/'ai-service/src/platform/vpu_decoder.cpp').read_bytes()).hexdigest()}
    (result/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    print(json.dumps(summary, indent=2)); print('RESULT', result)


if __name__ == '__main__':
    main()
