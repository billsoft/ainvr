#!/usr/bin/env python3
"""Compare native snapshot geometry with read-only reference golden fixtures."""
import datetime
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test/results' / ('snapshot-plan-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
OUT.mkdir(parents=True)
binary = OUT / 'probe'
subprocess.run(['g++', '-std=c++17', '-O2', '-Wall', '-Wextra', '-I' + str(ROOT / 'ai-service/src'), str(ROOT / 'test/ai_port/snapshot_plan_probe.cpp'), str(ROOT / 'ai-service/src/output/snapshot_plan.cpp'), '-o', str(binary)], check=True, timeout=60)
fixtures = ROOT / 'TecheAI/ai-service/tests/unit'
cases, expected, names = [], [], []
erp = json.loads((fixtures / 'erp_fixtures.json').read_text())
for case in erp['cases']:
    if 'bbox' not in case or 'view' not in case:
        continue
    cases.append(dict(bbox=case['bbox'], width=case.get('erp_w', erp['erp_w']), height=case.get('erp_h', erp['erp_h']), padding_ratio=case['padding_ratio'], max_dimension=case['max_dimension'], mode='erp_equirect', square=case['square']))
    v = case['view']
    expected.append(dict(width=v['w_out'], height=v['h_out'], cx=v['cx'], cy=v['cy'], fov_h_deg=v['fov_h_deg']))
    names.append(case['name'])
crop = json.loads((fixtures / 'snapshot_crop_fixtures.json').read_text())
for case in crop['cases']:
    cases.append(dict(bbox=case['bbox'], width=len(crop['frame'][0]), height=len(crop['frame']), padding_ratio=case['padding_ratio'], max_dimension=case['max_dimension'], mode='none', square=case['keep_square']))
    expected.append(None if case.get('is_none') else dict(width=case['output_shape'][1], height=case['output_shape'][0]))
    names.append(case['name'])
for name, bbox, square, result in [
    ('clip_rect', [-10, -10, 30, 20], False, dict(width=20, height=10, rectangle=[0, 0, 20, 10])),
    ('replicate_square', [-10, -10, 30, 20], True, dict(width=30, height=30, rectangle=[-10, -15, 30, 30], replicate=True)),
    ('outside', [500, 500, 20, 20], False, None),
    ('negative_width', [0, 0, -1, 10], False, None),
    ('round_ties_even', [10, 10, 20.5, 10], True, dict(width=20, height=20, rectangle=[10, 5, 20, 20])),
]:
    cases.append(dict(bbox=bbox, width=300, height=200, padding_ratio=0, max_dimension=320, mode='none', square=square))
    expected.append(result)
    names.append(name)
input_path = OUT / 'input.json'
input_path.write_text(json.dumps(cases))
actual = json.loads(subprocess.check_output([str(binary), str(input_path)], text=True, timeout=10))
assert len(actual) == len(expected)
for name, got, want in zip(names, actual, expected):
    if want is None:
        assert got is None, (name, got)
        continue
    for key, value in want.items():
        if isinstance(value, float):
            assert abs(got[key] - value) < 1e-6, (name, key, got[key], value)
        else:
            assert got[key] == value, (name, key, got[key], value)
invalid = [dict(width=0), dict(height=8193), dict(padding_ratio=-0.1), dict(padding_ratio=1.1), dict(max_dimension=0), dict(mode='unknown')]
for changes in invalid:
    c = dict(cases[0], **changes)
    input_path.write_text(json.dumps([c]))
    run = subprocess.run([str(binary), str(input_path)], capture_output=True, text=True, timeout=10)
    assert run.returncode == 1 and 'Invalid snapshot geometry configuration' in run.stderr, (changes, run)
input_path.write_text(json.dumps(cases))
report = dict(passed=True, cases=names, rejected_configurations=invalid, scope='Geometry only; no rendering, interpolation or JPEG parity claim', actual=actual)
(OUT / 'summary.json').write_text(json.dumps(report, indent=2))
print(json.dumps(dict(passed=True, count=len(names), report=str(OUT / 'summary.json'))))
