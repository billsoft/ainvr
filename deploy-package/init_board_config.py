#!/usr/bin/env python3
"""Create paired per-board credentials once; never overwrite existing files."""
import argparse
import os
from pathlib import Path
import secrets


def initialize(console, etc):
    names = ('POSTGRES_PASSWORD', 'CONFIG_SERVICE_TOKEN_RECORDER',
             'CONFIG_SERVICE_TOKEN_AI_SERVICE', 'RESTART_HELPER_TOKEN', 'OS_HELPER_TOKEN')
    values = {name: secrets.token_hex(32) for name in names}
    files = {console / '.env': ''.join(k + '=' + v + '\n' for k, v in values.items()) +
             'LICENSE_ENV_FILE=/etc/ainvr-license/console-backend.env\n' +
             'COMPOSE_PROJECT_NAME=srs-web-console\n'}
    for name, relative in (
        ('CONFIG_SERVICE_TOKEN_AI_SERVICE', 'ainvr-ai/service.env'),
        ('CONFIG_SERVICE_TOKEN_RECORDER', 'ainvr-recorder/service.env'),
        ('OS_HELPER_TOKEN', 'ainvr-ai/os-helper.env'),
        ('RESTART_HELPER_TOKEN', 'ainvr-ai/restart-helper.env'),
    ):
        files[etc / relative] = name + '=' + values[name] + '\n'
    if any(path.exists() or path.is_symlink() for path in files):
        raise ValueError('Existing configuration detected; use the upgrade/rotation procedure, not initialization')
    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--layout', choices=('home', 'opt'), default='home')
    # 已废弃：WebRTC 播放地址默认按浏览器访问地址自动适配。保留参数只为兼容旧手册，传了也忽略。
    p.add_argument('--candidate-ip', help=argparse.SUPPRESS)
    p.add_argument('--new-board', action='store_true', required=True)
    args = p.parse_args()
    if os.geteuid() != 0:
        p.error('Run with sudo on a new target board only')
    console = Path('/home/sunrise/ainvr/srs-web-console' if args.layout == 'home' else '/opt/ainvr-console')
    try:
        if args.candidate_ip:
            print('Note: --candidate-ip is ignored; WebRTC address now follows the browser access address')
        initialize(console, Path('/etc'))
    except (OSError, ValueError) as exc:
        p.exit(1, str(exc) + '\n')
    print('Created per-board environment files with mode 0600; credential values hidden')
