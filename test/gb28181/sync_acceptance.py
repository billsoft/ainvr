#!/usr/bin/env python3
"""Measure GB A/V timing using video identity and distinctive audio content.

References reuse hardware-encoded test video. No video decoder/encoder runs;
only the explicitly test-only audio oracle uses CPU decoding/correlation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('--gateway', type=Path, required=True)
    parser.add_argument('--remuxer', type=Path, default=Path(os.environ.get('AINVR_GB_TEST_REMUXER', str(ROOT/'out/gb28181/ps_fixture'))))
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    args.result = args.result.resolve()
    args.result.mkdir(parents=True, exist_ok=False)
    report = {'passed': False, 'gatewaySHA256': hashlib.sha256(args.gateway.read_bytes()).hexdigest(), 'remuxerSHA256': hashlib.sha256(args.remuxer.read_bytes()).hexdigest(), 'productionChanged': False, 'cases': []}
    references = {}
    try:
        for video in ['h264', 'hevc']:
            sample = args.fixtures/(video+'.mp4')
            assert sample.is_file()
            references[video] = sample.resolve()
            for audio in ['aac', 'alaw', 'mulaw']:
                run_tag = hashlib.sha256(str(args.result).encode()).hexdigest()[:12]
                name = f'gbav-{video}-{audio}-{run_tag}'
                ts = args.result/(name+'.ts')
                subprocess.run(['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(sample), '-map', '0:v:0', *(['-map', '0:a:0'] if audio == 'aac' else ['-an']), '-c', 'copy', '-f', 'mpegts', str(ts)], check=True, timeout=15)
                command = [str(args.remuxer.resolve())]
                if audio != 'aac':
                    raw = args.result/(name+'.'+audio)
                    subprocess.run(['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(args.fixtures/'distinctive.wav'), '-ar', '8000', '-ac', '1', '-f', audio, str(raw)], check=True, timeout=15)
                    command += [str(raw), '144' if audio == 'alaw' else '145']
                records = ROOT/'out/gb28181'/(name+'.psrecords')
                with ts.open('rb') as source, records.open('xb') as output:
                    subprocess.run(command, stdin=source, stdout=output, check=True, timeout=15)
                report['cases'].append({'video': video, 'audio': audio, 'fixture': name, 'sourceSHA256': hashlib.sha256(sample.read_bytes()).hexdigest(), 'recordsSHA256': hashlib.sha256(records.read_bytes()).hexdigest()})
        (args.result/'fixtures.json').write_text(json.dumps(report, indent=2)+'\n')
        if args.prepare_only:
            report['preparedOnly'] = True
            return
        sys.path.insert(0, str(ROOT/'test/onvif'))
        from av_content import compare, packets
        env = {**os.environ, 'AINVR_GB_TEST_GATEWAY': str(args.gateway.resolve()), 'AINVR_GB_TEST_RESULTS': str(args.result/'pipeline'), 'AINVR_GB_TEST_PORT_OFFSET': '5000'}
        for case in report['cases']:
            command = [sys.executable, str(ROOT/'test/gb28181/pipeline_probe.py'), '--version', '3.0', '--signaling', 'tcp', '--media', 'tcp-passive', '--fixture', case['fixture'], '--video', case['video'], '--record-seconds', '8', '--recorder']
            with (args.result/(case['fixture']+'.log')).open('wb') as output:
                subprocess.run(command, env=env, stdout=output, stderr=output, check=True, timeout=80)
            target = args.result/'pipeline/pipeline-probe'/('3.0-tcp-tcp-passive-'+case['fixture'])/'recorder/recording.mp4'
            timing = compare(references[case['video']], target)
            case['timing'] = timing
            assert timing['maximum_content_offset_seconds'] <= .2, 'A/V content offset exceeded 200ms'
            assert timing['content_drift_seconds'] <= .05, 'A/V clock drift exceeded 50ms in bounded sample'
            def cadence(path):
                frames = packets(path)
                stamps = [float(frame['pts_time']) for frame in frames]
                assert len(stamps) >= 10 and max(stamps) > min(stamps), 'Insufficient video timing samples'
                return {'frames': len(stamps), 'observedFPS': (len(stamps)-1)/(max(stamps)-min(stamps))}
            reference_cadence = cadence(references[case['video']])
            case['videoCadence'] = cadence(target)
            case['referenceCadence'] = reference_cadence
            assert .95 <= case['videoCadence']['observedFPS']/reference_cadence['observedFPS'] <= 1.05, 'Video cadence changed through the bridge'
            case['passed'] = True
            (args.result/'progress.json').write_text(json.dumps(report, indent=2)+'\n')
        shifted = args.result/'positive-control-500ms.mp4'
        subprocess.run(['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(references['h264']), '-itsoffset', '0.5', '-i', str(references['h264']), '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', str(shifted)], check=True, timeout=20)
        control = compare(references['h264'], shifted)
        assert .45 <= control['maximum_content_offset_seconds'] <= .55, 'Timing oracle failed its positive control'
        report['positiveControl'] = control
        report['passed'] = True
    except Exception as error:
        report['error'] = type(error).__name__+': '+str(error)[:500]
        raise
    finally:
        (args.result/'report.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
