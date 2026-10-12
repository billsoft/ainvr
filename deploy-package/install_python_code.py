#!/usr/bin/env python3
"""Replace code trees; preserve data and keep old source outside import paths."""
import argparse
import importlib.util
from pathlib import Path
import os
import shutil
import subprocess
import tempfile


def validate(package, license_only, recorder_python):
    required = ['shared/python/license_client.pyc', 'shared/python/config_center_client.pyc',
                'shared/python/internal_network.pyc',
                'shared/license-enforcer/main.pyc']
    if not license_only:
        required += ['recording-service/src/recorder/__init__.pyc',
                     'ingest-service/main.pyc',
                      'recording-service/src/recorder/main.pyc', 'recording-service/src/recorder/internal_network.pyc', 'shared/ainvr_logging.pyc',
                     'shared/os-helper/main.pyc', 'shared/os-helper/nm.pyc',
                     'shared/os-helper/remote_assist.pyc', 'shared/os-helper/systime.pyc',
                     'shared/host-restart-helper/restart_helper.pyc',
                     'shared/host-restart-helper/observability.pyc']
    for relative in required:
        if not (package / relative).is_file():
            raise ValueError('Missing Python artifact: ' + relative)
    magic = importlib.util.MAGIC_NUMBER
    if not license_only:
        recorder_magic = subprocess.check_output(
            [recorder_python, '-c', 'import importlib.util; print(importlib.util.MAGIC_NUMBER.hex())'],
            text=True, timeout=10).strip()
        if recorder_magic != magic.hex():
            raise ValueError('Recorder and helper Python bytecode versions differ; rebuild for target runtimes')
    for path in package.rglob('*'):
        if path.is_symlink():
            raise ValueError('Symlink in Python package')
        if path.suffix == '.pyc' and path.read_bytes()[:4] != magic:
            raise ValueError('Python bytecode version mismatch')


def publish_tree(source, destination, backup):
    if not source.is_dir() or source.is_symlink():
        raise ValueError('Missing code tree: ' + str(source))
    for path in source.rglob('*'):
        if path.is_symlink():
            raise ValueError('Symlink in release code')
    if destination.is_symlink():
        raise ValueError('Refusing symlink destination')
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.code-', dir=destination.parent))
    shutil.copytree(source, stage, dirs_exist_ok=True)
    old = backup / str(len(list(backup.iterdir())))
    if destination.exists():
        shutil.move(str(destination), str(old))
    try:
        os.replace(stage, destination)
    except BaseException:
        if old.exists():
            shutil.move(str(old), str(destination))
        raise


def publish_files(source, destination, backup):
    # Helpers keep runtime data in subdirectories: replace only top-level code.
    destination.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        raise ValueError('Refusing symlink destination')
    for path in list(destination.iterdir()):
        if path.suffix in ('.py', '.pyc', '.pyo') or path.name == '__pycache__':
            shutil.move(str(path), str(backup / (str(len(list(backup.iterdir()))) + '-' + path.name)))
    for path in source.iterdir():
        if path.suffix in ('.py', '.pyc', '.pyo'):
            if not path.is_file() or path.is_symlink():
                raise ValueError('Invalid release code file')
            shutil.copy2(path, destination / path.name)


def install(package, recorder, shared, backup, license_only=False):
    publish_tree(package / 'shared/python', shared / 'python', backup)
    publish_tree(package / 'shared/license-enforcer', shared / 'license-enforcer', backup)
    if not license_only:
        publish_tree(package / 'recording-service/src', recorder / 'src', backup)
        publish_tree(package / 'ingest-service', shared.parent / 'ingest-service', backup)
        for name in ('os-helper', 'host-restart-helper'):
            publish_files(package / 'shared' / name, shared / name, backup)
        # This top-level shared module has no other top-level code consumers.
        for suffix in ('.py', '.pyc', '.pyo'):
            old = shared / ('ainvr_logging' + suffix)
            if old.exists():
                shutil.move(str(old), str(backup / (str(len(list(backup.iterdir()))) + old.name)))
            new = package / 'shared' / old.name
            if new.is_file():
                shutil.copy2(new, old)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--package', type=Path, required=True)
    p.add_argument('--recorder', type=Path, required=True)
    p.add_argument('--shared', type=Path, required=True)
    p.add_argument('--license-only', action='store_true')
    p.add_argument('--validate-only', action='store_true')
    p.add_argument('--recorder-python', default='/home/sunrise/ainvr/.venv/bin/python3')
    a = p.parse_args()
    validate(a.package, a.license_only, a.recorder_python)
    if a.validate_only:
        print('Python runtime/artifact preflight passed')
        raise SystemExit(0)
    root = Path('/var/lib/ainvr-deploy-backups')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix='python-', dir=root))
    install(a.package, a.recorder, a.shared, backup, a.license_only)
    print('Previous code retained at ' + str(backup))
