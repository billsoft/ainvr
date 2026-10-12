#!/usr/bin/env python3
"""Copyright AINVR. Create local secrets once; never rotate on repeat runs."""
import os
from pathlib import Path
import secrets

root = Path(__file__).resolve().parent
secret_dir = root / 'secrets'
secret_dir.mkdir(mode=0o700, exist_ok=True)
secret_dir.chmod(0o700)
for name in ('pg_admin_password', 'pg_app_password',
             'mongo_admin_password', 'mongo_app_password'):
    path = secret_dir / name
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if not path.read_text().strip():
            raise RuntimeError(f'Existing secret is empty: {name}')
    else:
        with os.fdopen(fd, 'w') as file:
            file.write(secrets.token_hex(32) + '\n')
    # Compose mounts files without remapping ownership. Container database
    # users need read access; the host parent directory stays root-only (0700).
    path.chmod(0o444)
for name in ('postgres', 'mongo'):
    path = root / 'data' / name
    path.mkdir(parents=True, exist_ok=True)
    # PGDATA is a private 0700 child owned by postgres. Its bind-mount parent
    # must remain traversable after the image entrypoint drops root privileges.
    path.chmod(0o755 if name == 'postgres' else 0o700)
print('AINVR infrastructure directories and secrets are ready.')
