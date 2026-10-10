#!/usr/bin/env python3
"""Bounded RAW10 storage alignment diagnostics; pixel correctness is required."""
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent

def main():
    out = ROOT / 'results' / f'{dt.datetime.now():%Y%m%d-%H%M%S-%f}-isp-raw-alignment'
    out.mkdir(parents=True, exist_ok=False)
    rows = []
    formats=[('unpacked16',order,shift) for order in ('little','big') for shift in (0,2,4,6)]
    formats += [(packing,'little',0) for packing in ('mipi_raw10','bitstream_lsb10','bitstream_msb10')]
    for packing,order,shift in formats:
        before = set(ROOT.glob('results/*-isp_raw_lab/result.json'))
        with (out / f'{packing}-{order}-{shift}.log').open('w') as log:
            proc = subprocess.run([sys.executable, str(ROOT / 'test_isp_raw_lab.py'),
                '--path', 'dummy', '--frames', '8', '--scenario', 'gradient',
                '--calibration', 'sc132gs', '--storage-shift', str(shift),
                '--packing', packing, '--byte-order', order],
                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        paths = set(ROOT.glob('results/*-isp_raw_lab/result.json')) - before
        row = {'packing':packing,'byte_order':order,'storage_shift': shift, 'returncode': proc.returncode, 'status': 'FAIL'}
        if len(paths) == 1:
            path = paths.pop()
            row.update(result=str(path), status=json.loads(path.read_text())['status'])
        else:
            row['reason'] = 'Missing or ambiguous result'
        rows.append(row)
        (out / 'matrix.json').write_text(json.dumps({'trials': rows,
            'scope': 'Synthetic RAW10 to hardware ISP; PASS requires gradient image correctness, not only frame completion.'}, indent=2))
        print(row, flush=True)
    print('RESULT', out / 'matrix.json')
    return 0 if any(row['status'] == 'PASS' for row in rows) else 1

if __name__ == '__main__':
    raise SystemExit(main())
