#!/usr/bin/env python3
"""Read-only ISP SDK/package audit. Passing preflight does not prove ABI or frames."""
import argparse
import datetime as dt
import json
from pathlib import Path
import platform
import re
import subprocess

PACKAGES = ('hobot-camera', 'hobot-multimedia', 'hobot-multimedia-dev',
            'hobot-multimedia-samples', 'linux-image-rdk-s100')
ROOT = Path(__file__).resolve().parent

def inspect_environment():
    proc = subprocess.run(['dpkg-query', '-W',
                           '-f=${db:Status-Abbrev}\t${binary:Package}\t${Version}\n'],
                          capture_output=True, text=True, timeout=15, check=True)
    packages = {}
    pending = []
    for line in proc.stdout.splitlines():
        status, name, version = line.split('\t', 2)
        name = name.split(':')[0]
        item = {'name': name, 'status': status, 'version': version}
        if name in PACKAGES:
            packages[name] = item
        if status[0] == 'i' and status != 'ii ':
            pending.append(item)
    blockers = []
    if pending:
        blockers.append(f'{len(pending)} requested-installed packages are not fully configured')
    branches = {}
    for name in PACKAGES[:-1]:
        item = packages.get(name)
        if not item or item['status'] != 'ii ':
            blockers.append(f'{name} missing or not fully configured')
        if item:
            branches[name] = item['version'].split('-')[0]
    if len(set(branches.values())) > 1:
        blockers.append('Camera, multimedia headers, runtime and samples have different SDK branches')
    kernel = platform.release()
    match = re.search(r'-DR-(\d+\.\d+\.\d+)-', kernel)
    if match and branches.get('hobot-camera') != match.group(1):
        blockers.append('Camera SDK branch differs from running RDK kernel branch')
    if not match:
        blockers.append('Running kernel branch cannot be identified; manual compatibility review required')
    demos = {
        'vin': '/app/multimedia_samples/sample_vin',
        'isp': '/app/multimedia_samples/sample_isp/get_isp_data',
        'pipeline': '/app/multimedia_samples/sample_pipeline/single_pipe_vin_isp_ynr_pym_vpu',
    }
    return {'created': dt.datetime.now().astimezone().isoformat(), 'kernel': kernel,
            'packages': packages, 'pending_count': len(pending), 'pending_packages': pending,
            'official_demo_paths': {k: {'path': v, 'exists': Path(v).exists()} for k, v in demos.items()},
            'blockers': blockers, 'ready_for_attempt': not blockers,
            'scope': 'Conservative version preflight only; matching branch labels do not prove driver/SDK ABI compatibility or successful capture. No package changes performed.'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    result = inspect_environment()
    out = ROOT/'results'/f"{dt.datetime.now():%Y%m%d-%H%M%S-%f}-isp-environment"
    out.mkdir(parents=True, exist_ok=False)
    (out/'environment.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k: result[k] for k in ('kernel', 'packages', 'pending_count', 'blockers', 'ready_for_attempt')}, indent=2))
    print('RESULT', out/'environment.json')
    raise SystemExit(0 if result['ready_for_attempt'] else 2)

if __name__ == '__main__':
    main()
