#!/usr/bin/env python3
"""Bind one model archive to a release; never select an arbitrary wildcard match.

模型很少变化（4.2GB），打包时先找可沿用的旧模型包：内容指纹（每个文件的路径、大小、
修改时间）与当前 ai-service/models 完全一致才沿用，否则重新打包。指纹缓存在模型包旁的
<包名>.fingerprint.json（只在打包机 out/ 里，不进发布包）；旧包第一次没有缓存时从包内容算出。
"""
import argparse
import hashlib
import os
import json
from pathlib import Path
import sys
import tarfile


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def validate_archive(path):
    with tarfile.open(path, 'r:gz') as archive:
        count = 0
        for entry in archive:
            name = Path(entry.name)
            if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != 'models':
                raise ValueError('Model archive contains an out-of-tree path')
            if not (entry.isdir() or entry.isfile()):
                raise ValueError('Model archive must contain only regular files/directories')
            count += entry.isfile()
        if not count:
            raise ValueError('Empty model archive')


def source_fingerprint(models_dir):
    """当前模型目录：[包内路径, 大小, 修改时间(秒)]，与 tar --dereference 记录的口径一致。"""
    models_dir = Path(models_dir)
    rows = []
    for root, _dirs, files in os.walk(models_dir, followlinks=True):
        for name in files:
            path = Path(root) / name
            st = path.stat()
            rel = 'models/' + path.relative_to(models_dir).as_posix()
            rows.append([rel, st.st_size, int(st.st_mtime)])
    return sorted(rows)


def archive_fingerprint(archive):
    with tarfile.open(archive, 'r:gz') as tar:
        return sorted([m.name, m.size, int(m.mtime)] for m in tar if m.isfile())


def sidecar(archive):
    archive = Path(archive)
    return archive.with_name(archive.name + '.fingerprint.json')


def record_fingerprint(archive, models_dir):
    sidecar(archive).write_text(json.dumps({'files': source_fingerprint(models_dir)}) + '\n')


def _cached_fingerprint(archive):
    try:
        files = json.loads(sidecar(archive).read_text()).get('files')
        if isinstance(files, list):
            return files
    except (OSError, ValueError):
        pass
    files = archive_fingerprint(archive)
    try:
        sidecar(archive).write_text(json.dumps({'files': files}) + '\n')
    except OSError:
        pass
    return files


def find_reusable(out_dir, models_dir):
    """最新的、内容与当前模型目录一致的模型包；没有则 None（调用方重新打包）。"""
    current = source_fingerprint(models_dir)
    for archive in sorted(Path(out_dir).glob('models-*.tar.gz'), reverse=True):
        if archive.is_symlink() or not archive.is_file():
            continue
        try:
            # 结构校验与校验和由随后的 --create 统一做，这里只比指纹（有缓存时只读一个小文件）
            if _cached_fingerprint(archive) == current:
                return archive
        except (OSError, ValueError, tarfile.TarError, EOFError):
            continue
    return None


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--reuse-from', type=Path, help='打包机 out 目录：输出可沿用的模型包路径，没有则退出码 3')
    parser.add_argument('--record-fingerprint', type=Path, help='新打的模型包：记录内容指纹供下次沿用')
    parser.add_argument('--source', type=Path, help='模型目录（ai-service/models）')
    parser.add_argument('--create', type=Path)
    parser.add_argument('--directory', type=Path)
    args = parser.parse_args()
    if args.reuse_from or args.record_fingerprint:
        if args.source is None:
            parser.error('--source is required')
        if args.record_fingerprint:
            record_fingerprint(args.record_fingerprint, args.source)
            sys.exit(0)
        found = find_reusable(args.reuse_from, args.source)
        if found is None:
            sys.exit(3)
        print(found)
        sys.exit(0)
    if args.manifest is None:
        parser.error('--manifest is required')
    if args.create:
        validate_archive(args.create)
        args.manifest.write_text(json.dumps({'file': args.create.name, 'sha256': digest(args.create)}, indent=2) + '\n')
    else:
        if args.directory is None:
            parser.error('--directory is required for verification')
        spec = json.loads(args.manifest.read_text())
        if Path(spec['file']).name != spec['file'] or not spec['file'].endswith('.tar.gz'):
            parser.error('Invalid model archive name')
        path = args.directory / spec['file']
        if path.is_symlink() or digest(path) != spec['sha256']:
            parser.error('Model package checksum mismatch')
        validate_archive(path)
        print(path.resolve())
