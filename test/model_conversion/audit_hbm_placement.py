"""AINVR record compiled HBM precision/placement; reject neural CPU fallback."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--hbm',type=Path,required=True)
p.add_argument('--advice',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args(); assert not a.output.exists()
ops=json.loads(a.advice.read_text()); assert isinstance(ops,list) and ops
backends=Counter(op['backend'] for op in ops)
assert set(backends)<= {'bpu','external_cpu'},backends
cpu=[{k:op[k] for k in ['op_name','op_type','input_types']} for op in ops if op['backend']=='external_cpu']
def result_logic(op):
    if not op['op_name'].startswith('/model.23/'): return False
    if not op['input_types'] or not all(t.startswith('si') for t in op['input_types']): return False
    if op['op_type'] in {'hbir.cast_type','hbir.gather_elements'}: return True
    return op['op_type']=='hbtl.call' and op['op_name'] in {'/model.23/Mod','/model.23/Div_1'}
rejected=[op for op in cpu if not result_logic(op)]
report={'hbm_sha256':hashlib.sha256(a.hbm.read_bytes()).hexdigest(),
        'advice_sha256':hashlib.sha256(a.advice.read_bytes()).hexdigest(),
        'backend_counts':dict(backends),'external_cpu_ops':cpu,
        'bpu_input_types':dict(Counter(t for op in ops if op['backend']=='bpu' for t in op['input_types'])),
        'cpu_neural_fallback_rejected_ops':rejected,'placement_passed':not rejected and backends['bpu']>0,
        'accuracy_verified':False,'production_model':False,
        'note':'Type counts describe lowered operator interfaces, not a percentage of total computation.'}
a.output.write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
if not report['placement_passed']: raise SystemExit(2)
