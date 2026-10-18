"""Zero-neural cleanup controls using the admitted complete generator object."""
from pathlib import Path
import hashlib
import json
import time
import numpy as np

ROOT = Path('/home/sunrise/ainvr')
CODE = ROOT / 'test/model_conversion'
OUT = ROOT / 'test/results/locateanything-request-workspace-cleanup-controls-v273.json'


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    assert not OUT.exists()
    source = CODE / 'compare_locateanything_request_workspace_full_image_v271.py'
    assert sha(source) == 'c96872ab747f4fc456de3f60aaa494dfd76b83d211a713224460de2b76abecf6'
    import compare_locateanything_request_workspace_full_image_v271 as bench
    bench.CANDIDATE_SHA = '5d64ea7d9a7b268e47ccd8f81f18f986a45bd98f43744a642bd1ac31a063032d'
    bench.REGRESSION_SHA = 'c58672150cf02525a1eca050d6ccb41eb83b32e62cf33274cd517355bda7aed8'
    bench.GUARD_SHA = 'cdc02118dc21f3a9bec84d3e18088296d70fe977497da82cd58c189e1d76cd74'
    _, _, original, candidate, changed = bench.admit()
    assert not changed and original.specs == candidate.specs and len(candidate.specs) == 76
    assert len({str(s.path) for s in candidate.specs}) == 46
    import locateanything_request_workspace_generator_v270 as helper
    real_factory = helper.GroupInputWorkspace
    created = []
    def capture():
        obj = real_factory()
        created.append(obj)
        return obj
    checks = []
    try:
        helper.GroupInputWorkspace = capture
        try:
            candidate.generate(mode='unsupported-control')
        except ValueError:
            checks.append('unsupported_mode_no_neural_call')
        else:
            raise AssertionError('Unsupported mode accepted')
        assert len(created) == 4
        assert all(x.closed and all(not np.any(buf) for buf in x.buffers) for x in created)
        assert candidate.active_owner is None and all(g.workspace is None for g in candidate.decoder.groups)
        checks.append('all_four_workspaces_zeroed_closed_and_detached_after_error')
        created.clear()
        def partial_failure():
            if created:
                raise MemoryError('synthetic_workspace_allocation_failure')
            return capture()
        helper.GroupInputWorkspace = partial_failure
        try:
            candidate.generate(mode='unsupported-control')
        except MemoryError:
            checks.append('partial_allocation_failure_propagated')
        else:
            raise AssertionError('Synthetic allocation failure hidden')
        assert len(created) == 1 and created[0].closed
        assert all(not np.any(buf) for buf in created[0].buffers)
        assert candidate.active_owner is None and all(g.workspace is None for g in candidate.decoder.groups)
        checks.append('partial_allocation_cleanup_zeroed_and_detached')
        assert candidate.failed_workspace_requests == 2 and candidate.completed_workspace_requests == 0
        candidate.active_owner = 123
        try:
            candidate.generate(mode='unsupported-control')
        except AssertionError:
            checks.append('reentrant_request_rejected_before_allocation')
        else:
            raise AssertionError('Reentrant request accepted')
        finally:
            candidate.active_owner = None
    finally:
        helper.GroupInputWorkspace = real_factory
    report = dict(status='completed_zero_neural_request_cleanup_controls', created=time.time(),
                  source_sha256=sha(Path(__file__)), benchmark_source_sha256=sha(source),
                  helper_source_sha256=sha(CODE / 'locateanything_request_workspace_generator_v270.py'),
                  checks=checks, logical_specs_unchanged=76, physical_hbm_files_unchanged=46,
                  neural_calls=0, service_operations=0, complete_model_BPU_qualified=False,
                  inference_executor_constructed=False, production_installed=False)
    with OUT.open('x') as f:
        f.write(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
