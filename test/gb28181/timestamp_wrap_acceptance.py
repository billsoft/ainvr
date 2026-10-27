#!/usr/bin/env python3
"""Bounded RTP32/PS33 wrap tests through the actual GB media/recorder chain.

Uses an independent socket camera and existing compressed fixtures. Shifts
only wire timestamps, not pacing; never changes production services or video
encoding. This accelerates clock wrap, not the separate 24-hour endurance gate.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

from virtual_camera import Camera, load_records

ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gateway', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path, required=True,
                        help='fixtures.json from a completed sync acceptance')
    parser.add_argument('--references', type=Path, required=True)
    parser.add_argument('--result', type=Path, required=True)
    args = parser.parse_args()
    args.result = args.result.resolve()
    args.result.mkdir(parents=True, exist_ok=False)
    fixtures = json.loads(args.fixtures.read_text())['cases']
    report = {'passed': False, 'productionChanged': False,
              'gatewaySHA256': sha(args.gateway), 'cases': [],
              'scope': 'Loopback independent SIP camera -> ZLM -> fixed bridge -> isolated SRS -> production recorder commands; accelerated RTP32/PS33 clock boundaries, not elapsed endurance'}
    try:
        for version in ['2016', '2022']:
            for video in ['h264', 'hevc']:
                source = next(c for c in fixtures if c['video'] == video and c['audio'] == 'aac')
                records_path = ROOT/'out/gb28181'/(source['fixture']+'.psrecords')
                assert sha(records_path) == source['recordsSHA256']
                reference = args.references/(video+'.mp4')
                assert sha(reference) == source['sourceSHA256']
                records = load_records(records_path)
                for bits in [32, 33]:
                    case_dir = args.result/f'{version}-{video}-wrap{bits}'
                    signaling = 'tcp' if version == '2016' else 'udp'
                    command = [sys.executable, str(ROOT/'test/gb28181/lan_receiver.py'),
                               '--board-ip', '127.0.0.1', '--version', '2.0' if version == '2016' else '3.0',
                               '--signaling', signaling, '--media', 'tcp-passive',
                               '--video', video, '--fixture', source['fixture'],
                               '--gateway', str(args.gateway.resolve()), '--result', str(case_dir),
                               '--reference', str(reference.resolve()), '--record-seconds', '8',
                               '--hold-after-record-seconds', '1', '--recorder']
                    case = {'version': version, 'video': video, 'bits': bits, 'passed': False,
                            'sourceRecordsSHA256': sha(records_path)}
                    report['cases'].append(case)
                    camera = None
                    with (args.result/f'{version}-{video}-wrap{bits}.log').open('xb') as log:
                        receiver = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL,
                                                    stdout=log, stderr=log)
                    began = time.monotonic()
                    try:
                        log_path = args.result/f'{version}-{video}-wrap{bits}.log'
                        while b'READY_FOR_WINDOWS_CAMERA' not in log_path.read_bytes():
                            assert receiver.poll() is None, 'receiver failed before ready'
                            assert time.monotonic()-began < 30, 'receiver setup deadline'
                            time.sleep(.1)
                        offset = (1 << bits)-min(p for p, _ in records)-8*90000
                        camera = Camera(15060, records, '2.0' if version == '2016' else '3.0',
                                        signaling, 'tcp-passive', timestamp_offset_ticks=offset)
                        camera.start()
                        assert camera.registered.wait(15), 'camera registration failed'
                        recording_created = None
                        recording = case_dir/'recording.mp4'
                        while receiver.poll() is None:
                            # The receiver closes SIP/RTP during its own normal
                            # cleanup, after writing the verified media report.
                            # Do not interrupt that cleanup because the peer
                            # correctly observed the connection closing.
                            completed = case_dir/'report.json'
                            media_verified = completed.exists() and json.loads(completed.read_text()).get('passed')
                            assert media_verified or (not camera.error and not camera.media_error), 'camera failed: '+str(camera.error or camera.media_error)
                            assert time.monotonic()-began < 110, 'bounded wrap test deadline'
                            if recording_created is None and recording.exists():
                                recording_created = time.monotonic()
                            time.sleep(.1)
                        assert receiver.returncode == 0, 'receiver/media/recorder failed'
                        assert camera.rtp_timestamp_wraps >= 1, 'RTP wrap never sent'
                        if bits == 33:
                            assert camera.ps_timestamp_wraps >= 1, 'PS wrap never sent'
                        events = camera.timestamp_wrap_events
                        assert recording_created is not None, 'recording creation was not observed'
                        counter = 'ps' if bits == 33 else 'rtp'
                        assert any(recording_created < event['monotonic'] < time.monotonic()-1
                                   for event in events if event[counter]), 'wrap not observed while recorder was active'
                        actual = json.loads((case_dir/'report.json').read_text())
                        assert actual['passed'] and actual['gatewaySHA256'] == report['gatewaySHA256']
                        probe = subprocess.run([str(ROOT/'out/gb28181/ffmpeg-runtime/bin/ffprobe'),
                                                '-v', 'error', '-select_streams', 'v:0',
                                                '-show_packets', '-show_entries', 'packet=pts_time,dts_time',
                                                '-of', 'json', str(recording)], check=True,
                                               capture_output=True, timeout=10)
                        packets = json.loads(probe.stdout)['packets']
                        dts = [float(p['dts_time']) for p in packets]
                        pts = [float(p['pts_time']) for p in packets]
                        assert len(dts) >= 175 and 7 <= max(pts)-min(pts) <= 9, 'recording is truncated or has a clock jump'
                        assert all(0 < b-a <= .2 for a, b in zip(dts, dts[1:])), 'DTS discontinuity at wire wrap'
                        case.update(passed=True, timestampOffsetTicks=offset,
                                    rtpTimestampWraps=camera.rtp_timestamp_wraps,
                                    psTimestampWraps=camera.ps_timestamp_wraps,
                                    wrapEvents=events, recordingCreatedMonotonic=recording_created,
                                    recordingSHA256=sha(recording), frames=len(dts),
                                    contentTiming=actual['contentTiming'], receiverReport=str(case_dir/'report.json'))
                    finally:
                        if camera:
                            case.update(senderError=camera.error, senderMediaError=camera.media_error,
                                        rtpTimestampWraps=camera.rtp_timestamp_wraps,
                                        psTimestampWraps=camera.ps_timestamp_wraps,
                                        wrapEvents=list(camera.timestamp_wrap_events))
                            if case['passed'] and (camera.error or camera.media_error):
                                case['senderShutdownScope'] = 'Peer connection closed during receiver cleanup after its verified recording; not a media failure'
                            camera.close()
                        if receiver.poll() is None:
                            receiver.terminate()
                            try:
                                receiver.wait(timeout=45)
                            except subprocess.TimeoutExpired:
                                receiver.kill()
                                receiver.wait(timeout=5)
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
