#!/usr/bin/env python3
"""Sequential SC132GS baseline/2D/3D/off trials; stop at first failure."""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys
from inspect_isp_environment import inspect_environment

ROOT = Path(__file__).resolve().parent

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mipi', type=int, nargs='+', choices=[0, 1], default=[0])
    p.add_argument('--frames', type=int, default=90)
    p.add_argument('--timeout', type=int, default=90)
    p.add_argument('--sensor-mode', type=int, choices=[1, 6], default=1)
    p.add_argument('--trigger-duty', type=int, default=1000)
    p.add_argument('--fixed-2a', action='store_true')
    args = p.parse_args()
    if not 8 <= args.frames <= 900 or not 10 <= args.timeout <= 180:
        p.error('frames 8..900, timeout 10..180')
    if not 20 <= args.trigger_duty <= 1000:
        p.error('trigger-duty 20..1000 us')
    out = ROOT/'results'/f"{dt.datetime.now():%Y%m%d-%H%M%S-%f}-isp-camera-matrix"
    out.mkdir(parents=True, exist_ok=False)
    audit = inspect_environment()
    (out/'environment.json').write_text(json.dumps(audit, indent=2))
    rows = []
    halted = not audit['ready_for_attempt']
    for mipi in dict.fromkeys(args.mipi):
        for mode in ('baseline', 'nr2d_only', 'nr3d_only', 'nr_off'):
            row = {'mipi': mipi, 'nr': mode, 'sensor_mode': args.sensor_mode, 'fixed_2a':args.fixed_2a, 'status': 'SKIP'}
            if halted:
                row['reason'] = 'Environment blocked or earlier capture failed; not executed'
            else:
                before = set(ROOT.glob('results/*-isp_camera/result.json'))
                command = [sys.executable, str(ROOT/'test_isp_camera.py'), '--mipi', str(mipi),
                           '--nr', mode, '--frames', str(args.frames), '--timeout', str(args.timeout),
                           '--sensor-mode', str(args.sensor_mode), '--trigger-duty', str(args.trigger_duty)]
                if args.fixed_2a:command.append('--fixed-2a')
                with (out/f'mipi{mipi}-{mode}.log').open('w') as log:
                    try:
                        # Child owns hardware subprocess groups and enforces each
                        # command timeout; do not kill its cleanup with an outer timer.
                        proc = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
                        result_paths = set(ROOT.glob('results/*-isp_camera/result.json'))-before
                        if len(result_paths) != 1:
                            raise RuntimeError('Missing or ambiguous child result')
                        result_path = result_paths.pop()
                        child = json.loads(result_path.read_text())
                        row.update(status=child['status'], result=str(result_path), returncode=proc.returncode)
                        halted = proc.returncode != 0 or child['status'] != 'PASS'
                    except RuntimeError as exc:
                        row.update(status='FAIL', reason=str(exc))
                        halted = True
            rows.append(row)
            (out/'matrix.json').write_text(json.dumps({'environment_ready': audit['ready_for_attempt'],
                'trials': rows, 'scope': 'Independent sequential runs; temporal noise differences are not proof of denoising quality. No simultaneous stereo throughput claim.'}, indent=2))
            print(f"[{row['status']}] MIPI{mipi} {mode}", flush=True)
    print('RESULT', out/'matrix.json')
    raise SystemExit(1 if halted else 0)

if __name__ == '__main__':
    main()
