#!/usr/bin/env python3
"""AINVR: download the pinned official YOLO26x asset to SSD, verify before use."""
import hashlib
import json
import os
from pathlib import Path
import urllib.request

URL = 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26x.pt'
EXPECTED_SIZE = 118667365
EXPECTED_SHA256 = '9fdd44a31c504547ffb81d2c6d9e6dac3493c8eaa8b0398d3f43bae6c7003e92'
ROOT = Path('/mnt/ainvr-ssd/model-sources/ainvr-20261012/models')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def main():
    if not Path('/mnt/ainvr-ssd').is_mount() or ROOT.resolve() != ROOT:
        raise RuntimeError('Canonical mounted SSD required')
    ROOT.mkdir(parents=True, exist_ok=True)
    target = ROOT / 'yolo26x.pt'
    if target.exists():
        if target.stat().st_size != EXPECTED_SIZE or digest(target) != EXPECTED_SHA256:
            raise RuntimeError('Existing YOLO26x differs; preserve and inspect it')
    else:
        partial = target.with_name(target.name + '.download-' + str(os.getpid()))
        h, size = hashlib.sha256(), 0
        request = urllib.request.Request(URL, headers={'User-Agent': 'AINVR-model-conversion'})
        with urllib.request.urlopen(request, timeout=30) as src, partial.open('xb') as dst:
            for block in iter(lambda: src.read(1024 * 1024), b''):
                size += len(block)
                if size > EXPECTED_SIZE:
                    raise RuntimeError('Download exceeded official asset size')
                h.update(block)
                dst.write(block)
            dst.flush()
            os.fsync(dst.fileno())
        if size != EXPECTED_SIZE or h.hexdigest() != EXPECTED_SHA256:
            raise RuntimeError('Official asset checksum mismatch')
        if target.exists():
            raise RuntimeError('Destination appeared during download')
        os.rename(partial, target)
    report = {'download_verified': True, 'path': str(target), 'url': URL,
              'bytes': EXPECTED_SIZE, 'sha256': EXPECTED_SHA256,
              'digest_source': 'GitHub ultralytics/assets v8.4.0 release API asset digest',
              'hbm_compiled': False}
    provenance = ROOT.parent / 'yolo26x-download.json'
    if provenance.exists() and json.loads(provenance.read_text()) != report:
        raise RuntimeError('Existing provenance differs')
    provenance.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
