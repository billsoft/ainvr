#!/usr/bin/env python3
"""Verify unsupported source audio does not stop GB video ingestion.

Uses VPU-encoded input pictures and test-only Opus audio encoding. The actual
gateway, media receiver, bridge, isolated SRS and copy recording are exercised.
Shares the pipeline probe's ports/container: run serially with that matrix.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gateway', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--remuxer', type=Path, required=True)
    parser.add_argument('--result', type=Path, required=True)
    args = parser.parse_args()
    args.result = args.result.resolve()
    args.result.mkdir(parents=True, exist_ok=False)
    report = {'passed': False, 'productionChanged': False,
              'gatewaySHA256': sha(args.gateway),
              'remuxerSHA256': sha(args.remuxer), 'cases': []}
    tag = hashlib.sha256(str(args.result).encode()).hexdigest()[:12]
    try:
        for video in ['h264', 'hevc']:
            name = f'fallback-{video}-opus-{tag}'
            ts = args.result/(name+'.ts')
            command = ['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error',
                       '-i', str(args.fixtures/(video+'.mp4')),
                       '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy',
                       '-c:a', 'libopus', '-ar', '48000', '-ac', '2',
                       '-b:a', '48k', '-t', '20', '-f', 'mpegts', str(ts)]
            subprocess.run(command, check=True, timeout=30)
            source = json.loads(subprocess.check_output(
                ['/usr/bin/ffprobe', '-v', 'error', '-show_entries',
                 'stream=codec_name', '-of', 'json', str(ts)], timeout=10))
            assert {video, 'opus'} == {s['codec_name'] for s in source['streams']}
            records = ROOT/'out/gb28181'/(name+'.psrecords')
            with ts.open('rb') as source, records.open('xb') as output:
                subprocess.run([str(args.remuxer.resolve())], stdin=source,
                               stdout=output, check=True, timeout=15)
            for version in ['2.0', '3.0']:
                env = {**os.environ,
                       'AINVR_GB_TEST_GATEWAY': str(args.gateway.resolve()),
                       'AINVR_GB_TEST_RESULTS': str(args.result/'pipeline'),
                       'AINVR_GB_TEST_PORT_OFFSET': '5000'}
                # --silent here means the expected output has video only.
                # The independent source above deliberately HAS Opus audio.
                probe = [sys.executable, str(ROOT/'test/gb28181/pipeline_probe.py'),
                         '--version', version, '--signaling', 'tcp', '--media',
                         'tcp-passive', '--fixture', name, '--video', video,
                         '--silent', '--record-seconds', '4']
                with (args.result/(version+'-'+video+'.log')).open('xb') as log:
                    subprocess.run(probe, cwd=ROOT, env=env, stdout=log,
                                   stderr=log, check=True, timeout=90)
                folder = args.result/'pipeline/pipeline-probe'/(
                    version+'-tcp-tcp-passive-'+name)
                timeline = json.loads((folder/'timeline.json').read_text())
                assert any(['streaming', 'unsupported_audio_codec'] in row['state']
                           for row in timeline), 'Missing explicit audio fallback reason'
                report['cases'].append({'version': version, 'video': video,
                                        'sourceAudio': 'opus', 'outputAudio': None,
                                        'warning': 'unsupported_audio_codec',
                                        'sourceSHA256': sha(ts),
                                        'recordsSHA256': sha(records), 'passed': True})
                assert sha(args.gateway) == report['gatewaySHA256']
                (args.result/'progress.json').write_text(json.dumps(report, indent=2)+'\n')
        report['passed'] = True
    except Exception as error:
        report['error'] = type(error).__name__+': '+str(error)[:500]
        raise
    finally:
        (args.result/'report.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
