#!/usr/bin/env python3
"""Release hygiene and transport checksums; NOT a signature/trust anchor."""
import argparse
import hashlib
import json
from pathlib import Path

MANIFEST = 'release-manifest.json'


SRS_CONF = 'compose/deploy/srs-conf/srs.conf'


def check_srs_conf(root):
    """发布包的 WebRTC 候选地址必须是自动（*）：不能把构建机上页面指定的地址带给其他设备。"""
    path = root / SRS_CONF
    if not path.is_file():
        return
    lines = [l.strip() for l in path.read_text(encoding='utf-8').splitlines()
             if l.strip().startswith('candidate') and l.strip()[9:10] in (' ', '\t')]
    if [l.split()[1] for l in lines] != ['*;']:
        raise ValueError('Release srs.conf must use automatic WebRTC candidate (candidate *;): ' + '; '.join(lines))


def inventory(root):
    check_srs_conf(root)
    files = {}
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root).as_posix()
        if path.is_symlink():
            raise ValueError('Symlink in release: ' + rel)
        parts = path.relative_to(root).parts
        if any(p in ('.git', 'secrets', 'license-keygen', '.ainvr-license-issuer') for p in parts) or path.name in (
                'MASTER_KEY.local', 'key_material.hpp', '.env', 'license-service.yaml',
                'signing-private.pem', 'issued-v3.sqlite3', 'issued-v3.sqlite3-wal', 'issued-v3.sqlite3-shm'):
            raise ValueError('Forbidden factory/live material: ' + rel)
        if not path.is_file() or rel == MANIFEST:
            continue
        h = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(chunk)
        files[rel] = h.hexdigest()
    for required in ('ai-service/bin/ai_service', 'ai-service/build-info.txt',
                     'ai-service/runtime/prompted_server.pyc', 'ai-service/runtime/resident_worker.pyc',
                     'ai-service/runtime/yoloe/runtime.pyc', 'ai-service/runtime/yoloe/contract.json',
                     'ai-service/runtime/locateanything/runtime.pyc', 'ai-service/runtime/locateanything/contract.json',
                     'ai-service/deploy/ainvr-yoloe.service', 'ai-service/deploy/ainvr-grounding.service',
                     'configure-prompted-runtimes.py', 'docs/open-vocabulary-runtime-deployment.md',
                     'license-service/bin/license_service',
                     'install.sh', 'install_python_code.py', 'validate_console_env.py',
                     'configure-ingest.py', 'python/ingest-service/main.pyc', 'python/ainvr-ingest.service',
                     'docs/multi-protocol-ingest-design.md',
                      'configure-internal-network.py', 'reset-admin-password.py', 'python/shared/python/internal_network.pyc',
                      'python/recording-service/src/recorder/internal_network.pyc',
                     'init_board_config.py', 'bootstrap-jetson.sh', 'model_package.py', 'models-manifest.json',
                     '60-ainvr-writeback.conf', 'rotate-consumer-keys.py',
                     'compose/deploy/srs-conf/hls.conf', 'compose/deploy/srs-entrypoint.sh',
                     'compose/deploy/srs-observer.py', 'compose/deploy/ainvr-srs-observer.service',
                     'INSTALL-FROM-SCRATCH.md', 'license-service-design.md',
                     'docs/deploy/INSTALL-FROM-SCRATCH.md', 'docs/license-v3-design.md',
                     'docs/h265-codec12-support-design-2026-09-29.md',
                     'license-service/deploy/security_preflight.py',
                     'license-service/deploy/validate_provision.py',
                     'provisioner/ensure_fallback.pyc',
                     'images/thirdparty-images.txt', 'images/thirdparty_images.py'):
        if required not in files:
            raise ValueError('Missing release artifact: ' + required)
    return files


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--write-manifest', action='store_true')
    args = parser.parse_args()
    try:
        files = inventory(args.root)
        manifest = args.root / MANIFEST
        if args.write_manifest:
            manifest.write_text(json.dumps(files, indent=2) + '\n')
        elif json.loads(manifest.read_text()) != files:
            raise ValueError('Release files differ from the transport manifest')
    except (OSError, ValueError) as exc:
        parser.exit(1, str(exc) + '\n')
    print('Release hygiene/checksums passed; authenticity requires trusted delivery')
