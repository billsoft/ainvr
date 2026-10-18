"""Reject partial/duplicated full-model metadata before any BPU model load."""
from pathlib import Path
import copy
import hashlib
import json
import os
import time
import hbm_runtime
from locateanything_official_family_contract_v1 import BASE, ROOT, digest, load_official_generator

catalogue = BASE / 'official-family-catalogue-v1.json'
assert digest(catalogue) == '0f77cace89a354544adbd028f2442fcd6bcb327e52650a7a890f929bc68ac239'
original = json.loads(catalogue.read_text())
output = BASE / 'official-full-family-negative-admission-v1'
report_path = ROOT / 'test/results/official-full-family-negative-admission-v1.json'
assert not output.exists() and not report_path.exists()
output.mkdir(mode=0o750)
calls = []
actual_runtime = hbm_runtime.HB_HBMRuntime
def forbid_load(*args, **kwargs):
    calls.append(True)
    raise RuntimeError('Negative metadata admission unexpectedly attempted a neural model load')
cases = {}
cases['partial_catalogue'] = copy.deepcopy(original)
missing = copy.deepcopy(original)
missing['schema'] = 'locateanything_official_full_family_v1'
missing.pop('incomplete_reason')
missing['groups'] = [dict(first=0, last=8), dict(first=18, last=26)]
cases['missing_two_groups'] = missing
duplicate = copy.deepcopy(missing)
duplicate['groups'] = [dict(first=0, last=8), dict(first=9, last=17), dict(first=18, last=26), dict(first=18, last=26)]
cases['duplicated_group_omits_last_nine_layers'] = duplicate
reordered = copy.deepcopy(duplicate)
reordered['groups'] = [dict(first=9, last=17), dict(first=0, last=8), dict(first=18, last=26), dict(first=27, last=35)]
cases['out_of_order_layer_groups'] = reordered
results = []
hbm_runtime.HB_HBMRuntime = forbid_load
try:
    for name, data in cases.items():
        path = output / (name + '.json')
        path.write_text(json.dumps(data, indent=2) + '\n')
        rejected = False
        try:
            load_official_generator(path, digest(path))
        except AssertionError:
            rejected = True
        assert rejected and not calls, name
        results.append(dict(case=name, metadata_path=str(path), metadata_sha256=digest(path),
                            rejected_before_model_load=True))
finally:
    hbm_runtime.HB_HBMRuntime = actual_runtime
report = dict(status='completed', checked=time.time(), source_sha256=digest(Path(__file__)),
              loader_sha256=digest(Path(__file__).parent/'locateanything_official_family_contract_v1.py'),
              cases=results, neural_calls=0, bpu_model_loads=len(calls),
              whole_model_verified=False, release_approved=False)
with report_path.open('x') as stream:
    json.dump(report, stream, indent=2)
    stream.write('\n')
print(json.dumps(dict(status='completed', rejected_cases=len(results), bpu_model_loads=len(calls))))
