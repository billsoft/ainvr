#!/usr/bin/env python3
"""AINVR bounded A/B worker trials; restore previously active production units."""
import argparse
import copy
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path('/home/sunrise/ainvr')
BACKUP = Path('/mnt/ainvr-ssd/migration-backups/inference-throughput-20261013')


def main():
    assert Path.cwd().resolve() == ROOT and os.geteuid() == 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('label')
    parser.add_argument('--fps', nargs='+', type=float, default=[15, 0])
    args = parser.parse_args()
    if any(not 0 <= fps <= 240 for fps in args.fps):
        parser.error('fps must be between 0 (source rate) and 240')
    label = args.label
    assert label.replace('-', '').isalnum()
    out = ROOT / 'test/results' / ('throughput-' + label + '-20261013')
    out.mkdir(exist_ok=False)
    original = json.loads((BACKUP / 'channels-before.json').read_text())['channels'][0]
    active = [unit for unit in ['ainvr-ai', 'ainvr-recorder']
              if subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0]
    summary = {'label': label, 'restore_units': active, 'trials': [], 'completed': False}
    try:
        if active:
            subprocess.run(['systemctl', 'stop', *active], check=True, timeout=90)
        for fps in args.fps:
            cfg = copy.deepcopy(original['config'])
            cfg['id'] = 'throughput-probe'
            cfg['inference_fps'] = fps
            cfg['publish']['target_url'] = 'rtmp://127.0.0.1:1935/live/ainvr-throughput-probe'
            cfg['publish'].pop('effective_target_url', None)
            cfg['snapshot']['enabled'] = False
            path = out / f'config-{fps}.json'
            path.write_text(json.dumps(cfg))
            report = out / f'worker-{fps}.json'
            with (out / f'worker-{fps}.log').open('w') as log:
                subprocess.run([str(ROOT/'out/build/ai-api-compat/ainvr_throughput_probe'),
                    str(path), str(ROOT/'ai-service'), '35', str(report)],
                    stdout=log, stderr=log, timeout=90, check=True,
                    env={**os.environ, 'LD_LIBRARY_PATH': '/usr/hobot/lib'})
            result = json.loads(report.read_text())
            summary['trials'].append({k: result[k] for k in
                ['measured_fps', 'decoded_fps', 'mean_bpu_percent', 'peak_rss_kib', 'stop_ms']}
                | {'target_fps': fps, 'timing': result['status']['timing'],
                   'publish': result['status'].get('publish')})
        summary['completed'] = True
    finally:
        for unit in active:
            try:
                subprocess.run(['systemctl', 'start', unit], check=True, timeout=90)
            except (subprocess.SubprocessError, OSError) as exc:
                summary.setdefault('restore_errors', []).append(f'{unit}: {exc}')
        summary['restored'] = all(subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0 for unit in active)
        (out/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
        print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
