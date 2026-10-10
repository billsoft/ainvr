#!/usr/bin/env python3
"""Keep a provenance manifest and readable official S100 source snapshots."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
REPOS = {
    'rdk-official-docs': 'https://github.com/D-Robotics/rdk_doc.git',
    'gs130-camera-sdk': 'https://github.com/D-Robotics/gs130_camera_sdk.git',
}


def git(directory, *args):
    return subprocess.check_output(['git', '-C', str(directory), *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', help='Fetch and fast-forward clean official clones')
    args = parser.parse_args()
    if ROOT != Path('/home/sunrise/ainvr/test'):
        raise RuntimeError('Run in the authorized remote test directory')
    repos = []
    for name, url in REPOS.items():
        path = ROOT / 'runtime' / name
        if git(path, 'remote', 'get-url', 'origin') != url:
            raise RuntimeError('Unexpected source origin: ' + name)
        if args.refresh:
            if git(path, 'status', '--porcelain'):
                raise RuntimeError('Preserve modified source checkout: ' + str(path))
            subprocess.run(['git', '-C', str(path), 'fetch', '--depth', '1', 'origin', 'main'], check=True)
            if git(path, 'rev-parse', 'HEAD') != git(path, 'rev-parse', 'FETCH_HEAD'):
                # Updating these clean reference clones is explicitly requested.
                subprocess.run(['git', '-C', str(path), 'merge', '--ff-only', 'FETCH_HEAD'], check=True)
        repos.append({'url': url, 'path': str(path), 'commit': git(path, 'rev-parse', 'HEAD'),
                      'commit_time': git(path, 'show', '-s', '--format=%cI', 'HEAD'),
                      'description': 'Developer preview (Alpha)' if name == 'gs130-camera-sdk' else 'Official documentation sources'})
    version = subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', 'hobot-multimedia-samples'], text=True)
    target = ROOT / 'runtime' / ('official-multimedia-samples-' + version)
    if not target.exists():
        # Published package source; no compiled output is manufactured here.
        shutil.copytree('/app/multimedia_samples', target, symlinks=True)
    hashes = {}
    for file in sorted(target.rglob('*')):
        if file.is_file() and not file.is_symlink() and file.suffix in {'.c', '.h', '.cpp', '.py'}:
            hashes[str(file.relative_to(target))] = hashlib.sha256(file.read_bytes()).hexdigest()
    installed = subprocess.check_output(['dpkg-query', '-W',
        '-f=${db:Status-Abbrev}\t${binary:Package}\t${Version}\n',
        'hobot-camera', 'hobot-multimedia', 'hobot-multimedia-dev',
        'hobot-multimedia-samples', 'hobot-spdev', 'hobot-miniboot',
        'hobot-firmware', 'linux-image-rdk-s100'], text=True)
    result = {'captured_at': datetime.now(timezone.utc).isoformat(),
              'running_kernel': subprocess.check_output(['uname', '-r'], text=True).strip(),
              'repositories': repos, 'installed_packages': installed.splitlines(),
              'official_samples': {'version': version, 'path': str(target), 'source_sha256': hashes},
              'release_notes': [
                'https://developer.d-robotics.cc/rdk_s_doc/Release_Note/s100/v4_0_5',
                'https://developer.d-robotics.cc/rdk_s_doc/Release_Note/s100/v4_0_5_260507'],
              'scope': 'Public documentation/GS130 sources and official packaged SDK samples. Full private BSP sources require official account access.'}
    output = ROOT / 'results/official-sources.json'
    output.write_text(json.dumps(result, indent=2))
    print(str(output))
    print('Pinned ' + str(len(repos)) + ' repositories and ' + str(len(hashes)) + ' sample source files.')


if __name__ == '__main__':
    main()
