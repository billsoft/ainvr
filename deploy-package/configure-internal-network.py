#!/usr/bin/env python3
"""Generate host-service peer policy from the console's actual Docker network."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

POLICY = Path('/etc/ainvr-ai-internal-networks.json')
EXTRA = Path('/etc/ainvr-ai-trusted-peers.json')

def discover(run=subprocess.check_output):
    containers=json.loads(run(['docker','inspect','ainvr-backend','ainvr-web'],text=True,timeout=5))
    ids={v['NetworkID'] for c in containers for v in c['NetworkSettings']['Networks'].values()}
    if not ids: raise RuntimeError('Console containers have no networks')
    networks=json.loads(run(['docker','network','inspect',*sorted(ids)],text=True,timeout=5))
    return sorted({c['Subnet'] for n in networks for c in n['IPAM']['Config'] if c.get('Subnet')})

def validate(values):
    if not isinstance(values, list) or len(values) > 32:
        raise ValueError('Peer policy must be an array of at most 32 CIDRs')
    result = []
    for value in values:
        if not isinstance(value, str):
            raise ValueError('Trusted peers must be CIDR strings')
        net = ipaddress.ip_network(value, strict=True)
        if net.prefixlen == 0:
            raise ValueError('A /0 peer policy is forbidden')
        result.append(str(net))
    return sorted(set(result))


def update(path=POLICY, extra=EXTRA, static_only=False, discover_fn=discover):
    manual = validate(json.loads(extra.read_text())) if extra.exists() else []
    values = validate(([] if static_only else discover_fn()) + manual)
    if not values and not static_only:
        raise ValueError('No trusted peers; existing policy unchanged')
    content = json.dumps(values) + '\n'
    if path.exists() and path.read_text() == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
            os.fchmod(stream.fileno(), 0o644)
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)
    print('Host API peer policy updated:', ', '.join(values))
    return True


def install_monitor(static_only=False):
    if os.geteuid() != 0:
        raise PermissionError('Run with sudo')
    target = Path('/usr/local/lib/ainvr-ai/configure-internal-network.py')
    target.parent.mkdir(parents=True, exist_ok=True)
    if Path(__file__).resolve() != target:
        shutil.copyfile(__file__, target)
    os.chown(target, 0, 0)
    os.chmod(target, 0o755)
    mode = ' --static-only' if static_only else ''
    Path('/etc/systemd/system/ainvr-internal-network.service').write_text(
        '[Unit]\nDescription=Refresh AINVR trusted network policy\nAfter=docker.service\n'
        '[Service]\nType=oneshot\nExecStart=/usr/bin/python3 ' + str(target) + mode + '\n'
        'TimeoutStartSec=15\nNoNewPrivileges=true\nPrivateTmp=true\n')
    Path('/etc/systemd/system/ainvr-internal-network.timer').write_text(
        '[Unit]\nDescription=Track AINVR Docker network changes\n'
        '[Timer]\nOnBootSec=20\nOnUnitActiveSec=30\nAccuracySec=5\n'
        '[Install]\nWantedBy=timers.target\n')
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'ainvr-internal-network.timer'], check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-monitor', action='store_true')
    parser.add_argument('--static-only', action='store_true', help='Remote console deployment: use explicit trusted peers only')
    args = parser.parse_args()
    update(static_only=args.static_only)
    if args.install_monitor:
        install_monitor(args.static_only)
