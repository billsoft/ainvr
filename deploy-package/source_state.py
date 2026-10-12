#!/usr/bin/env python3
"""Record exact source identity without distributing diffs or credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def snapshot(root):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args])
    diff = git('diff', '--binary', 'HEAD', '--')
    untracked = {}
    for raw in git('ls-files', '--others', '--exclude-standard', '-z').split(b'\0'):
        if raw:
            name = raw.decode('utf-8')
            file = root / name
            if file.is_file():
                untracked[name] = hashlib.sha256(file.read_bytes()).hexdigest()
    return {'commit': git('rev-parse', 'HEAD').decode().strip(),
            'dirty': bool(diff or untracked),
            'diff_sha256': hashlib.sha256(diff).hexdigest(), 'untracked_sha256': untracked}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    state = snapshot(args.root)
    if args.verify:
        if json.loads(args.manifest.read_text()) != state:
            parser.exit(1, 'Source changed during build; do not release mixed artifacts\n')
    else:
        args.manifest.write_text(json.dumps(state, indent=2) + '\n')
