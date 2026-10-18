"""AINVR compare separately captured same-BC O0/O2 outputs without loading two HBMs."""
import argparse,hashlib,json
from pathlib import Path
import numpy as np
p=argparse.ArgumentParser(description=__doc__)
for name in ('baseline-capture','optimized-capture','baseline','optimized','output'):
    p.add_argument('--'+name,type=Path,required=True)
p.add_argument('--production-paused',action='store_true')
a=p.parse_args();assert not a.output.exists()
read=lambda path:json.loads(path.read_text())
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
b,o=read(a.baseline/'status.json'),read(a.optimized/'status.json')
assert b['state']==o['state']=='compiled_needs_validation' and b['opt']==0 and o['opt']==2
assert b['bc_sha256']==o['bc_sha256'] and b['target']==o['target']=='nash-m'
assert not b['external_cpu_ops'] and not b['cpu_neural_fallback_rejected_ops']
bm,om=read(a.baseline_capture/'manifest.json'),read(a.optimized_capture/'manifest.json')
assert bm['model_sha256']==b['hbm_sha256']==sha(a.baseline/'detector.hbm')
assert om['model_sha256']==o['hbm_sha256']==sha(a.optimized/'detector.hbm')
assert bm['backend']==om['backend']=='bpu'
assert bm['prepared_manifest_sha256']==om['prepared_manifest_sha256']
assert bm['prompt_slots']==om['prompt_slots']==32 and bm['warmup']==om['warmup']==5
assert len(bm['samples'])==len(om['samples'])==128
left={x['id']:x for x in bm['samples']};right={x['id']:x for x in om['samples']}
assert len(left)==128 and left.keys()==right.keys()
exact=True;maximum=0
for key,x in left.items():
    y=right[key]
    for field in ('image_sha256','prompt_sha256','runtime_prompt_sha256','active_count','class_names','prompt_tensor_source'):
        assert x[field]==y[field]
    assert x['prompt_tensor_source']=='FP32 oracle file'
    with np.load(a.baseline_capture/(key+'.npz')) as f:baseline=f['output']
    with np.load(a.optimized_capture/(key+'.npz')) as f:optimized=f['output']
    assert baseline.shape==optimized.shape==(1,36,8400)
    assert np.isfinite(baseline).all() and np.isfinite(optimized).all()
    exact &= np.array_equal(baseline,optimized)
    maximum=max(maximum,float(np.abs(baseline.astype(np.float64)-optimized.astype(np.float64)).max()))
bf,of=bm['sequential_fps'],om['sequential_fps']
report={'scope':'Detector O0/O2 same128 inputs in separate processes; FP32 prompt tensor inputs for component equivalence only; full dynamic BPU text validation remains separate',
 'samples':128,'bc_sha256':b['bc_sha256'],'baseline_sha256':b['hbm_sha256'],'optimized_sha256':o['hbm_sha256'],
 'outputs_exact':bool(exact),'max_abs_difference':maximum,'baseline_fps':bf,'optimized_fps':of,'speedup':of/bf,
 'production_concurrently_running':not a.production_paused,'separate_process_capture':True,
 'baseline_capture_manifest_sha256':sha(a.baseline_capture/'manifest.json'),'optimized_capture_manifest_sha256':sha(a.optimized_capture/'manifest.json'),
 'optimized_component_verified':bool(exact and of>bf),'full_yoloe_pipeline_approved':False,'calibration_repeated':False,'cpu_neural_fallback':False}
a.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
if not report['optimized_component_verified']:raise SystemExit(2)
