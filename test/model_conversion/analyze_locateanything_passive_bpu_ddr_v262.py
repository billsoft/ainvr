"""Analyze existing passive data; no neural, service, frequency or driver writes.

This is the private third-group full160 qualification window, not production
10-second cadence, and not a controlled speed or DDR-saturation experiment.
"""
from pathlib import Path
import hashlib
import json
import re
import statistics
import time

ROOT = Path('/home/sunrise/ainvr')
BASE = Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
OUT = BASE / 'passive-ddr-bpu-v258'
REPORT = ROOT / 'test/results/locateanything-passive-ddr-bpu-analysis-v262.json'


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def stats(xs):
    ys = sorted(xs)
    assert ys
    return dict(count=len(ys), minimum=ys[0], median=statistics.median(ys),
                mean=statistics.mean(ys), maximum=ys[-1])


def analyze():
    admission_path = ROOT / 'test/results/locateanything-passive-ddr-bpu-v258.json'
    admission = json.loads(admission_path.read_text())
    assert admission['status'] == 'completed_passive_observation_not_a_speed_or_saturation_claim'
    assert admission['vendor_returncode'] == 0
    assert 40 <= admission['vendor_elapsed_seconds'] <= 55
    assert admission['actual_vendor_tables'] >= 440
    paths = [OUT / n for n in ['task-time.ndjson', 'ratio.ndjson',
                              'hrut-ddr.stdout.log', 'hrut-ddr.stderr.log', 'ports.csv']]
    assert paths[3].read_text() == ''
    task_samples = [json.loads(s) for s in paths[0].read_text().splitlines()]
    ratio = [json.loads(s) for s in paths[1].read_text().splitlines()]
    assert len(task_samples) == admission['task_snapshots'] >= 200
    assert len(ratio) == admission['ratio_snapshots'] >= 60
    seen = {}
    previous = None
    missing_overlap = []
    age_ms = []
    duration_unit_error_us = []
    for i, sample in enumerate(task_samples):
        rows = sample['text'].splitlines()
        assert rows[0].split() == ['index', 'id:hwid', 'type', 'group', 'prio',
                                    's_time', 'e_time', 'r_time']
        current = set()
        for row in rows[1:]:
            cols = row.split()
            assert len(cols) == 8 and re.fullmatch(r'\d+us', cols[7])
            start, end, runtime = int(cols[5]), int(cols[6]), int(cols[7][:-2])
            assert end >= start and runtime >= 0
            current.add(tuple(cols))
            seen[tuple(cols)] = dict(start=start, end=end, runtime_us=runtime)
            duration_unit_error_us.append(abs((end - start) * 1000 - runtime))
        if previous is not None and current and previous and not current.intersection(previous):
            missing_overlap.append(i)
        previous = current
        if current:
            age_ms.append(sample['monotonic'] * 1000 - max(int(r[6]) for r in current))
    # Empirical scale check: endpoints agree with CLOCK_MONOTONIC milliseconds,
    # and deltas quantized to ms agree with explicitly labelled r_time in us.
    # This validates this capture's scale, not undocumented units on all boards.
    assert min(age_ms) >= -2 and max(age_ms) < 10000
    assert max(duration_unit_error_us) < 2100
    lo, hi = task_samples[0]['monotonic'] * 1000, task_samples[-1]['monotonic'] * 1000
    intervals = sorted((max(lo, r['start']), min(hi, r['end']))
                       for r in seen.values() if r['end'] > lo and r['start'] < hi)
    merged = []
    for a, b in intervals:
        if b <= a:
            continue
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(b, merged[-1][1])
        else:
            merged.append([a, b])
    observed_busy_ms = sum(b - a for a, b in merged)
    completed = sorted((r for r in seen.values() if lo <= r['end'] <= hi), key=lambda r: (r['start'], r['end']))
    gaps = [max(0, b['start'] - a['end']) for a, b in zip(completed, completed[1:])]
    runtime_us = [r['runtime_us'] for r in completed]
    values = [int(r['text'].strip()) for r in ratio]
    assert all(0 <= v <= 100 for v in values)
    weights = [b['monotonic'] - a['monotonic'] for a, b in zip(ratio, ratio[1:])]
    assert all(0 < w < 1 for w in weights)
    weighted_ratio = sum(v * w for v, w in zip(values, weights)) / sum(weights)
    # Parse displayed units, not misleading legacy CSV column names.
    raw = paths[2].read_text()
    assert 'Error:' not in raw
    tables = re.findall(r'Elapsed time\[([\d.]+)\] ms(.*?)(?=Elapsed time\[|\Z)', raw, re.S)
    rows = []
    for elapsed, table in tables:
        rd = re.search(r'\bRead\|\s*(\d+)\|\s*(\d+)', table)
        wr = re.search(r'\bWrite\|\s*(\d+)\|\s*(\d+)', table)
        assert rd and wr and 'Perf(MiB/s)' in table
        rows.append((float(elapsed), *map(int, rd.groups()), *map(int, wr.groups())))
    assert len(rows) == admission['actual_vendor_tables']
    elapsed = [0.0] + [r[0] for r in rows]
    dw = [b - a for a, b in zip(elapsed, elapsed[1:])]
    assert all(80 < w < 130 for w in dw)
    means = [sum(r[j] * w for r, w in zip(rows, dw)) / sum(dw) for j in range(1, 5)]
    return dict(status='completed_existing_private_full160_passive_analysis', created=time.time(),
                source_sha256=sha(Path(__file__)), admission_sha256=sha(admission_path),
                input_sha256={p.name: sha(p) for p in paths}, neural_calls=0, service_operations=0,
                scope='Continuous private third-group full160 qualification; native production units paused by its finally-restoring guard; recorder and ingest remained live. Not production 10-second cadence.',
                observed_seconds=(hi - lo) / 1000, ratio=stats(values),
                ratio_time_weighted_percent=weighted_ratio,
                unique_task_rows=len(seen), consecutive_snapshots_without_row_overlap=missing_overlap,
                task_endpoint_empirical_unit='milliseconds against CLOCK_MONOTONIC for this capture',
                endpoint_age_ms=stats(age_ms),
                quantized_duration_error_us_max=max(duration_unit_error_us),
                completed_task_runtime_us=stats(runtime_us), inter_task_gap_ms=stats(gaps),
                observed_task_endpoint_union_busy_percent=100 * observed_busy_ms / (hi - lo),
                task_coverage_note='Deduplicated finite ring rows, clipped to observation window. Endpoint union has millisecond quantization and may miss tasks; not exact MAC utilization, not unique app attribution.',
                ddr_tables=len(rows), ddr_display_units='MiB/s',
                ddr_time_weighted_mean=dict(bpu_read=means[0], all_master_read=means[1], bpu_write=means[2], all_master_write=means[3]),
                ddr_bpu_read=stats([r[1] for r in rows]),
                interpretation='Continuous work shows substantial BPU activity; low cadence averages do not establish idle compute inside a request. DDR rates alone do not establish a bandwidth ceiling or saturation. SDK wait includes task execution and data movement, not proven MAC-only time.',
                saturation_claim=False, single_image_speedup_claim=False,
                recording_and_ingest_identities_preserved=admission['identities_and_configuration_unchanged'],
                invalid_prior_observation='v256 returned zero despite vendor error and zero samples; retained, explicitly rejected in locateanything-ddr-v256-invalid-observation-v258.json')


if __name__ == '__main__':
    result = analyze()
    assert not REPORT.exists()
    with REPORT.open('x') as f:
        f.write(json.dumps(result, indent=2, allow_nan=False) + '\n')
    print(json.dumps(result))
