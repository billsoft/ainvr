#!/usr/bin/env python3
"""Cut real TS at original TsParser keyframes; compare MP4 writer DTS variants."""
import argparse
import datetime
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
BIN = Path('/opt/ainvr/ffmpeg-8.1.2/bin')


def probe(path, stream='v:0'):
    data = json.loads(subprocess.check_output([str(BIN/'ffprobe'), '-v', 'error',
        '-select_streams', stream, '-show_packets', '-show_entries',
        'packet=dts_time,pts_time,flags', '-of', 'json', str(path)],
        text=True, timeout=20))
    packets = data['packets']
    ts = [float(p['dts_time']) for p in packets]
    return ts, dict(packets=len(ts), first_packets=packets[:3],
        max_dts_step_ms=max(b-a for a,b in zip(ts,ts[1:]))*1000)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    args = parser.parse_args()
    assert ROOT.resolve() == Path('/home/sunrise/ainvr')
    source = Path(args.input).resolve(strict=True)
    assert source.is_relative_to(Path('/mnt/ainvr-ssd/lab'))
    assert source.stat().st_size < 256*1024*1024
    sys.path.insert(0, str(ROOT/'recording-service/src'))
    from recorder.ts_gate import TsParser
    from recorder.ffmpeg_recorder import build_writer_command
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    result = ROOT/'test/results'/('gop-mux-'+stamp)
    result.mkdir(mode=0o700)
    media = Path('/mnt/ainvr-ssd/lab')/('gop-mux-'+stamp)
    media.mkdir(mode=0o700)
    ts_parser = TsParser()
    aligned, keys = bytearray(), []
    with source.open('rb') as f:
        while data := f.read(64*1024):
            block, starts = ts_parser.feed(data)
            keys += [len(aligned)+s.offset for s in starts if s.key]
            aligned.extend(block)
    block, starts = ts_parser.flush()
    keys += [len(aligned)+s.offset for s in starts if s.key]
    aligned.extend(block)
    assert len(keys) >= 3 and ts_parser.lost_bytes == 0
    measurements = []
    for index, (begin, end) in enumerate(zip(keys,keys[1:])):
        if index >= 4:
            break
        fixture = media/('gop-'+str(index)+'.ts')
        fixture.write_bytes(ts_parser.psi_header+aligned[begin:end])
        expected, input_measure = probe(fixture)
        expected_audio, _ = probe(fixture, 'a:0')
        for name, binary, options in [
            ('system', '/usr/bin/ffmpeg', []),
            ('ffmpeg8', str(BIN/'ffmpeg'), []),
            ('system_nonnegative', '/usr/bin/ffmpeg',
             ['-avoid_negative_ts', 'make_non_negative']),
            ('system_delay_moov', '/usr/bin/ffmpeg',
             ['-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov'])]:
            output = media/(str(index)+'-'+name+'.mp4')
            command = build_writer_command(str(output), True, 'h264')
            command[0] = binary
            command[command.index('pipe:0')] = str(fixture)
            command[-1:-1] = options
            run = subprocess.run(command, capture_output=True, text=True,timeout=20)
            (result/(str(index)+'-'+name+'.log')).write_text(run.stderr)
            assert run.returncode == 0, name+' writer failed'
            actual, measurement = probe(output)
            actual_audio, _ = probe(output, 'a:0')
            assert len(actual) == len(expected), name+' packet count changed'
            assert len(actual_audio) == len(expected_audio), name+' audio count changed'
            error = max(abs((a-actual[0])-(b-expected[0]))
                        for a,b in zip(actual,expected))*1000
            audio_error = max(abs((a-actual_audio[0])-(b-expected_audio[0]))
                              for a,b in zip(actual_audio,expected_audio))*1000
            av_error = abs((actual_audio[0]-actual[0])-
                           (expected_audio[0]-expected[0]))*1000
            measurements.append(dict(gop=index,variant=name,
                input=input_measure,output=measurement,
                max_relative_dts_error_ms=error,
                audio_relative_dts_error_ms=audio_error,
                audio_video_offset_error_ms=av_error,
                audio_packets_preserved=len(actual_audio),
                relative_dts_preserved=error<=1.0,
                audio_video_timing_preserved=audio_error<=1 and av_error<=1))
    verified = all(row['relative_dts_preserved'] and
                   row['audio_video_timing_preserved']
                   for row in measurements if row['variant']=='system')
    report = dict(scope='offline real GOP fixtures; original parser and writer',
                  measurements=measurements,media=str(media),
                  production_writer_timing_verified=verified,
                  production_configuration_modified=False)
    (result/'summary.json').write_text(json.dumps(report,indent=2))
    for row in measurements:
        print(row['gop'],row['variant'],row['output']['max_dts_step_ms'],
              row['max_relative_dts_error_ms'])
    print('RESULT',result)
    assert verified, 'production writer changed GOP audio/video timestamps'


if __name__ == '__main__':
    main()
