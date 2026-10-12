#!/usr/bin/env python3
"""Isolate original recorder reader/writer timestamp behavior on a real stream.

No user channels/configuration are changed. This is compressed copy/remux only;
production GOP scheduling and browser playback are separate acceptance gates.
"""
import collections
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
FFMPEG8 = Path('/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg')
FFPROBE8 = FFMPEG8.with_name('ffprobe')


def packets(path):
    raw = subprocess.check_output([str(FFPROBE8), '-v', 'error', '-select_streams',
        'v:0', '-show_packets', '-show_streams', '-show_entries',
        'packet=dts_time,pts_time:stream=codec_name,width,height,avg_frame_rate',
        '-of', 'json', str(path)], text=True, timeout=20)
    data = json.loads(raw)
    ts = [round(float(p['dts_time'])*1_000_000) for p in data['packets']]
    assert len(ts) > 2
    deltas = [b-a for a, b in zip(ts, ts[1:])]
    return data, ts, deltas, {
        'video': data['streams'][0], 'video_packets': len(ts),
        'media_seconds': (ts[-1]-ts[0])/1_000_000,
        'fps_by_packet_dts': (len(ts)-1)*1_000_000/(ts[-1]-ts[0]),
        'max_dts_gap_ms': max(deltas)/1000,
        'nonpositive_dts_steps': sum(d <= 0 for d in deltas),
        'dts_delta_us_histogram': collections.Counter(deltas).most_common(12),
    }


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr')
    assert Path('/mnt/ainvr-ssd').is_mount()
    sys.path.insert(0, str(ROOT/'recording-service/src'))
    from recorder.ffmpeg_recorder import build_reader_command, build_writer_command
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+str(os.getpid())
    result = ROOT/'test/results'/('recorder-timing-'+stamp)
    result.mkdir(mode=0o700)
    media = Path('/mnt/ainvr-ssd/lab')/('recorder-timing-'+stamp)
    media.mkdir(parents=True, mode=0o700)
    readers = {}
    for name, binary in [('original_reader', '/usr/bin/ffmpeg'),
                         ('ffmpeg8_reader', str(FFMPEG8))]:
        capture = media/(name+'.ts')
        command = build_reader_command('rtmp://127.0.0.1:1935/live/xm', 'h264')
        command[0] = binary
        command[-1] = str(capture)
        command[-3:-3] = ['-n', '-t', '20']
        with (result/(name+'.log')).open('w') as log:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT,
                check=True, timeout=45)
        original, ts, delta, evidence = packets(capture)
        (result/(name+'-packets.json')).write_text(json.dumps(original))
        readers[name] = evidence
    # Writers receive the identical original-reader fixture, including any gap.
    sample = media/'original_reader.ts'
    original, ts, delta, evidence = packets(sample)
    for name, binary in [('system_writer', '/usr/bin/ffmpeg'),
                         ('ffmpeg8_writer', str(FFMPEG8))]:
        output = media/(name+'.mp4')
        command = build_writer_command(str(output), True, 'h264')
        command[0] = binary
        command[command.index('pipe:0')] = str(sample)
        with (result/(name+'.log')).open('w') as log:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT,
                check=True, timeout=30)
        data, actual, steps, summary = packets(output)
        assert len(actual) == len(ts), name+' changed video packet count'
        # RTMP timestamps have millisecond resolution. MP4 may replace the last
        # fragment's sample duration by 1/fps; bound each relative timestamp,
        # rather than treating that sub-millisecond rounding as packet loss.
        error = max(abs((a-actual[0])-(b-ts[0])) for a,b in zip(actual,ts))
        assert error <= 1000, name+' changed relative video DTS beyond one millisecond'
        (result/(name+'-packets.json')).write_text(json.dumps(data))
        readers[name] = dict(summary, packet_count_preserved=True,
            max_relative_dts_error_us=error, relative_dts_preserved_within_one_ms=True)
    report = {'passed': True, 'scope': 'original commands; finite real reader and file remux',
        'measurements': readers, 'media_path': str(media),
        'production_gop_pipeline_verified': False, 'production_configuration_modified': False,
        'captured_at': time.time()}
    (result/'summary.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2)); print('RESULT', result)


if __name__ == '__main__':
    main()
