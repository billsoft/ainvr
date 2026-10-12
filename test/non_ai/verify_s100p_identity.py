#!/usr/bin/env python3
"""AINVR: verify real S100P identity against the running license service.

Read-only: never activates, restarts or rewrites license state. Run again after
a board reboot to compare machine_code; repeated processes alone do not prove
reboot stability. Raw board serial and activation requests are not recorded.
"""
from pathlib import Path
import datetime
import json
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
binary = ROOT / 'out/build/s100p-license/license_service'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path):
    with opener.open('http://127.0.0.1:8001/api/v1/license/' + path,
                     timeout=5) as response:
        return json.load(response)


def main():
    serial = Path('/proc/device-tree/serial-number').read_bytes().strip(b'\0\r\n ')
    assert 4 <= len(serial) <= 128 and serial.strip(b'0'), 'Invalid board serial'
    codes = [subprocess.check_output([str(binary), '--machine-code'],
                                    text=True, timeout=10).strip() for _ in range(3)]
    machine, status = request('machine-code'), request('status')
    assert len(set(codes)) == 1, 'Identity differs across processes'
    assert machine['machine_code'] == status['machine_code'] == codes[0]
    assert machine['fingerprint_version'] == 'v2-board-serial'
    assert 'S100P' in machine['soc_model'], 'Unexpected board model'
    assert status['service_ok'] is True
    result = dict(passed=True, machine_code=codes[0],
                  soc_model=machine['soc_model'],
                  fingerprint_version=machine['fingerprint_version'],
                  license_state=status['state'],
                  scope='Three fresh processes and running HTTP service; no reboot or activation')
    out = ROOT / 'test/results' / ('s100p-identity-' +
          datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.json')
    out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result)); print(out)


if __name__ == '__main__':
    main()
