"""Bounded CPU routing controls and timing, not BPU or whole-image acceptance."""
from pathlib import Path
from types import SimpleNamespace
import hashlib
import json
import os
import statistics
import time
import numpy as np
from locateanything_official_group_routing_v1 import prepare_official_group_arrays, OfficialRopeArrays
from locateanything_group_input_workspace_v268 import GroupInputWorkspace, SOURCE, SOURCE_SHA

ROOT = Path('/home/sunrise/ainvr')
BASE = Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
REPORT = ROOT / 'test/results/locateanything-group-input-workspace-controls-v269.json'


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def equal(a, b):
    assert len(a) == len(b) == 22
    for x, y in zip(a, b):
        assert x.dtype == y.dtype and x.shape == y.shape and x.tobytes() == y.tobytes()


def layout(q, p):
    visible = np.tri(q, p + q, k=p, dtype=np.bool_)
    return SimpleNamespace(query_length=q, past_length=p, keep_cache_length=p + q,
                           visibility=visible, positions=np.arange(p, p + q, dtype=np.int64))


def main():
    assert not REPORT.exists() and sha(SOURCE) == SOURCE_SHA
    os.nice(10)
    rng = np.random.default_rng(268)
    rope = OfficialRopeArrays()
    report = dict(status='running_CPU_routing_only', started=time.time(), source_sha256=sha(Path(__file__)),
                  workspace_sha256=sha(ROOT / 'test/model_conversion/locateanything_group_input_workspace_v268.py'),
                  original_routing_sha256=SOURCE_SHA, neural_calls=0, service_operations=0,
                  synthetic_controls=[], real_input_fixtures=[], rejected_controls=[], timings=[],
                  BPU_qualified=False, production_installed=False, single_image_speedup_claim=False)
    w = GroupInputWorkspace()
    try:
        # Deliberate growth, repeated/decreasing past, and both sequence profiles.
        for q, p, length in [(161, 0, 256), (1, 161, 1), (1, 162, 1), (1, 200, 1),
                              (1, 200, 1), (1, 511, 1), (1, 1, 1), (256, 0, 256),
                              (1, 0, 1), (1, 255, 1), (1, 510, 1), (162, 0, 256)]:
            h = rng.normal(size=(q, 2048)).astype(np.float32)
            caches = tuple(tuple(rng.normal(size=(2, p, 128)).astype(np.float32) for _ in range(2))
                           for _ in range(9))
            plan = layout(q, p)
            expected = prepare_official_group_arrays(h, caches, plan, length, rope)
            actual = w.prepare(h, caches, plan, length, rope)
            equal(expected, actual)
            report['synthetic_controls'].append(dict(q=q, p=p, length=length, byte_exact_arrays=22))
        origin = BASE / 'official-qwen-group-18-26-w8a16-ar2-pref0-v2-board-package'
        for case in range(4):
            folder = origin / 's1' / f'case-{case:02d}'
            files = [folder / f'input-{i:02d}.npy' for i in range(22)]
            values = [np.load(p, allow_pickle=False) for p in files]
            mask = values[3]
            assert mask.shape == (1, 512) and set(np.unique(mask)) <= {-512., 0.}
            p = int(np.count_nonzero(mask == 0)) - 1
            assert 0 < p <= 511 and np.all(mask[0, 511-p:] == 0) and np.all(mask[0, :511-p] == -512)
            class FixtureRope:
                def padded(self, positions, length):
                    assert length == 1
                    return values[1][None].copy(), values[2][None].copy()
            caches = tuple((values[4+2*i][:, 512-p:].copy(), values[5+2*i][:, 512-p:].copy()) for i in range(9))
            plan = layout(1, p)
            expected = prepare_official_group_arrays(values[0], caches, plan, 1, FixtureRope())
            actual = w.prepare(values[0], caches, plan, 1, FixtureRope())
            equal(values, expected)
            equal(values, actual)
            report['real_input_fixtures'].append(dict(case=case, p=p, byte_exact_arrays=22,
                                                      input_file_sha256={f.name: sha(f) for f in files}))
        h = np.ones((1, 2048), np.float32)
        caches = tuple((np.ones((2, 161, 128), np.float32), np.ones((2, 161, 128), np.float32)) for _ in range(9))
        plan = layout(1, 161)
        for name in ['nonfinite_hidden', 'nonfinite_cache', 'wrong_cache_shape', 'wrong_mask_dtype', 'borrowed_cache_alias']:
            hh = h.copy()
            cc = tuple(tuple(x.copy() for x in pair) for pair in caches)
            ll = layout(1, 161)
            if name == 'nonfinite_hidden':
                hh[0, 0] = np.nan
            elif name == 'nonfinite_cache':
                cc[3][1][0, 0, 0] = np.inf
            elif name == 'wrong_cache_shape':
                cc = ((cc[0][0][:, :-1], cc[0][1]),) + cc[1:]
            elif name == 'wrong_mask_dtype':
                ll.visibility = ll.visibility.astype(np.float32)
            else:
                cc = ((w.buffers[0][:, -161:], cc[0][1]),) + cc[1:]
            try:
                w.prepare(hh, cc, ll, 1, rope)
            except (AssertionError, ValueError, TypeError):
                report['rejected_controls'].append(name)
            else:
                raise AssertionError('Invalid routing accepted: ' + name)
            equal(prepare_official_group_arrays(h, caches, plan, 1, rope), w.prepare(h, caches, plan, 1, rope))
    finally:
        w.close()
    assert all(not np.any(x) for x in w.buffers)
    try:
        w.prepare(h, caches, plan, 1, rope)
    except AssertionError:
        report['rejected_controls'].append('closed_workspace')
    else:
        raise AssertionError('Closed workspace accepted')
    # Request-like monotonically growing histories. This times routing only;
    # it excludes BPU, SDK input copying, model execution, output routing/media.
    full = tuple(tuple(rng.normal(size=(2, 220, 128)).astype(np.float32) for _ in range(2)) for _ in range(9))
    cases = [(h, tuple(tuple(x[:, :p] for x in pair) for pair in full), layout(1, p)) for p in range(161, 201)]
    for repeat in range(6):
        order = ['baseline', 'workspace'] if repeat % 2 == 0 else ['workspace', 'baseline']
        times = {}
        for mode in order:
            started = time.perf_counter()
            workspace = GroupInputWorkspace() if mode == 'workspace' else None
            try:
                for hh, cc, ll in cases:
                    out = (workspace.prepare(hh, cc, ll, 1, rope) if workspace else
                           prepare_official_group_arrays(hh, cc, ll, 1, rope))
                    assert len(out) == 22
            finally:
                if workspace is not None:
                    workspace.close()
            times[mode] = (time.perf_counter() - started) * 1000
        report['timings'].append(dict(repeat=repeat, warmup=repeat == 0, calls_per_mode=40, order=order,
                                     timing_ms=times, saved_ms_per_group_call=(times['baseline'] - times['workspace']) / 40))
    rows = report['timings'][1:]
    median_saved = statistics.median(x['saved_ms_per_group_call'] for x in rows)
    report.update(status='completed_CPU_routing_controls_not_BPU_admission', finished=time.time(),
                  synthetic_input_arrays_byte_exact=12*22, real_input_arrays_byte_exact=4*22,
                  workspace_buffers_zero_after_close=True, median_saved_ms_per_group_prepare=median_saved,
                  four_group_routing_saving_ms_per_token_estimate=median_saved*4,
                  estimate_scope='CPU routing-only local measurement;not a measured whole-model/token or image speedup',
                  request_workspace_bytes=18*2*512*128*4,
                  follow_up='Only consider full-model equivalence and image A/B if measured routing benefit warrants it.')
    with REPORT.open('x') as f:
        f.write(json.dumps(report, indent=2, allow_nan=False) + '\n')
    print(json.dumps({k: report[k] for k in ['status', 'synthetic_input_arrays_byte_exact', 'real_input_arrays_byte_exact',
                                            'rejected_controls', 'median_saved_ms_per_group_prepare',
                                            'four_group_routing_saving_ms_per_token_estimate', 'neural_calls', 'service_operations']}))


if __name__ == '__main__':
    main()
