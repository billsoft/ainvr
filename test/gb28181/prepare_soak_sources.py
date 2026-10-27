#!/usr/bin/env python3
"""Build bounded copy-only soak sources and distinctive A/V reference loops.

Video must already be hardware encoded. Only test audio is converted on CPU.
"""
import argparse
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('--videos', choices=['both', 'h264', 'hevc'], default='both')
    parser.add_argument('--reference-cycles', type=int, choices=range(3, 9), default=3)
    parser.add_argument('--normalize-test-cfr', action='store_true', help='Round only test video-only timestamps to the declared frame grid; retain B-frame order')
    parser.add_argument('--closed-test-gop-frames', type=int, help='Cut the video-only test branch immediately before a verified IDR boundary')
    parser.add_argument('--concat-test-seconds', type=int, help='Prepare bounded repeated GOP inputs without seeking into leading B-frame DTS')
    args = parser.parse_args()
    if args.closed_test_gop_frames is not None and (not args.normalize_test_cfr or args.closed_test_gop_frames < 1):
        parser.error('closed-test-gop-frames requires normalize-test-cfr and a positive frame count')
    if args.concat_test_seconds is not None and (not args.closed_test_gop_frames or not 60<=args.concat_test_seconds<=9000):
        parser.error('concat-test-seconds requires a closed GOP and a 60..9000-second bound')
    args.result.mkdir(parents=True, exist_ok=False)
    refs = args.result/'references'
    refs.mkdir()
    def run(command, binary='/usr/bin/ffmpeg'):
        subprocess.run([binary, '-hide_banner', '-loglevel', 'error', *command], check=True, timeout=30)
    profiles = {}
    for video in (['h264', 'hevc'] if args.videos == 'both' else [args.videos]):
        source = str(args.fixtures/(video+'.mp4'))
        profile = json.loads(subprocess.check_output([
            '/usr/bin/ffprobe', '-v', 'error', '-show_entries',
            'stream=codec_type,codec_name,width,height,r_frame_rate,time_base:format=duration,bit_rate',
            '-of', 'json', source,
        ], timeout=15))
        video_streams = [s for s in profile['streams'] if s['codec_type'] == 'video']
        if len(video_streams) != 1 or video_streams[0]['codec_name'] != video:
            raise ValueError('Source video identity does not match its requested codec')
        if not any(s['codec_name'] == 'aac' for s in profile['streams'] if s['codec_type'] == 'audio'):
            raise ValueError('Source must include the distinctive AAC reference audio')
        profiles[video] = profile
        run(['-i', source, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'mpegts', str(args.result/(video+'-aac.ts'))])
        name = 'video.ts' if video == 'h264' else 'hevc.ts'
        timing = []
        if args.normalize_test_cfr:
            stream = video_streams[0]
            ticks = 1/(Fraction(stream['r_frame_rate'])*Fraction(stream['time_base']))
            if ticks.denominator != 1:
                raise ValueError('Test frame interval must be integral in the source time base')
            packets = json.loads(subprocess.check_output([
                '/usr/bin/ffprobe', '-v', 'error', '-select_streams', 'v', '-show_packets',
                '-show_entries', 'packet=pts,dts,pos,size,flags', '-of', 'json', source,
            ], timeout=15))['packets']
            selected = packets
            if args.closed_test_gop_frames is not None:
                boundary = args.closed_test_gop_frames
                if boundary >= len(packets):
                    raise ValueError('The test cut needs a following IDR inside the source')
                with Path(source).open('rb') as compressed:
                    for index in [0, boundary]:
                        packet = packets[index]
                        if 'K' not in packet['flags']:
                            raise ValueError('The test segment is not bounded by keyframes')
                        compressed.seek(int(packet['pos']));data = compressed.read(int(packet['size']));units=[];offset=0
                        while offset+4<=len(data):
                            size=int.from_bytes(data[offset:offset+4],'big');offset+=4
                            if not size or offset+size>len(data):raise ValueError('Invalid MP4 sample boundary')
                            units.append(data[offset:offset+size]);offset+=size
                        if not any((unit[0]&31)==5 if video=='h264' else ((unit[0]>>1)&63) in (19,20) for unit in units):
                            raise ValueError('The test segment requires IDR, not an open-GOP keyframe')
                selected = packets[:boundary]
                grid = sorted(round(int(packet['pts'])/int(ticks)) for packet in selected)
                if grid != list(range(grid[0],grid[0]+len(grid))):
                    raise ValueError('The closed test GOP has missing frame-grid positions')
            for packet in packets:
                for key in ['pts', 'dts']:
                    value = int(packet[key])
                    if abs(value-round(value/int(ticks))*int(ticks)) > float(ticks)/20:
                        raise ValueError('Source is not a millisecond-quantized CFR test recording')
            timing = ['-copytb', '1', *(['-frames:v',str(args.closed_test_gop_frames)] if args.closed_test_gop_frames else []), '-bsf:v', f'setts=pts=round(PTS/{int(ticks)})*{int(ticks)}:dts=round(DTS/{int(ticks)})*{int(ticks)}']
        run(['-i', source, '-map', '0:v:0', '-an', '-c:v', 'copy', *timing, '-f', 'mpegts', str(args.result/name)])
        reference_input = args.result/name
        reference_input_options = []
        reference_limit = []
        if args.concat_test_seconds:
            # FFmpeg stream_loop seeks to a TS's first PTS and can omit leading
            # B-frame DTS on each repeat. Open each complete IDR-bounded segment
            # afresh instead. This source ends beyond the requested test bound.
            period = Fraction(args.closed_test_gop_frames)/Fraction(video_streams[0]['r_frame_rate'])
            count = int(Fraction(args.concat_test_seconds)/period)+1
            reference_input = args.result/('video.ffconcat' if video=='h264' else 'hevc.ffconcat')
            reference_input.write_text('ffconcat version 1.0\n'+(f"file '{name}'\nduration {float(period):.9f}\n"*count))
            reference_input_options = ['-f','concat','-safe','1']
            reference_limit = ['-t',str(float(period*args.reference_cycles))]
        # The G.711 peer loops video-only TS and a separate raw waveform. Its
        # first audio packet is anchored to the first video PTS, not to an AAC
        # MP4's priming/padding or loop duration. Reproduce those source clocks
        # explicitly; otherwise a B-frame source can create a false drift.
        first = json.loads(subprocess.check_output([
            '/usr/bin/ffprobe' if args.concat_test_seconds else str(ROOT/'out/gb28181/ffmpeg-runtime/bin/ffprobe'), '-v', 'error',
            *reference_input_options, '-select_streams', 'v', '-read_intervals', '%+#1', '-show_packets',
            '-show_entries', 'packet=pts_time', '-of', 'json', str(reference_input),
        ], timeout=15))['packets'][0]['pts_time']
        loops = str(args.reference_cycles-1)
        run(['-copyts', '-copytb', '1', *([] if args.concat_test_seconds else ['-stream_loop',loops]), *reference_input_options, '-i', str(reference_input),
             '-itsoffset', first, '-stream_loop', loops, '-i', str(args.fixtures/'distinctive.wav'),
             '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
             '-ar', '8000', '-ac', '1', '-b:a', '64k', *reference_limit, '-shortest', str(refs/(video+'.mp4'))],
            '/usr/bin/ffmpeg' if args.concat_test_seconds else str(ROOT/'out/gb28181/ffmpeg-runtime/bin/ffmpeg'))
        # The live AAC peer loops TS with this exact copy-only executable.
        # TS and MP4 loop duration differ by AAC padding; use its actual input
        # clock as the reference, rather than interpreting a common source
        # clock step as audio drift introduced by the gateway.
        run(['-stream_loop', loops, '-i', str(args.result/(video+'-aac.ts')), '-map', '0', '-c', 'copy', str(refs/(video+'-aac.mp4'))], str(ROOT/'out/gb28181/ffmpeg-runtime/bin/ffmpeg'))
    for audio in ['alaw', 'mulaw']:
        run(['-i', str(args.fixtures/'distinctive.wav'), '-ar', '8000', '-ac', '1', '-f', audio, str(args.result/('tone.'+audio))])
    files = {str(p.relative_to(args.result)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(args.result.rglob('*')) if p.is_file()}
    (args.result/'manifest.json').write_text(json.dumps({'video': 'stream copy', 'audio': 'source-specific distinctive fixture', 'testOnlyVideoCfrNormalization': args.normalize_test_cfr, 'closedTestGopFrames': args.closed_test_gop_frames, 'concatTestSeconds': args.concat_test_seconds, 'videoOnlySourceFfmpeg': '/usr/bin/ffmpeg' if args.concat_test_seconds else str(ROOT/'out/gb28181/ffmpeg-runtime/bin/ffmpeg'), 'referenceCycles': args.reference_cycles, 'g711ReferenceClock': 'video-only TS/concat clock; raw audio anchored to first video PTS', 'profiles': profiles, 'files': files}, indent=2)+'\n')
    print(args.result)


if __name__ == '__main__':
    main()
