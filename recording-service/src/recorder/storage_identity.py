"""Stable storage namespace; credential rotation does not change file ownership."""
import hashlib
import json
import os

from .config import DEFAULT_LOCAL_PATH, StorageConfig


def storage_identity(config: StorageConfig) -> str:
    if config.kind == 'local':
        identity = ['local', os.path.abspath(config.localPath or DEFAULT_LOCAL_PATH)]
    else:
        smb = config.smb
        if smb is None:
            raise ValueError('SMB configuration required')
        identity = ['smb', smb.host.strip().strip('/').lower(), smb.share.strip('/'),
                    os.path.normpath('/' + (smb.path or '').strip('/'))]
    return hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()[:24]
