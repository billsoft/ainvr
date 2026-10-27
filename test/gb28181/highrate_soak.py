#!/usr/bin/env python3
"""Exercise the shared soak runner with one explicit high-rate video codec.

Only the simulated camera's source selection changes. The real gateway,
receiver, bridge, SRS and audio-content checks are the shared soak pipeline.
Existing mixed-codec jobs and their source files are left untouched.
"""
import argparse
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import soak


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video', choices=['h264', 'hevc'], required=True)
    parser.add_argument('--channels', type=int, choices=[2, 4], required=True)
    parser.add_argument('--seconds', type=int, required=True)
    parser.add_argument('--reference-dir', type=Path, required=True)
    parser.add_argument('--av-check-interval', type=int, default=900)
    parser.add_argument('--min-width', type=int, default=1920)
    parser.add_argument('--min-height', type=int, default=1080)
    parser.add_argument('--min-fps', type=int, default=25)
    parser.add_argument('--min-bitrate', type=int, default=10000000)
    parser.add_argument('--profile-report', type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get('AINVR_GB_TEST_VIDEO_CONCAT') == '1':
        prepared = json.loads((soak.SOURCE_DIR/'manifest.json').read_text())
        if (prepared.get('concatTestSeconds') or 0) < args.seconds+120:
            raise ValueError('Prepared concat source must cover this bounded run plus cleanup')
    source = soak.SOURCE_DIR/(args.video+'-aac.ts')
    profile = json.loads(subprocess.check_output([
        str(soak.BIN/'ffprobe'), '-v', 'error', '-show_entries',
        'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,bit_rate',
        '-of', 'json', str(source),
    ], timeout=15))
    video = next(s for s in profile['streams'] if s['codec_type'] == 'video')
    if (video['codec_name'] != args.video or video['width'] < args.min_width
            or video['height'] < args.min_height
            or Fraction(video['r_frame_rate']) < args.min_fps
            or float(profile['format']['bit_rate']) < args.min_bitrate):
        raise ValueError('Prepared source does not meet the requested high-rate profile')
    report = {
        'phase': 'running', 'startedAt': time.time(), 'video': args.video,
        'channels': args.channels, 'requestedSeconds': args.seconds,
        'profile': profile, 'sourceSHA256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'gatewaySHA256': hashlib.sha256(soak.GATEWAY.read_bytes()).hexdigest(),
        'sharedRunnerSHA256': hashlib.sha256(Path(soak.__file__).read_bytes()).hexdigest(),
        'sourceFfmpegSHA256': hashlib.sha256(Path(os.environ.get('AINVR_GB_TEST_SOURCE_FFMPEG',str(soak.BIN/'ffmpeg'))).read_bytes()).hexdigest(),
        'productionChanged': False, 'realCameraVerified': False,
    }
    # Exclusive creation protects both a prior failure and an active report.
    with args.profile_report.open('x') as output:
        json.dump(report, output, indent=2)
    original = soak.ContinuousDevice

    def selected_source(index, version, signaling, _video, audio, log):
        return original(index, version, signaling, args.video, audio, log)

    soak.ContinuousDevice = selected_source
    sys.argv = [sys.argv[0], '--channels', str(args.channels), '--seconds', str(args.seconds),
                '--reference-dir', str(args.reference_dir), '--av-check-interval', str(args.av_check_interval)]
    try:
        soak.main()
        report['phase'] = 'complete'
    except BaseException as error:
        report.update(phase='failed', error=type(error).__name__)
        raise
    finally:
        args.profile_report.write_text(json.dumps(report, indent=2)+'\n')


if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise InterruptedError('bounded high-rate soak interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    main()
