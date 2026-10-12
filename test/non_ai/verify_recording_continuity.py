#!/usr/bin/env python3
"""Verify finite, closed production recordings; never inspect an open fragment."""
import argparse
import datetime
import json
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--channel', required=True)
    parser.add_argument('--after', required=True, help='YYYYmmdd_HHMMSS')
    parser.add_argument('--segments', type=int, default=2)
    parser.add_argument('--start-file', help='Exact first recording basename after reconnect')
    args = parser.parse_args()
    assert re.fullmatch(r'[a-zA-Z0-9-]+', args.channel)
    datetime.datetime.strptime(args.after, '%Y%m%d_%H%M%S')
    assert 1 <= args.segments <= 3
    if args.start_file:
        assert re.fullmatch(re.escape(args.channel)+
                            r'_\d{8}_\d{6}\.\d{3}\.mp4', args.start_file)
    assert ROOT.resolve() == Path('/home/sunrise/ainvr')
    disk = Path('/mnt/ainvr-ssd')
    assert disk.is_mount()
    directory = disk/'recordings'/args.after.split('_')[0]
    deadline = time.monotonic()+args.segments*90+30
    measures = []
    checked = set()
    while time.monotonic() < deadline and len(measures) < args.segments:
        opened = set()
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit():
                continue
            try:
                for fd in (proc/'fd').iterdir():
                    try:
                        opened.add(str(fd.resolve(strict=True)))
                    except (OSError, RuntimeError):
                        pass
            except OSError:
                pass
        for path in sorted(directory.glob(args.channel+'_*.mp4')):
            recording_time = path.name[len(args.channel)+1:][:15]
            if recording_time < args.after or path in checked or str(path) in opened:
                continue
            if args.start_file and path.name < args.start_file:
                continue
            raw = subprocess.check_output([
                '/opt/ainvr/ffmpeg-8.1.2/bin/ffprobe', '-v', 'error',
                '-select_streams', 'v:0', '-show_streams', '-show_packets',
                '-show_entries', 'packet=dts_time:stream=codec_name,width,height',
                '-of', 'json', str(path)], text=True, timeout=20)
            data = json.loads(raw)
            ts = [float(p['dts_time']) for p in data['packets']]
            assert len(ts) > 100, str(path)+' too few packets'
            duration = ts[-1]-ts[0]
            steps = [b-a for a,b in zip(ts,ts[1:])]
            fps = (len(ts)-1)/duration
            video = data['streams'][0]
            passed = (duration >= 50 and 29.95 <= fps <= 30.05 and
                min(steps) > 0 and max(steps) <= 0.035 and
                video['codec_name']=='h264' and
                (video['width'],video['height'])==(3840,1920))
            measures.append(dict(path=str(path),video=video,packets=len(ts),
                duration=duration,fps_by_dts=fps,max_dts_gap_ms=max(steps)*1000,
                nonpositive_dts_steps=sum(d<=0 for d in steps),
                closed_file_verified=True,passed=passed))
            checked.add(path)
            if len(measures) >= args.segments:
                break
        if len(measures) < args.segments:
            time.sleep(3)
    passed = len(measures)==args.segments and all(m['passed'] for m in measures)
    report = dict(passed=passed,measurements=measures,
        scope='actual closed H264 3840x1920 30fps recording segments',
        configuration_modified=False,after=args.after,start_file=args.start_file)
    filename = 'recording-continuity-'+datetime.datetime.now().strftime(
        '%Y%m%d-%H%M%S')+'.json'
    path = ROOT/'test/results'/filename
    path.write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2)); print('RESULT',path)
    assert passed, 'production recording continuity not verified'


if __name__ == '__main__':
    main()
