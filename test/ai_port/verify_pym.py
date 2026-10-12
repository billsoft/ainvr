#!/usr/bin/env python3
"""AINVR: bounded serial board verification of PYM/GLES dispatch."""
import datetime
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

def main():
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    output = ROOT / 'test/results' / ('pym-' + stamp)
    output.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ, LD_LIBRARY_PATH='/usr/hobot/lib')
    commands = [
        ['cmake', '-S', str(ROOT/'ai-service'), '-B', str(ROOT/'out/build/ai-s100p')],
        ['cmake', '--build', str(ROOT/'out/build/ai-s100p'), '-j4'],
        ['ctest', '--test-dir', str(ROOT/'out/build/ai-s100p'), '-R', '^(pym|gdc|image_preprocessor|gles)$', '-V'],
    ]
    for index, command in enumerate(commands):
        with (output / f'{index}.log').open('w', encoding='utf-8') as log:
            subprocess.run(command, cwd=ROOT, env=env, stdout=log,
                           stderr=subprocess.STDOUT, timeout=180, check=True)
    print(output)

if __name__ == '__main__':
    main()
