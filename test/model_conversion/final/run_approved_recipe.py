#!/usr/bin/env python3
"""Print a pinned, already-validated BC recipe; --execute compiles a new candidate.

Run inside OE GPU 3.7.0. This never installs a model or declares accuracy passed.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys


def command(recipe, checkpoints, output, scripts):
    bc = checkpoints / recipe['checkpoint_file']
    if not bc.is_file():
        raise ValueError(f'Missing approved checkpoint: {bc}')
    digest = hashlib.sha256()
    with bc.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != recipe['bc_sha256']:
        raise ValueError(f'Checkpoint SHA256 mismatch: {bc}')
    if output.exists():
        raise ValueError(f'Output already exists: {output}')
    return [sys.executable, str(scripts / 'compile_saved_bc.py'),
            '--bc', str(bc), '--expected-sha256', recipe['bc_sha256'],
            '--output', str(output), '--opt', str(recipe['opt']),
            '--jobs', str(recipe['jobs']), '--cache-mode', 'enable',
            '--filename', recipe['filename']]


def main():
    here = Path(__file__).resolve().parent
    lock = json.loads((here / 'approved-recipes.json').read_text())
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('model', choices=lock['recipes'])
    p.add_argument('--checkpoints', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--execute', action='store_true')
    a = p.parse_args()
    cmd = command(lock['recipes'][a.model], a.checkpoints.resolve(),
                  a.output.resolve(), here.parent)
    print(shlex.join(cmd), flush=True)
    if a.execute:
        subprocess.run(cmd, check=True)
        print('Candidate only: repeat placement, 128-sample board comparison and speed gates before deployment.')


if __name__ == '__main__':
    main()
