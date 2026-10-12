#!/usr/bin/env python3
"""AINVR: bounded real-camera capture and optional native inference smoke test.

Run from the board: python3 test/ai_port/verify_live_xm.py --infer
Reads test/inputs/xm.json; writes a fresh test/results/live-xm-* directory.
Does not register a console channel or start a permanent AI worker.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
FF = Path('/opt/ainvr/ffmpeg-8.1.2/bin')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--infer', action='store_true')
    args = parser.parse_args()
    config = json.loads((ROOT / 'test/inputs/xm.json').read_text())
    out = ROOT / 'test/results' / ('live-xm-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    out.mkdir(parents=True)
    summary = {'source_url': config['source_url'], 'passed': False,
               'scope': 'Bounded capture; optional VPU + CPU ONNX + ERP crops, not real-time NPU throughput'}
    try:
        video = out / 'capture.mkv'
        with (out / 'capture.log').open('w') as log:
            subprocess.run([str(FF/'ffmpeg'), '-nostdin', '-v', 'warning',
                            '-rw_timeout', '8000000', '-i', config['source_url'],
                            '-t', '8', '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
                            '-n', str(video)], stdout=log, stderr=log, check=True, timeout=35)
        metadata = json.loads(subprocess.check_output(
            [str(FF/'ffprobe'), '-v', 'error', '-show_streams', '-show_format',
             '-of', 'json', str(video)], text=True, timeout=15))
        (out / 'media.json').write_text(json.dumps(metadata, indent=2))
        stream = next(s for s in metadata['streams'] if s['codec_type'] == 'video')
        for key in ('codec_name', 'width', 'height'):
            if stream[key] != config['expected_video'][key]:
                raise RuntimeError(f'Unexpected {key}: {stream[key]}')
        summary['video'] = {key: stream.get(key) for key in
                            ('codec_name', 'width', 'height', 'r_frame_rate', 'has_b_frames')}
        summary['capture_bytes'] = video.stat().st_size
        subprocess.run(['/usr/bin/ffmpeg', '-nostdin', '-v', 'error', '-threads', '2',
                        '-i', str(video), '-frames:v', '1', '-vf', 'scale=1280:640',
                        '-n', str(out/'preview.jpg')], check=True, timeout=30)
        if args.infer:
            classes = out / 'classes.json'
            classes.write_text(json.dumps([str(i) for i in range(80)]))
            env = dict(os.environ, LD_LIBRARY_PATH='/usr/hobot/lib:' + str(ROOT/'out/deps/onnxruntime-1.23.2/lib'))
            report = out / 'inference.json'
            with (out/'inference.log').open('w') as log:
                subprocess.run([str(ROOT/'out/build/ai-s100p/ainvr_pipeline_probe'),
                                str(ROOT/'ai-service/models/yolo26m.onnx'), str(video),
                                'end2end', '2', str(report), str(classes),
                                str(out/'erp-crops'), 'erp_equirect'],
                               env=env, stdout=log, stderr=log, check=True, timeout=120)
            frames = json.loads(report.read_text())['frames']
            if len(frames) != 2:
                raise RuntimeError('Expected two decoded/inferred frames')
            summary['inference_frames'] = len(frames)
            summary['detections_per_frame'] = [len(f['detections']) for f in frames]
            summary['snapshots_per_frame'] = [len(f['snapshots']) for f in frames]
        summary['passed'] = True
    except Exception as error:
        summary['error'] = str(error)
        raise
    finally:
        (out/'summary.json').write_text(json.dumps(summary, indent=2))
        print(out/'summary.json', flush=True)


if __name__ == '__main__':
    main()
