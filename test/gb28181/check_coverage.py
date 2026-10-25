#!/usr/bin/env python3
"""Fail closed: an inventory is not a claim of full standards conformance."""
import argparse
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--require-complete', action='store_true')
    args = parser.parse_args()
    document = json.loads((ROOT / 'gb28181-service/coverage-2022.json').read_text())
    rows = document['rows']
    allowed = {'reviewed', 'tested', 'excluded', 'pending', 'gap'}
    assert rows and len({r['clause'] for r in rows}) == len(rows)
    for row in rows:
        assert row['status'] in allowed and all(row.get(k) for k in ('clause','scope','requirement','evidence'))
        assert (row['status'] == 'excluded') == (row['scope'] == 'excluded')
    pending = [r['clause'] for r in rows if r['status'] in {'pending', 'gap'}]
    summary = {
        'inventoryRows': len(rows),
        'statuses': dict(Counter(r['status'] for r in rows)),
        'unresolvedClauses': pending,
        'fullTextConformanceComplete': False,
        'reason': 'Grouped inventory is not sentence-level traceability; pending evidence and explicit deviations remain.',
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    # Intentionally cannot certify from counts alone, including if someone changes
    # every row to "tested". A full traceability/review workflow must replace this gate.
    return 1 if args.require_complete else 0

if __name__ == '__main__':
    raise SystemExit(main())
