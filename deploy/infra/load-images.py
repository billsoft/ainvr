#!/usr/bin/env python3
"""Copyright AINVR. Verify and import an offline bundle without a registry."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('bundle', type=Path)
args = parser.parse_args()
bundle = args.bundle.resolve()
root = Path(__file__).resolve().parent
records = json.loads((bundle / 'images.lock.json').read_text())
for record in records:
    path = bundle / record['archive']
    if path.parent.resolve() != bundle:
        raise SystemExit('Archive path escapes bundle directory')
    with path.open('rb') as file:
        actual = hashlib.sha256()
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            actual.update(chunk)
    if actual.hexdigest() != record['archive_sha256']:
        raise SystemExit('Archive checksum mismatch: ' + path.name)
    subprocess.run(['docker', 'load', '-i', str(path)], check=True)
    print('Imported verified archive:', path.name, flush=True)
temp = root / ('images.lock.json.upload-' + uuid.uuid4().hex)
temp.write_text(json.dumps(records, indent=2) + '\n')
os.replace(temp, root / 'images.lock.json')
subprocess.run(['python3', str(root / 'check-images.py')], check=True)
