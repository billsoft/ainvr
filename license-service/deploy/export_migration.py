#!/usr/bin/env python3
"""Read-only v2 entitlement export. No device keys or consumer credentials leave the board.

The new C++ service independently authenticates the original state and matches the
issuer-signed ticket before changing anything. Export does not authorize migration.
"""
import argparse
import base64
import json
from pathlib import Path
import secrets

def export(config: Path, destination: Path):
    cfg = json.loads(config.read_text())
    path = Path(cfg.get('state', {}).get('primary', '/var/lib/ainvr-license/state.dat'))
    if path.stat().st_size > 16384: raise ValueError('State too large')
    state = json.loads(path.read_text())['data']
    if state['schema'] != 2: raise ValueError('Only a v2 state needs migration')
    if state.get('revoked'): raise ValueError('Revoked entitlement requires manual recovery, not migration')
    record = {k: state[k] for k in ['license_id','grant_seq','token_hash','activation_wall','total_seconds']}
    request = dict(v=3, product='AINVR', machine_code=cfg['machine_code'],
                   installation_id=secrets.token_hex(16), grant_floor=0, purpose='migrate', challenge='')
    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    (destination/'migration-record.json').write_text(json.dumps(record, indent=2))
    encoded=base64.urlsafe_b64encode(json.dumps(request,sort_keys=True,separators=(',',':')).encode()).rstrip(b'=').decode()
    (destination/'request.txt').write_text('AINVR-REQ3-'+encoded+'\n')
    print('Exported migration request and entitlement metadata; no keys exported')

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config',type=Path,default=Path('/etc/ainvr-license/license-service.yaml'))
    p.add_argument('--out',type=Path,required=True)
    a=p.parse_args()
    try: export(a.config,a.out)
    except (ValueError,KeyError,OSError): p.exit(1,'Migration export rejected; check source state and destination.\n')
