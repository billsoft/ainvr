#!/usr/bin/env python3
"""AINVR authorized source-model relocation, with checksums before source unlink.

Only this project's model directory may be moved, only to the mounted SSD.
HBM files and .hbm.ainvr.json runtime sidecars stay in place. Resume an interrupted
operation with the same destination; already copied data is checked again.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

SOURCE = Path('/home/sunrise/ainvr/ai-service/models')
SSD = Path('/mnt/ainvr-ssd')


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for data in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def identity(path):
    s = path.stat()
    return [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns]


def runtime_file(path):
    return path.name.endswith('.hbm') or path.name.endswith('.hbm.ainvr.json')


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save(path, data):
    tmp = path.with_name(path.name + '.tmp-' + str(os.getpid()))
    with tmp.open('x') as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    sync_dir(path.parent)


def opened(path):
    result = []
    for fd in Path('/proc').glob('[0-9]*/fd/*'):
        try:
            if str(fd.readlink()) == str(path):
                result.append(fd.parts[2])
        except OSError:
            pass
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--destination', type=Path, required=True)
    args = p.parse_args()
    source = SOURCE.resolve(strict=True)
    destination = args.destination.resolve()
    if source != SOURCE or not os.path.ismount(SSD) or SSD.resolve() != SSD:
        p.error('Canonical project source and mounted SSD required')
    if not destination.is_relative_to(SSD / 'model-sources') or destination == SSD / 'model-sources':
        p.error('Destination must be a model-sources subdirectory on SSD')
    if source.stat().st_dev == SSD.stat().st_dev:
        p.error('Source is not on the system disk')
    current = []
    for file in source.rglob('*'):
        if file.is_symlink():
            raise RuntimeError('Refusing symlink: ' + str(file))
        if file.is_file() and not runtime_file(file):
            current.append(file)
    required = sum(f.stat().st_size for f in current)
    if shutil.disk_usage(SSD).free < required + 1024 ** 3:
        raise RuntimeError('Insufficient SSD space')
    manifest_path = destination / 'migration-manifest.json'
    if destination.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest['source'] != str(source) or manifest['destination'] != str(destination):
            raise RuntimeError('Existing destination belongs to a different operation')
    else:
        destination.mkdir(parents=True)
        manifest = {'source': str(source), 'destination': str(destination),
                    'created_at': time.strftime('%Y-%m-%d %H:%M:%S'),
                    'passed': False, 'files': [], 'system_disk_before': list(shutil.disk_usage('/'))}
    data_root = destination / 'models'
    data_root.mkdir(exist_ok=True)
    existing = {entry['relative_path'] for entry in manifest['files']}
    for file in sorted(current, key=lambda f: f.stat().st_size, reverse=True):
        rel = str(file.relative_to(source))
        if rel not in existing:
            manifest['files'].append({'relative_path': rel, 'identity': identity(file),
                                      'bytes': file.stat().st_size, 'state': 'pending'})
    save(manifest_path, manifest)
    for entry in manifest['files']:
        rel = Path(entry['relative_path'])
        if rel.is_absolute() or '..' in rel.parts:
            raise RuntimeError('Unsafe manifest relative path')
        original, target = source / rel, data_root / rel
        if original.is_symlink() or target.is_symlink():
            raise RuntimeError('File became a symlink')
        if not original.exists():
            if not target.is_file() or sha(target) != entry.get('sha256'):
                raise RuntimeError('Missing source without a verified destination: ' + str(rel))
            entry['state'] = 'moved'
            continue
        if identity(original) != entry['identity']:
            raise RuntimeError('Source changed since inventory: ' + str(rel))
        if opened(original):
            raise RuntimeError('Source is open by another process: ' + str(rel))
        target.parent.mkdir(parents=True, exist_ok=True)
        entry['state'] = 'copying'
        save(manifest_path, manifest)
        if target.exists():
            expected = entry.get('sha256')
            if not expected or sha(target) != expected:
                raise RuntimeError('Existing destination is not verified: ' + str(rel))
        else:
            partial = target.with_name(target.name + '.partial-' + str(os.getpid()))
            h = hashlib.sha256()
            with original.open('rb') as src, partial.open('xb') as dst:
                for block in iter(lambda: src.read(8 * 1024 * 1024), b''):
                    h.update(block)
                    dst.write(block)
                dst.flush()
                os.fsync(dst.fileno())
            if identity(original) != entry['identity'] or sha(partial) != h.hexdigest():
                raise RuntimeError('Source changed or destination checksum differs: ' + str(rel))
            s = original.stat()
            os.chmod(partial, s.st_mode & 0o777)
            os.chown(partial, s.st_uid, s.st_gid)
            os.utime(partial, ns=(s.st_atime_ns, s.st_mtime_ns))
            entry['sha256'] = h.hexdigest()
            save(manifest_path, manifest)  # enough state to recover before rename/unlink
            os.replace(partial, target)
            sync_dir(target.parent)
        if (identity(original) != entry['identity'] or sha(original) != entry['sha256']
                or identity(original) != entry['identity'] or opened(original)):
            raise RuntimeError('Source changed before final relocation: ' + str(rel))
        entry['state'] = 'verified'
        save(manifest_path, manifest)
        original.unlink()
        sync_dir(original.parent)
        entry['state'] = 'moved'
        save(manifest_path, manifest)
        print(json.dumps({'moved': str(rel), 'bytes': entry['bytes'],
                          'system_disk_free': shutil.disk_usage('/').free}), flush=True)
    remaining = [str(f.relative_to(source)) for f in source.rglob('*')
                 if f.is_file() and not runtime_file(f)]
    manifest.update({'passed': not remaining, 'remaining_non_runtime_files': remaining,
                     'bytes_moved': sum(e['bytes'] for e in manifest['files'] if e['state'] == 'moved'),
                     'system_disk_after': list(shutil.disk_usage('/'))})
    save(manifest_path, manifest)
    print(json.dumps({'passed': manifest['passed'], 'manifest': str(manifest_path),
                      'bytes_moved': manifest['bytes_moved']}), flush=True)
    if not manifest['passed']:
        raise RuntimeError('Additional non-runtime files appeared during relocation')


if __name__ == '__main__':
    main()
