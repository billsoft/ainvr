"""Validate actual export/compile provenance,including the saved-BC RAM recovery.

The resumed compiler has its OWN source hash. An unchanged graph is proven by
the pinned converted BC plus the exact original export report,not relabelling
the resumed run as the old builder. HBM hash/ports/BPU-only checks stay mandatory
in the consuming package/runtime validators.
"""
from pathlib import Path
import hashlib,json

EXPORT_SHA='dc65fb759764d89a9c026ae05a3171c0931888343cf1dca3124f9439e3f4067d'
RESUME_SHA='5e3c31397ccd4b08f04cb34d47322415f937d53c65ca9f96f7873bdbaf692297'
ORIGINAL_STATUS_SHA='932ed26741dff3ce7e06f791be69552e7e96398457606b9ef0af806e8f419c43'
ORIGINAL_BC_SHA='106e5e0006e45ff88cac9eb9d03519e4696ad6cc151d0c2989fddaee7fe835be'

def verify_compiler_origin(report):
    assert report['status']=='completed' and report['bpu_only'] is True
    source=report['source_sha256']
    if source==EXPORT_SHA:
        assert 'compile_resume' not in report,'Do not impersonate the original producer after resuming'
        return dict(export_source_sha256=EXPORT_SHA,compile_source_sha256=EXPORT_SHA,resumed_from_saved_bc=False)
    assert source==RESUME_SHA and report['export_source_sha256']==EXPORT_SHA
    tool=Path(__file__).parent/'compile_locateanything_compact_saved_bc_v1.py'
    assert hashlib.sha256(tool.read_bytes()).hexdigest()==RESUME_SHA
    resume=report['compile_resume'];raw=resume['original_status_utf8']
    assert isinstance(raw,str) and hashlib.sha256(raw.encode()).hexdigest()==resume['original_status_sha256']==ORIGINAL_STATUS_SHA
    original=json.loads(raw)
    assert original['source_sha256']==EXPORT_SHA and original['status']=='compiling'
    assert (original['start_layer'],original['end_layer'],original['sequence_capacity'])==(0,8,1)
    assert original['converted_bc_sha256']==resume['original_converted_bc_sha256']==report['converted_bc_sha256']==ORIGINAL_BC_SHA
    assert resume['compiler_restarted_from_saved_bc'] is True and resume['recalibration_executed'] is False and resume['graph_or_weight_changes'] is False
    assert report['compile_jobs']==1 and report['optimization']==0 and report['maximum_compile_seconds'] is None
    assert report['serialized_graph_identity_checked'] is True
    changed={'status','source_sha256','started','compile_jobs'}
    for key,value in original.items():
        if key not in changed:assert report[key]==value,'Original export metadata changed: '+key
    return dict(export_source_sha256=EXPORT_SHA,compile_source_sha256=RESUME_SHA,resumed_from_saved_bc=True,
      original_status_sha256=ORIGINAL_STATUS_SHA,converted_bc_sha256=ORIGINAL_BC_SHA)
