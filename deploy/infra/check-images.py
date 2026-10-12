#!/usr/bin/env python3
"""Copyright AINVR. Check installed images against recorded upstream IDs."""
import json
import hashlib
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
lock = root / 'images.lock.json'
if not lock.exists():
    raise SystemExit('Missing images.lock.json; import the verified image bundle first.')
for record in json.loads(lock.read_text()):
    image = json.loads(subprocess.check_output(
        ['docker', 'image', 'inspect', record['image']], text=True))[0]
    config_id = image['Id']
    # Docker 29's containerd store reports an index/manifest as .Id, whereas
    # the classic store reports the image configuration digest. Inspect the
    # local content descriptor to verify the original upstream configuration.
    if image.get('Descriptor'):
        descriptor = image['Descriptor']
        while True:
            raw = subprocess.check_output(['ctr', '--namespace', 'moby',
                                           'content', 'get', descriptor['digest']])
            if 'sha256:' + hashlib.sha256(raw).hexdigest() != descriptor['digest']:
                raise SystemExit('Local manifest checksum mismatch')
            manifest = json.loads(raw)
            if 'config' in manifest:
                config_id = manifest['config']['digest']
                break
            descriptor = next(d for d in manifest['manifests']
                              if d.get('platform', {}).get('architecture') == 'arm64'
                              and d['platform']['os'] == 'linux')
    if config_id != record['image_id']:
        raise SystemExit('Image differs from the locked upstream version: ' + record['image'])
    if image['Architecture'] != 'arm64' or image['Os'] != 'linux':
        raise SystemExit('Unexpected image platform: ' + record['image'])
    print(record['image'], 'linux/arm64', 'upstream configuration verified')
